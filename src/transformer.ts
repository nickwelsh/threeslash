import { lspText } from './lsp-text.js';
import { randomUUID } from 'node:crypto';
import { splitTokens } from 'shiki/core';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toHast } from 'mdast-util-to-hast';
import { sanitize } from 'hast-util-sanitize';
import type { Element, ElementContent, Text } from 'hast';
import type { CodeToHastOptions, ShikiTransformer, ShikiTransformerContext, ThemedToken } from 'shiki';
import { analyzePhp } from './analyze.js';
import { analysisLimits, checkInput, checkLimit } from './limits.js';
import type { PhpAnalysis, PhpOptions, Range } from './types.js';

interface RenderState {
    analysis: PhpAnalysis;
    id: string;
}

export interface ThreeslashRendererOptions {
    /** Emit Twoslash rich-renderer classes and markup. Load Twoslash's CSS instead of Threeslash's. */
    matchTwoslashStyling?: boolean;
}

export type FumadocsThreeslashOptions = PhpOptions & ThreeslashRendererOptions;

declare module 'hast' {
    interface ElementData {
        threeslashDecoration?: boolean;
    }
}

declare module 'shiki' {
    interface ShikiTransformerContextMeta {
        threeslash?: RenderState;
    }
}

function text(value: string): Text {
    return { type: 'text', value };
}

function element(className: string, children: Array<ElementContent>, properties: Element['properties'] = {}): Element {
    return {
        type: 'element',
        tagName: 'span',
        properties: { ...(className ? { className: className.split(' ') } : {}), ...properties },
        children,
    };
}

function hoverCode(ctx: ShikiTransformerContext, node: Element, matchTwoslashStyling: boolean): Element {
    const code = node.children.find((child): child is Element => child.type === 'element');
    const value = code?.children.map((child) => (child.type === 'text' ? child.value : '')).join('') ?? '';
    if (!Array.isArray(code?.properties.className) || !code.properties.className.includes('language-php')) {
        return element(
            matchTwoslashStyling ? 'twoslash-popup-code' : 'threeslash-signature',
            [text(value.trimEnd())],
            matchTwoslashStyling ? { style: 'white-space: pre-wrap' } : {},
        );
    }
    const signature = value.replace(/^<\?php\s*/u, '').trim();
    const highlighted = ctx.codeToHast(signature, {
        ...ctx.options,
        lang: 'php',
        transformers: [],
        structure: 'classic',
    });
    const pre = highlighted.children.find(
        (child): child is Element => child.type === 'element' && child.tagName === 'pre',
    );
    const highlightedCode = pre?.children.find(
        (child): child is Element => child.type === 'element' && child.tagName === 'code',
    );
    for (const child of highlightedCode?.children ?? []) {
        if (child.type === 'element') {
            delete child.properties['class'];
            child.properties.className = matchTwoslashStyling ? [] : ['threeslash-signature-line'];
            if (matchTwoslashStyling) {
                child.properties.style = `${child.properties.style ?? ''}; display: block; white-space: pre-wrap`;
            }
        }
    }
    return element(
        matchTwoslashStyling ? 'twoslash-popup-code' : 'threeslash-signature',
        highlightedCode?.children ?? [text(signature)],
    );
}

/** Render sanitized Markdown using phrasing content, since popups live inside code spans. */
function hoverContents(
    ctx: ShikiTransformerContext,
    contents: string,
    matchTwoslashStyling: boolean,
): Array<ElementContent> {
    const root = sanitize(
        toHast(fromMarkdown(contents), {
            // Treat embedded HTML as literal documentation, never executable markup.
            handlers: { html: (_state, node: { value: string }) => text(node.value) },
        }),
    );

    function block(
        className: string,
        children: Array<ElementContent>,
        properties: Element['properties'] = {},
        style = 'display: block; white-space: normal',
    ): Element {
        if (matchTwoslashStyling) {
            return element('', children, {
                ...properties,
                style: [properties.style, style].filter(Boolean).join('; '),
            });
        }
        return element(className, children, properties);
    }

    function render(node: ElementContent): ElementContent {
        if (node.type !== 'element') {
            return node;
        }
        if (node.tagName === 'img') {
            return text(node.properties.alt ?? '');
        }
        if (node.tagName === 'pre') {
            return hoverCode(ctx, node, matchTwoslashStyling);
        }
        const children = node.children.map(render);
        switch (node.tagName) {
            case 'p': {
                return block('threeslash-docs', children);
            }
            case 'ul':
            case 'ol': {
                return block(
                    `threeslash-list threeslash-${node.tagName}`,
                    children,
                    {
                        role: 'list',
                        style: `counter-reset: list-item ${Number(node.properties.start ?? 1) - 1}`,
                    },
                    `display: block; white-space: normal; padding-left: 1.5em; list-style-type: ${node.tagName === 'ol' ? 'decimal' : 'disc'}`,
                );
            }
            case 'li': {
                return block('threeslash-list-item', children, { role: 'listitem' }, 'display: list-item');
            }
            case 'blockquote': {
                return block(
                    'threeslash-quote',
                    children,
                    {},
                    'display: block; white-space: normal; padding-left: 0.75em; border-left: 2px solid var(--twoslash-border-color)',
                );
            }
            case 'hr': {
                return block(
                    'threeslash-rule',
                    [],
                    { role: 'separator' },
                    'display: block; border-top: 1px solid var(--twoslash-border-color)',
                );
            }
            case 'h1':
            case 'h2':
            case 'h3':
            case 'h4':
            case 'h5':
            case 'h6': {
                return block(
                    'threeslash-heading',
                    children,
                    { role: 'heading', ariaLevel: Number(node.tagName[1]) },
                    'display: block; white-space: normal; font-weight: 600',
                );
            }
            default: {
                return { ...node, children };
            }
        }
    }

    const children =
        root.type === 'root'
            ? root.children.flatMap((node) => (node.type === 'element' || node.type === 'text' ? [render(node)] : []))
            : [];
    if (!matchTwoslashStyling) {
        return children;
    }
    // Twoslash styles signatures and prose as separate sections. Keep block
    // layout on spans so documentation remains valid inside highlighted code.
    const sections: Array<ElementContent> = [];
    let docs: Element | undefined;
    for (const child of children) {
        if (child.type === 'text' && !child.value.trim()) {
            continue;
        }
        if (
            child.type === 'element' &&
            Array.isArray(child.properties.className) &&
            child.properties.className.includes('twoslash-popup-code')
        ) {
            sections.push(child);
            docs = undefined;
        } else {
            if (!docs) {
                docs = element('twoslash-popup-docs', []);
                sections.push(docs);
            }
            docs.children.push(child);
        }
    }
    return sections;
}

function covers(range: Range, line: number, column: number, length: number): boolean {
    return (
        line >= range.start.line &&
        line <= range.end.line &&
        (line !== range.start.line || column >= range.start.character) &&
        (line !== range.end.line || column + length <= range.end.character)
    );
}

function offset(code: string, line: number, character: number): number {
    let result = 0;
    for (const row of code.split('\n').slice(0, line)) {
        result += row.length + 1;
    }
    return result + character;
}

function diagnosticClass(isError: boolean, matchTwoslashStyling: boolean, annotation = false): string {
    if (matchTwoslashStyling) {
        const base = annotation ? 'twoslash-meta-line twoslash-error-line' : 'twoslash-error';
        return `${base}${isError ? '' : ' twoslash-error-level-warning'}`;
    }
    if (annotation) {
        return `threeslash-diagnostic ${isError ? 'threeslash-error-message' : 'threeslash-warning-message'}`;
    }
    return isError ? 'threeslash-error' : 'threeslash-warning';
}

function queryAnnotation(ctx: ShikiTransformerContext, contents: string, matchTwoslashStyling: boolean): Element {
    const children = hoverContents(ctx, contents, matchTwoslashStyling);
    return element(
        matchTwoslashStyling ? 'twoslash-meta-line twoslash-query-line' : 'threeslash-query',
        matchTwoslashStyling
            ? [element('twoslash-popup-container', [element('twoslash-popup-arrow', []), ...children])]
            : children,
        { 'data-threeslash-annotation': 'query', ...(matchTwoslashStyling ? { style: 'display: block' } : {}) },
    );
}

function renderingHooks({ matchTwoslashStyling = false }: ThreeslashRendererOptions): ShikiTransformer {
    return {
        name: 'threeslash',
        tokens(tokens) {
            const state = this.meta.threeslash;
            if (!state) {
                return tokens;
            }
            const { analysis } = state;
            const boundaries = new Set<number>();
            for (const { range } of [...analysis.hovers, ...analysis.diagnostics]) {
                boundaries.add(offset(analysis.code, range.start.line, range.start.character));
                boundaries.add(offset(analysis.code, range.end.line, range.end.character));
            }
            return splitTokens(tokens, boundaries);
        },
        pre(node) {
            if (this.meta.threeslash) {
                this.addClassToHast(node, matchTwoslashStyling ? 'twoslash' : 'threeslash');
                node.properties['data-threeslash-code'] = this.meta.threeslash.analysis.code;
            }
        },
        span(node, line, col, _lineElement, token: ThemedToken) {
            const state = this.meta.threeslash;
            if (!state) {
                return;
            }
            const lineIndex = line - 1;
            const column = col; // Shiki columns are zero-based UTF-16 offsets.
            const diagnostics = state.analysis.diagnostics.filter(({ range }) =>
                covers(range, lineIndex, column, token.content.length),
            );
            if (diagnostics.length > 0) {
                this.addClassToHast(
                    node,
                    diagnosticClass(
                        diagnostics.some((diagnostic) => diagnostic.severity === 1),
                        matchTwoslashStyling,
                    ),
                );
            }
        },
        line(node, line) {
            const state = this.meta.threeslash;
            if (!state) {
                return;
            }
            // Wrap whole semantic ranges after Shiki splits syntax tokens. A PHP
            // variable's "$" and name often have separate colors but one hover.
            const hovers = state.analysis.hovers.filter(
                ({ range }) => range.start.line === line - 1 && range.end.line === line - 1,
            );
            for (const [index, hover] of hovers.entries()) {
                const start = hover.range.start.character;
                const end = hover.range.end.character;
                let column = 0;
                const children: Array<ElementContent> = [];
                const selected: Array<ElementContent> = [];
                let insertion = -1;
                for (const child of node.children) {
                    const length = sourceLength(child);
                    if (column >= start && column + length <= end && length > 0) {
                        if (insertion === -1) {
                            insertion = children.length;
                        }
                        selected.push(child);
                    } else {
                        children.push(child);
                    }
                    column += length;
                }
                if (insertion === -1) {
                    continue;
                }
                const id = `${state.id}-${line}-${index}`;
                const popup = element(
                    matchTwoslashStyling ? 'twoslash-popup-container' : 'threeslash-popup',
                    hoverContents(this, hover.contents, matchTwoslashStyling),
                    {
                        id,
                        role: 'dialog',
                        ariaLabel: 'PHP documentation',
                    },
                );
                popup.data = { threeslashDecoration: true };
                const trigger = element(
                    matchTwoslashStyling ? 'twoslash-hover' : 'threeslash-hover',
                    [...selected, popup],
                    {
                        tabIndex: 0,
                        ariaDescribedBy: [id],
                        ariaHasPopup: 'dialog',
                    },
                );
                children.splice(insertion, 0, trigger);
                node.children = children;
            }
            for (const query of state.analysis.queries.filter((candidate) => candidate.position.line === line - 1)) {
                const annotation = queryAnnotation(this, query.contents, matchTwoslashStyling);
                annotation.data = { threeslashDecoration: true };
                node.children.push(annotation);
            }
            for (const diagnostic of state.analysis.diagnostics.filter(
                (candidate) => candidate.range.start.line === line - 1,
            )) {
                const annotation = element(
                    diagnosticClass(diagnostic.severity === 1, matchTwoslashStyling, true),
                    [text(`${lspText(diagnostic.message)} [${diagnostic.code ?? diagnostic.source ?? 'PHP'}]`)],
                    {
                        'data-threeslash-annotation': 'diagnostic',
                        ...(matchTwoslashStyling ? { style: 'display: block' } : {}),
                    },
                );
                annotation.data = { threeslashDecoration: true };
                node.children.push(annotation);
            }
        },
    };
}

function sourceLength(node: ElementContent): number {
    if (node.type === 'text') {
        return node.value.length;
    }
    if (node.type !== 'element' || node.data?.threeslashDecoration === true) {
        return 0;
    }
    return node.children.reduce((length, child) => length + sourceLength(child), 0);
}

/** For plain Shiki: analyze first, then highlight analysis.code with this transformer. */
export function transformerThreeslash(
    analysis: PhpAnalysis,
    options: ThreeslashRendererOptions = {},
): ShikiTransformer {
    return {
        ...renderingHooks(options),
        preprocess(code) {
            if (code !== analysis.code) {
                throw new Error('Threeslash: highlight analysis.code with the matching analysis result.');
            }
            this.meta.threeslash = { analysis, id: `threeslash-${randomUUID()}` };
        },
    };
}

export interface FumadocsThreeslashTransformer extends ShikiTransformer {
    _fd_prepare: (code: string, options: CodeToHastOptions) => Promise<void>;
}

/** Async preparation for Fumadocs' rehypeCode pipeline. Only `php threeslash` fences opt in. */
export function transformerThreeslashFumadocs(options: FumadocsThreeslashOptions = {}): FumadocsThreeslashTransformer {
    const prepared = new WeakMap<object, { code: string; analysis: PhpAnalysis }>();
    let pending: Promise<unknown> = Promise.resolve();
    let pendingSnippets = 0;
    return {
        ...renderingHooks(options),
        async _fd_prepare(code, codeOptions) {
            if (codeOptions.lang !== 'php' || !/(?:^|\s)threeslash(?:\s|$)/u.test(codeOptions.meta?.__raw ?? '')) {
                return;
            }
            // Check before closures retain input in the serialized preparation queue.
            checkInput(code);
            checkLimit('pending snippets', pendingSnippets + 1, analysisLimits.pendingSnippets);
            codeOptions.meta ??= {};
            const { meta } = codeOptions;
            // Fumadocs prepares blocks concurrently. Serialize processes per transformer
            // so a page containing many snippets cannot exhaust memory.
            pendingSnippets += 1;
            const task = pending
                .then(async () => analyzePhp(code, options))
                .finally(() => {
                    pendingSnippets -= 1;
                });
            pending = task.catch(() => {
                /* Let later snippets run after an earlier failure. */
            });
            prepared.set(meta, { code, analysis: await task });
        },
        preprocess(code, codeOptions) {
            const result = codeOptions.meta && prepared.get(codeOptions.meta);
            if (!result) {
                if (codeOptions.lang === 'php' && /(?:^|\s)threeslash(?:\s|$)/u.test(codeOptions.meta?.__raw ?? '')) {
                    throw new Error(
                        'Threeslash: async preparation did not run. Use Fumadocs rehypeCode, or analyzePhp with transformerThreeslash for plain Shiki.',
                    );
                }
                return code;
            }
            if (result.code !== code) {
                throw new Error(
                    'Threeslash: PHP code changed after async preparation. Run Threeslash before source-changing transformers.',
                );
            }
            const { analysis } = result;
            this.meta.threeslash = { analysis, id: `threeslash-${randomUUID()}` };
            return analysis.code;
        },
    };
}
