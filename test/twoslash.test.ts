import { afterAll, expect, test } from 'vitest';
import { createHighlighter } from 'shiki';
import type { ShikiTransformer } from 'shiki';
import { createTransformerFactory, rendererRich } from '@shikijs/twoslash/core';
import { transformerTwoslash } from 'fumadocs-twoslash';
import type { TransformerTwoslashOptions } from 'fumadocs-twoslash';
import type { Element, Root, RootContent } from 'hast';
import { transformerThreeslash } from '../src/transformer.js';
import { rendererTwoslashFumadocs } from '../src/renderer-twoslash.js';
import type { PhpAnalysis } from '../src/types.js';

const highlighter = await createHighlighter({ langs: ['php'], themes: ['github-light', 'github-dark'] });

afterAll(() => highlighter.dispose());

function descendants(node: Root | RootContent): Array<Element> {
    return 'children' in node
        ? node.children.flatMap((child) => [...(child.type === 'element' ? [child] : []), ...descendants(child)])
        : [];
}
function hasClass(node: Element, name: string) {
    const value = node.properties['class'] ?? node.properties.className;
    return typeof value === 'string' ? value.split(' ').includes(name) : Array.isArray(value) && value.includes(name);
}
function prepared(renderer: ShikiTransformer, analysis: PhpAnalysis): ShikiTransformer {
    return {
        ...renderer,
        preprocess(code, options) {
            this.meta.threeslash = { analysis, id: 'example' };
            return renderer.preprocess?.call(this, code, options);
        },
    };
}

const analysis: PhpAnalysis = {
    code: '$value = 1;\necho $value;',
    hovers: [
        {
            range: { start: { line: 1, character: 5 }, end: { line: 1, character: 11 } },
            contents: '```php\n<?php\n$value = 1;\n```',
        },
    ],
    queries: [
        {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
            position: { line: 0, character: 0 },
            contents: '```php\n<?php\n$value = 1;\n```',
        },
    ],
    diagnostics: [
        {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
            severity: 2,
            message: 'Warning',
            code: 'example',
        },
    ],
};
const nativeResult: ReturnType<NonNullable<TransformerTwoslashOptions['twoslasher']>> = {
    code: analysis.code,
    nodes: [
        { type: 'hover', start: 17, length: 6, line: 1, character: 5, target: '$value', text: '$value = 1;' },
        { type: 'query', start: 0, length: 6, line: 0, character: 0, target: '$value', text: '$value = 1;' },
        {
            type: 'error',
            start: 12,
            length: 4,
            line: 1,
            character: 0,
            filename: 'snippet.php',
            code: 0,
            level: 'warning',
            text: 'Warning [example]',
        },
    ],
};

test.each(['shiki', 'fumadocs'])(
    'uses the native %s renderer with matching markup and classes',
    async (integration) => {
        const own =
            integration === 'shiki'
                ? transformerThreeslash(analysis)
                : prepared(await rendererTwoslashFumadocs(), analysis);
        const native =
            integration === 'shiki'
                ? createTransformerFactory(
                      () => nativeResult,
                      rendererRich({
                          processHoverInfo: (info) => info,
                          queryRendering: 'line',
                          hast: {
                              hoverToken: { properties: { tabIndex: 0, ariaHasPopup: 'dialog' } },
                              hoverPopup: { properties: { role: 'dialog', ariaLabel: 'PHP documentation' } },
                          },
                      }),
                  )({ langs: ['php'], explicitTrigger: false })
                : transformerTwoslash({
                      filter: () => true,
                      twoslasher: () => nativeResult,
                      rendererRich: { processHoverInfo: (info) => info },
                  });
        const options = { lang: 'php', themes: { light: 'github-light', dark: 'github-dark' } };
        const actual = highlighter.codeToHast(analysis.code, { ...options, transformers: [own] });
        const expected = highlighter.codeToHast(analysis.code, { ...options, transformers: [native] });
        const pre = actual.children.find((node) => node.type === 'element' && node.tagName === 'pre');
        expect(pre?.type === 'element' && pre.properties['data-threeslash-code']).toBe(analysis.code);
        if (pre?.type === 'element') {
            delete pre.properties['data-threeslash-code'];
        }
        expect(actual).toStrictEqual(expected);
    },
);

test.each(['shiki', 'fumadocs'])(
    'keeps multiline PHP signatures highlighted and docs safe with native %s rendering',
    async (integration) => {
        const result: PhpAnalysis = {
            ...analysis,
            queries: [],
            diagnostics: [],
            hovers: analysis.hovers.map(({ range }) => ({
                range,
                contents:
                    '```php\n<?php\nclass User {\n    public function __construct(string $name);\n}\n```\n\n**Docs** [PHP manual](https://php.net) [unsafe](javascript:alert%281%29)\n\n<script>alert(1)</script>\n\n![image description](https://example.com/picture.png)',
            })),
        };
        const renderer =
            integration === 'shiki'
                ? transformerThreeslash(result)
                : prepared(await rendererTwoslashFumadocs(), result);
        const tree = highlighter.codeToHast(result.code, {
            lang: 'php',
            themes: { light: 'github-light', dark: 'github-dark' },
            transformers: [renderer],
        });
        const nodes = descendants(tree);
        expect(nodes.some((node) => hasClass(node, 'twoslash'))).toBe(true);
        expect(nodes.some((node) => ['script', 'img'].includes(node.tagName))).toBe(false);
        expect(nodes.filter((node) => node.tagName === 'a').map((node) => node.properties.href)).toStrictEqual([
            'https://php.net',
        ]);
        const docs = nodes.find((node) => hasClass(node, 'twoslash-popup-docs'));
        expect(JSON.stringify(docs)).toContain('image description');
        expect(JSON.stringify(docs)).toContain('<script>alert(1)</script>');
        expect(nodes.some((node) => hasClass(node, 'threeslash-signature'))).toBe(false);
        expect(nodes.filter((node) => hasClass(node, 'line')).length).toBeGreaterThan(3);
        expect(nodes.some((node) => String(node.properties.style).includes('--shiki-dark'))).toBe(true);
    },
);
