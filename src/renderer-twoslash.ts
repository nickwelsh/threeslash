import { createTransformerFactory, rendererRich } from '@shikijs/twoslash/core';
import type { ShikiTransformer, ShikiTransformerContextCommon, ShikiTransformerContextMeta } from 'shiki';
import type { TransformerTwoslashOptions } from 'fumadocs-twoslash';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toHast } from 'mdast-util-to-hast';
import { defaultHandlers, toMdast } from 'hast-util-to-mdast';
import { toMarkdown } from 'mdast-util-to-markdown';
import { sanitize } from 'hast-util-sanitize';
import type { PhpAnalysis, Range } from './types.js';
import { lspText } from './lsp-text.js';

type TwoslashResult = ReturnType<NonNullable<TransformerTwoslashOptions['twoslasher']>>;

/** Separate PHPantom's signature from prose while retaining the Markdown safety boundary. */
function hoverInfo(contents: string, target: string) {
    const root = fromMarkdown(contents);
    const signature = root.children.filter((node) => node.type === 'code').find((node) => node.lang === 'php');
    if (
        !signature &&
        root.children.length === 1 &&
        root.children[0]?.type === 'paragraph' &&
        root.children[0].children.every((node) => node.type === 'text')
    ) {
        return { text: contents.trim() };
    }
    root.children = root.children.filter((node) => node !== signature);
    const html = toHast(root, {
        handlers: {
            html: (_state, node: { value: string }) => ({ type: 'text', value: node.value }),
            image: (_state, node: { alt?: string | null }) => ({ type: 'text', value: node.alt ?? '' }),
        },
    });
    const safeDocs = toMdast(sanitize(html), {
        handlers: {
            a(state, node) {
                // Sanitization removes unsafe hrefs. Keep their labels as prose
                // instead of turning them back into empty navigation links.
                return node.properties.href === undefined ? state.all(node) : defaultHandlers.a(state, node);
            },
        },
    });
    const docs = toMarkdown(safeDocs).trim();
    return { text: signature?.value.replace(/^<\?php\s*/u, '').trim() ?? target, ...(docs ? { docs } : {}) };
}

function twoslashResult(analysis: PhpAnalysis): TwoslashResult {
    const starts: Array<number> = [];
    let index = 0;
    for (const line of analysis.code.split('\n')) {
        starts.push(index);
        index += line.length + 1;
    }
    function position(range: Range) {
        const start = (starts[range.start.line] ?? analysis.code.length) + range.start.character;
        const end = (starts[range.end.line] ?? analysis.code.length) + range.end.character;
        return { start, length: end - start, line: range.start.line, character: range.start.character };
    }
    const nodes: TwoslashResult['nodes'] = [];
    for (const hover of analysis.hovers) {
        const coordinates = position(hover.range);
        const target = analysis.code.slice(coordinates.start, coordinates.start + coordinates.length);
        nodes.push({ type: 'hover', ...coordinates, target, ...hoverInfo(hover.contents, target) });
    }
    for (const query of analysis.queries) {
        const coordinates = position(query.range);
        const target = analysis.code.slice(coordinates.start, coordinates.start + coordinates.length);
        nodes.push({ type: 'query', ...coordinates, target, ...hoverInfo(query.contents, target) });
    }
    for (const diagnostic of analysis.diagnostics) {
        nodes.push({
            type: 'error',
            ...position(diagnostic.range),
            level: diagnostic.severity === 1 ? 'error' : 'warning',
            code: typeof diagnostic.code === 'number' ? diagnostic.code : 0,
            filename: 'snippet.php',
            text: `${lspText(diagnostic.message)} [${diagnostic.code ?? diagnostic.source ?? 'PHP'}]`,
        });
    }
    return { code: analysis.code, nodes };
}

function sourceAware(renderer: ShikiTransformer): ShikiTransformer {
    return {
        ...renderer,
        pre(node) {
            renderer.pre?.call(this, node);
            if (this.meta.threeslash) {
                node.properties['data-threeslash-code'] = this.meta.threeslash.analysis.code;
            }
        },
    };
}

/** Reuse Shiki's rich renderer for framework-free HTML. */
export function rendererTwoslash(analysis: PhpAnalysis): ShikiTransformer {
    const renderer = rendererRich({
        processHoverInfo: (info) => info,
        queryRendering: 'line',
        hast: {
            hoverToken: { properties: { tabIndex: 0, ariaHasPopup: 'dialog' } },
            hoverPopup: { properties: { role: 'dialog', ariaLabel: 'PHP documentation' } },
        },
        renderMarkdown(markdown) {
            const root = sanitize(toHast(fromMarkdown(markdown)));
            return root.type === 'root'
                ? root.children.flatMap((node) => (node.type === 'element' || node.type === 'text' ? [node] : []))
                : [];
        },
    });
    return sourceAware(
        createTransformerFactory(() => twoslashResult(analysis), renderer)({ langs: ['php'], explicitTrigger: false }),
    );
}

/** Fumadocs emits the same Popup/PopupContent/PopupTrigger MDX components as Twoslash. */
export async function rendererTwoslashFumadocs(): Promise<ShikiTransformer> {
    const { transformerTwoslash } = await import('fumadocs-twoslash');
    const results = new WeakMap<ShikiTransformerContextMeta, TwoslashResult>();
    const renderer = sourceAware(
        transformerTwoslash({
            filter: (_lang, _code, _options, context?: ShikiTransformerContextCommon) =>
                context?.meta.threeslash !== undefined,
            rendererRich: { processHoverInfo: (info) => info },
            twoslasher(_code, _lang, _options, meta) {
                const result = meta && results.get(meta);
                if (!result) {
                    throw new Error('Threeslash: missing prepared PHP analysis.');
                }
                return result;
            },
        }),
    );
    function withPhpResult<T>(ctx: ShikiTransformerContextCommon, render: () => T): T | undefined {
        const result = results.get(ctx.meta);
        if (!result) {
            return undefined;
        }
        // Fumadocs' renderer reads shared metadata in every hook. Expose PHP
        // only during its own calls so the TypeScript transformer cannot render
        // the same block a second time. Restore metadata even after failures.
        const previous: unknown = Reflect.get(ctx.meta, 'twoslash');
        Reflect.set(ctx.meta, 'twoslash', result);
        try {
            return render();
        } finally {
            if (previous === undefined) {
                Reflect.deleteProperty(ctx.meta, 'twoslash');
            } else {
                Reflect.set(ctx.meta, 'twoslash', previous);
            }
        }
    }
    return {
        ...renderer,
        preprocess(code, options) {
            if (!this.meta.threeslash) {
                return code;
            }
            results.set(this.meta, twoslashResult(this.meta.threeslash.analysis));
            return withPhpResult(this, () => renderer.preprocess?.call(this, code, options));
        },
        tokens(tokens) {
            return withPhpResult(this, () => renderer.tokens?.call(this, tokens));
        },
        code(node) {
            return withPhpResult(this, () => renderer.code?.call(this, node));
        },
        pre(node) {
            return withPhpResult(this, () => renderer.pre?.call(this, node));
        },
    };
}
