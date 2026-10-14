import { lspText } from './lsp-text.js';
import { splitTokens } from 'shiki/core';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toHast } from 'mdast-util-to-hast';
import { sanitize } from 'hast-util-sanitize';
import type { Element, ElementContent, Text } from 'hast';
import type { ShikiTransformer, ShikiTransformerContext, ThemedToken } from 'shiki';
import type { PhpAnalysis, Range } from './types.js';

interface RenderState {
    analysis: PhpAnalysis;
    id: string;
}

declare module 'hast' {
    interface ElementData {
        threeslashDecoration?: boolean;
    }
}

declare module '@shikijs/types' {
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
        properties: { className: className.split(' '), ...properties },
        children,
    };
}

function hoverCode(ctx: ShikiTransformerContext, node: Element): Element {
    const code = node.children.find((child): child is Element => child.type === 'element');
    const value = code?.children.map((child) => (child.type === 'text' ? child.value : '')).join('') ?? '';
    if (!Array.isArray(code?.properties.className) || !code.properties.className.includes('language-php')) {
        return element('threeslash-signature', [text(value.trimEnd())]);
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
            child.properties.className = ['threeslash-signature-line'];
        }
    }
    return element('threeslash-signature', highlightedCode?.children ?? [text(signature)]);
}

/** Render sanitized Markdown using phrasing content, since popups live inside code spans. */
function hoverContents(ctx: ShikiTransformerContext, contents: string): Array<ElementContent> {
    const root = sanitize(
        toHast(fromMarkdown(contents), {
            // Treat embedded HTML as literal documentation, never executable markup.
            handlers: { html: (_state, node: { value: string }) => text(node.value) },
        }),
    );

    function render(node: ElementContent): ElementContent {
        if (node.type !== 'element') {
            return node;
        }
        if (node.tagName === 'img') {
            return text(node.properties.alt ?? '');
        }
        if (node.tagName === 'pre') {
            return hoverCode(ctx, node);
        }
        const children = node.children.map(render);
        switch (node.tagName) {
            case 'p': {
                return element('threeslash-docs', children);
            }
            case 'ul':
            case 'ol': {
                return element(`threeslash-list threeslash-${node.tagName}`, children, {
                    role: 'list',
                    style: `counter-reset: list-item ${Number(node.properties.start ?? 1) - 1}`,
                });
            }
            case 'li': {
                return element('threeslash-list-item', children, { role: 'listitem' });
            }
            case 'blockquote': {
                return element('threeslash-quote', children);
            }
            case 'hr': {
                return element('threeslash-rule', [], { role: 'separator' });
            }
            case 'h1':
            case 'h2':
            case 'h3':
            case 'h4':
            case 'h5':
            case 'h6': {
                return element('threeslash-heading', children, { role: 'heading', ariaLevel: Number(node.tagName[1]) });
            }
            default: {
                return { ...node, children };
            }
        }
    }

    return root.type === 'root'
        ? root.children.flatMap((node) => (node.type === 'element' || node.type === 'text' ? [render(node)] : []))
        : [];
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

export function rendererThreeslash(): ShikiTransformer {
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
                this.addClassToHast(node, 'threeslash');
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
                    diagnostics.some((diagnostic) => diagnostic.severity === 1)
                        ? 'threeslash-error'
                        : 'threeslash-warning',
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
                const popup = element('threeslash-popup', hoverContents(this, hover.contents), {
                    id,
                    role: 'dialog',
                    ariaLabel: 'PHP documentation',
                });
                popup.data = { threeslashDecoration: true };
                const trigger = element('threeslash-hover', [...selected, popup], {
                    tabIndex: 0,
                    ariaDescribedBy: [id],
                    ariaHasPopup: 'dialog',
                });
                children.splice(insertion, 0, trigger);
                node.children = children;
            }
            for (const query of state.analysis.queries.filter((candidate) => candidate.position.line === line - 1)) {
                const annotation = element('threeslash-query', hoverContents(this, query.contents), {
                    'data-threeslash-annotation': 'query',
                });
                annotation.data = { threeslashDecoration: true };
                node.children.push(annotation);
            }
            for (const diagnostic of state.analysis.diagnostics.filter(
                (candidate) => candidate.range.start.line === line - 1,
            )) {
                const annotation = element(
                    `threeslash-diagnostic ${diagnostic.severity === 1 ? 'threeslash-error-message' : 'threeslash-warning-message'}`,
                    [text(`${lspText(diagnostic.message)} [${diagnostic.code ?? diagnostic.source ?? 'PHP'}]`)],
                    { 'data-threeslash-annotation': 'diagnostic' },
                );
                annotation.data = { threeslashDecoration: true };
                node.children.push(annotation);
            }
        },
        code(node) {
            if (!this.meta.threeslash) {
                return;
            }
            let annotated = false;
            node.children = node.children.flatMap<ElementContent>((child) => {
                // The newline before the annotations replaces the source-line
                // separator after them, avoiding an extra row in flex layouts.
                if (annotated && child.type === 'text' && child.value === '\n') {
                    annotated = false;
                    return [];
                }
                annotated = false;
                if (child.type !== 'element') {
                    return [child];
                }
                const annotations: Array<Element> = [];
                child.children = child.children.filter((candidate) => {
                    if (
                        candidate.type === 'element' &&
                        Object.hasOwn(candidate.properties, 'data-threeslash-annotation')
                    ) {
                        annotations.push(candidate);
                        return false;
                    }
                    return true;
                });
                if (annotations.length === 0) {
                    return [child];
                }
                annotated = true;
                return [child, text('\n'), ...annotations];
            });
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
