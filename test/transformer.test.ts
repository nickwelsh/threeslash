import { afterAll, expect, test } from 'vitest';
import { createHighlighter } from 'shiki';
import { parseFragment } from 'parse5';
import type { Element, Root, RootContent } from 'hast';
import { transformerThreeslash, transformerThreeslashFumadocs } from '../src/transformer.js';
import type { PhpAnalysis } from '../src/types.js';
import { elements } from './helpers/html.js';
import { analysisLimits } from '../src/limits.js';

const highlighter = await createHighlighter({ langs: ['php'], themes: ['github-light', 'github-dark'] });

afterAll(() => highlighter.dispose());

function descendants(node: Root | RootContent): Array<Element> {
    if (!('children' in node)) {
        return [];
    }
    return node.children.flatMap((child) => [...(child.type === 'element' ? [child] : []), ...descendants(child)]);
}

function content(node: Root | RootContent): string {
    if (node.type === 'text') {
        return node.value;
    }
    return 'children' in node ? node.children.map((child) => content(child)).join('') : '';
}

function hasClass(node: Element, name: string): boolean {
    const classes = node.properties.className ?? node.properties['class'];
    return Array.isArray(classes)
        ? classes.includes(name)
        : typeof classes === 'string' && classes.split(' ').includes(name);
}

function triggerSource(trigger: Element): string {
    return trigger.children
        .filter((child) => child.type === 'element' && !hasClass(child, 'threeslash-popup'))
        .map((child) => content(child))
        .join('');
}

function findClass(nodes: Array<Element>, name: string): Element {
    const node = nodes.find((candidate) => hasClass(candidate, name));
    if (!node) {
        throw new Error(`Missing ${name}`);
    }
    return node;
}

function codeStructure(code: Element | undefined) {
    return code?.children.map((child) => {
        if (child.type === 'text') {
            return child.value;
        }
        if (child.type === 'element') {
            return child.properties['data-threeslash-annotation'] ?? 'source';
        }
        return child.type;
    });
}

const analysis: PhpAnalysis = {
    code: '$greeting = "hello"; echo $greeting;',
    hovers: [
        {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } },
            contents: '```php\n<?php\n$greeting = "hello"\n```',
        },
        {
            range: { start: { line: 0, character: 26 }, end: { line: 0, character: 35 } },
            contents: '<script>alert("unsafe")</script>',
        },
    ],
    queries: [],
    diagnostics: [
        {
            range: { start: { line: 0, character: 12 }, end: { line: 0, character: 19 } },
            message: { kind: 'markdown', value: 'Example <error>' },
            severity: 1,
            code: 'example_error',
        },
    ],
};

test('wraps complete symbols across syntax tokens and links keyboard-focusable tooltips', () => {
    const tree = highlighter.codeToHast(analysis.code, {
        lang: 'php',
        theme: 'github-light',
        transformers: [transformerThreeslash(analysis)],
    });
    const nodes = descendants(tree);
    const triggers = nodes.filter((node) => hasClass(node, 'threeslash-hover'));
    const tooltips = nodes.filter((node) => node.properties.role === 'dialog');
    expect(triggers).toHaveLength(2);
    expect(tooltips).toHaveLength(2);
    expect(triggers[0]?.properties.tabIndex).toBe(0);
    expect(triggers[0]?.properties.ariaDescribedBy).toStrictEqual([tooltips[0]?.properties.id]);
    for (const trigger of triggers) {
        expect(triggerSource(trigger)).toBe('$greeting');
    }
    expect(nodes.filter((node) => hasClass(node, 'threeslash-error')).length).toBeGreaterThan(0);
});

test.each([
    '<script>alert("unsafe")</script>',
    '<SCRIPT>alert("unsafe")</SCRIPT>',
    '<ScRiPt>alert("unsafe")</ScRiPt>',
    '<script src="https://example.com/unsafe.js"></script>',
    '<script >alert("unsafe")</script >',
    '<script>alert("unsafe")</script foo="bar">',
])('escapes analyzer text and preserves multiple Shiki themes: %s', (contents) => {
    const result: PhpAnalysis = {
        ...analysis,
        hovers: analysis.hovers.map((hover, index) => (index === 1 ? { ...hover, contents } : hover)),
    };
    const html = highlighter.codeToHtml(result.code, {
        lang: 'php',
        themes: { light: 'github-light', dark: 'github-dark' },
        transformers: [transformerThreeslash(result)],
    });
    expect(html).toMatch(/&#x3C;script/iu);
    expect(elements(parseFragment(html)).filter((node) => node.tagName === 'script')).toHaveLength(0);
    expect(html).toMatch(/Example &#x3C;error>/u);
    expect(html).toMatch(/--shiki-dark/u);
});

test('renders Markdown in hovers and queries while keeping highlighted PHP and valid phrasing content', () => {
    const contents = `Get string length

[PHP manual](https://php.net/manual/en/function.strlen.php)

**$string** The *string* to measure.

**return** \`int<0, max>\`\u0020\u0020
The length.

~~~php
<?php
function strlen(string $string): int;
~~~

## Notes

- First
- Second

3. Third
4. Fourth

> A quote.

---

\`\`\`unknown-language
<plain text>
\`\`\`
`;
    const result: PhpAnalysis = {
        ...analysis,
        hovers: analysis.hovers.slice(0, 1).map((hover) => ({ range: hover.range, contents })),
        queries: analysis.hovers
            .slice(0, 1)
            .map((hover) => ({ range: hover.range, position: { line: 0, character: 0 }, contents })),
    };
    const tree = highlighter.codeToHast(result.code, {
        lang: 'php',
        themes: { light: 'github-light', dark: 'github-dark' },
        transformers: [transformerThreeslash(result)],
    });
    const nodes = descendants(tree);
    const decorations = nodes.filter(
        (node) => hasClass(node, 'threeslash-popup') || hasClass(node, 'threeslash-query'),
    );
    expect(decorations).toHaveLength(2);
    for (const decoration of decorations) {
        const rendered = descendants(decoration);
        expect(rendered.find((node) => node.tagName === 'a')?.properties.href).toBe(
            'https://php.net/manual/en/function.strlen.php',
        );
        expect(rendered.filter((node) => node.tagName === 'strong').map((node) => content(node))).toStrictEqual([
            '$string',
            'return',
        ]);
        expect(rendered.filter((node) => node.tagName === 'em').map((node) => content(node))).toStrictEqual(['string']);
        expect(rendered.filter((node) => node.tagName === 'code').map((node) => content(node))).toStrictEqual([
            'int<0, max>',
        ]);
        expect(rendered.some((node) => node.tagName === 'br')).toBe(true);
        expect(rendered.filter((node) => node.properties.role === 'listitem')).toHaveLength(4);
        expect(rendered.find((node) => hasClass(node, 'threeslash-ol'))?.properties.style).toBe(
            'counter-reset: list-item 2',
        );
        expect(rendered.some((node) => node.properties.role === 'heading')).toBe(true);
        expect(rendered.some((node) => node.properties.role === 'separator')).toBe(true);
        expect(
            rendered.some(
                (node) => typeof node.properties.style === 'string' && node.properties.style.includes('--shiki-dark'),
            ),
        ).toBe(true);
        expect(rendered.some((node) => ['pre', 'p', 'ul', 'li', 'blockquote', 'h2', 'hr'].includes(node.tagName))).toBe(
            false,
        );
        expect(content(decoration)).toContain('<plain text>');
        expect(content(decoration)).not.toContain('<?php');
    }
});

test('neutralizes unsafe Markdown URLs and raw HTML without loading documentation images', () => {
    const result: PhpAnalysis = {
        ...analysis,
        hovers: analysis.hovers.slice(0, 1).map((hover) => ({
            range: hover.range,
            contents: `[unsafe](javascript:alert%281%29) [encoded](jav&#x61;script:alert%281%29)

[data](data:text/html,unsafe) [safe](https://php.net)

<img src=x onerror=alert(1)><script>alert(1)</script>

![image description](https://example.com/image.png)`,
        })),
    };
    const tree = highlighter.codeToHast(result.code, {
        lang: 'php',
        theme: 'github-light',
        transformers: [transformerThreeslash(result)],
    });
    const popups = descendants(tree).filter((node) => hasClass(node, 'threeslash-popup'));
    expect(popups).toHaveLength(1);
    const nodes = popups.flatMap((node) => descendants(node));
    expect(nodes.filter((node) => node.tagName === 'a').map((node) => node.properties.href)).toStrictEqual([
        undefined,
        undefined,
        undefined,
        'https://php.net',
    ]);
    expect(nodes.some((node) => ['img', 'script'].includes(node.tagName))).toBe(false);
    expect(popups.map((node) => content(node)).join('')).toContain('<script>alert(1)</script>');
    expect(popups.map((node) => content(node)).join('')).toContain('image description');
});

test('rejects a mismatched source instead of silently attaching stale hovers', () => {
    expect(() =>
        highlighter.codeToHtml('echo "wrong";', {
            lang: 'php',
            theme: 'github-light',
            transformers: [transformerThreeslash(analysis)],
        }),
    ).toThrow(/matching analysis result/u);
});

test('twoslash styling uses rich popup sections, query lines, and diagnostic severity classes', () => {
    const contents =
        '```php\n<?php\n$greeting = "hello";\n```\n\n**Docs** [manual](https://php.net)\n\n<script>unsafe</script>\n\n[unsafe](javascript:alert%281%29)';
    const [hover] = analysis.hovers;
    const [diagnostic] = analysis.diagnostics;
    if (!hover || !diagnostic) {
        throw new Error('Missing analysis fixtures');
    }
    const result: PhpAnalysis = {
        ...analysis,
        hovers: [{ ...hover, contents }],
        queries: [{ ...hover, position: { line: 0, character: 0 }, contents }],
        diagnostics: [...analysis.diagnostics, { ...diagnostic, severity: 2 }],
    };
    const tree = highlighter.codeToHast(result.code, {
        lang: 'php',
        themes: { light: 'github-light', dark: 'github-dark' },
        transformers: [transformerThreeslash(result, { matchTwoslashStyling: true })],
    });
    const nodes = descendants(tree);
    const pre = nodes.find((node) => node.tagName === 'pre');
    expect(pre && hasClass(pre, 'twoslash')).toBe(true);
    expect(pre?.properties['data-threeslash-code']).toBe(result.code);
    expect(nodes.some((node) => String(node.properties.className).includes('threeslash'))).toBe(false);
    const trigger = findClass(nodes, 'twoslash-hover');
    const popup = findClass(descendants(trigger), 'twoslash-popup-container');
    expect(popup.properties.style).toBe('display: none');
    expect(trigger.properties.tabIndex).toBe(0);
    expect(trigger.properties.ariaDescribedBy).toStrictEqual([popup.properties.id]);
    expect(
        trigger.children
            .filter((node) => node !== popup)
            .map((node) => content(node))
            .join(''),
    ).toBe('$greeting');
    expect(
        popup.children.filter((node) => node.type === 'element').map((node) => node.properties.className),
    ).toStrictEqual([['twoslash-popup-code'], ['twoslash-popup-docs']]);
    const query = findClass(nodes, 'twoslash-query-line');
    expect(hasClass(query, 'twoslash-meta-line')).toBe(true);
    expect(findClass(descendants(query), 'twoslash-popup-container').properties.style).toBeUndefined();
    expect(descendants(query).some((node) => hasClass(node, 'twoslash-popup-arrow'))).toBe(true);
    const errors = nodes.filter((node) => hasClass(node, 'twoslash-error-line'));
    expect(errors).toHaveLength(2);
    expect(errors.some((node) => hasClass(node, 'twoslash-error-level-warning'))).toBe(true);
    expect(nodes.some((node) => hasClass(node, 'twoslash-error'))).toBe(true);
    expect(content(popup)).toContain('<script>unsafe</script>');
    expect(content(popup)).not.toContain('<?php');
    expect(descendants(popup).some((node) => ['script', 'pre', 'p', 'div'].includes(node.tagName))).toBe(false);
    expect(
        descendants(popup)
            .filter((node) => node.tagName === 'a')
            .map((node) => node.properties.href),
    ).toStrictEqual(['https://php.net', undefined]);
    expect(descendants(popup).some((node) => String(node.properties.style).includes('--shiki-dark'))).toBe(true);
});

test('twoslash styling uses warning classes for underlines and leaves ordinary Fumadocs blocks alone', async () => {
    const html = highlighter.codeToHtml(analysis.code, {
        lang: 'php',
        theme: 'github-light',
        transformers: [
            transformerThreeslash(
                { ...analysis, diagnostics: analysis.diagnostics.map((node) => ({ ...node, severity: 2 })) },
                { matchTwoslashStyling: true },
            ),
        ],
    });
    expect(html).toContain('twoslash-error twoslash-error-level-warning');
    const transformer = transformerThreeslashFumadocs({
        matchTwoslashStyling: true,
        executable: '/must-not-be-started',
    });
    const options = { lang: 'php', theme: 'github-light', meta: { __raw: '' } };
    await transformer._fd_prepare(analysis.code, options);
    expect(highlighter.codeToHtml(analysis.code, { ...options, transformers: [transformer] })).not.toContain(
        'twoslash',
    );
});

test.each([false, true])(
    'places annotations between source lines without adding blank lines (twoslash: %s)',
    (matchTwoslashStyling) => {
        const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } };
        const result: PhpAnalysis = {
            code: "$a = 'Hello World';\n\necho $a;",
            hovers: [],
            queries: [
                { range, position: range.start, contents: 'First query' },
                { range, position: { line: 2, character: 5 }, contents: 'Last query' },
            ],
            diagnostics: [{ range, severity: 1, message: 'Example diagnostic' }],
        };
        const tree = highlighter.codeToHast(result.code, {
            lang: 'php',
            theme: 'github-light',
            transformers: [transformerThreeslash(result, { matchTwoslashStyling })],
        });
        const code = descendants(tree).find((node) => node.tagName === 'code');
        expect(codeStructure(code)).toStrictEqual([
            'source',
            '\n',
            'query',
            'diagnostic',
            'source',
            '\n',
            'source',
            '\n',
            'query',
        ]);
        const nodes = descendants(tree);
        const lines = nodes.filter((node) => hasClass(node, 'line'));
        expect(lines.map((node) => content(node))).toStrictEqual(result.code.split('\n'));
        const annotations = nodes.filter((node) => Object.hasOwn(node.properties, 'data-threeslash-annotation'));
        expect(annotations).toHaveLength(3);
        expect(
            annotations.every((node) => code?.children.includes(node) === true && node.properties.style === undefined),
        ).toBe(true);
        expect(annotations.every((node) => node.tagName === (matchTwoslashStyling ? 'div' : 'span'))).toBe(true);
    },
);

test.each([false, true])(
    'does not insert blank lines between consecutive annotated source lines (twoslash: %s)',
    (matchTwoslashStyling) => {
        const result: PhpAnalysis = {
            code: '$a = 1;\n$a++;\necho $a;',
            hovers: [],
            diagnostics: [],
            queries: [0, 1].map((line) => ({
                range: { start: { line, character: 0 }, end: { line, character: 2 } },
                position: { line, character: 0 },
                contents: 'int',
            })),
        };
        const tree = highlighter.codeToHast(result.code, {
            lang: 'php',
            theme: 'github-light',
            transformers: [transformerThreeslash(result, { matchTwoslashStyling })],
        });
        const code = descendants(tree).find((node) => node.tagName === 'code');
        expect(codeStructure(code)).toStrictEqual(['source', '\n', 'query', 'source', '\n', 'query', 'source']);
        expect(
            descendants(tree)
                .filter((node) => hasClass(node, 'line'))
                .map((node) => content(node)),
        ).toStrictEqual(result.code.split('\n'));
    },
);

test('fumadocs transformer leaves ordinary PHP and other languages alone without PHPantom', async () => {
    const transformer = transformerThreeslashFumadocs({ executable: '/must-not-be-started' });
    for (const options of [
        { lang: 'php', theme: 'github-light', meta: { __raw: '' } },
        { lang: 'php', theme: 'github-light', meta: { __raw: 'title="threeslash"' } },
        { lang: 'text', theme: 'github-light', meta: { __raw: 'threeslash' } },
    ]) {
        await transformer._fd_prepare('echo "ok";', options);
        const html = highlighter.codeToHtml('echo "ok";', { ...options, transformers: [transformer] });
        expect(html).not.toMatch(/threeslash-hover/u);
    }
});

test('fumadocs transformer rejects marked blocks when the async hook is missing', () => {
    expect(() =>
        highlighter.codeToHtml('echo 1;', {
            lang: 'php',
            theme: 'github-light',
            meta: { __raw: 'threeslash' },
            transformers: [transformerThreeslashFumadocs()],
        }),
    ).toThrow(/async preparation did not run/u);
});

test('fumadocs rejects oversized marked blocks before retaining them in the queue', async () => {
    const transformer = transformerThreeslashFumadocs({ executable: '/must-not-be-started' });
    await expect(
        transformer._fd_prepare('a'.repeat(analysisLimits.inputBytes + 1), {
            lang: 'php',
            theme: 'github-light',
            meta: { __raw: 'threeslash' },
        }),
    ).rejects.toThrow(/snippet bytes/u);
});

test('fumadocs bounds simultaneous preparations and releases slots after failures', async () => {
    const transformer = transformerThreeslashFumadocs({ executable: '/must-not-be-started' });
    const prepare = async () =>
        transformer._fd_prepare('$value = 1;', { lang: 'php', theme: 'github-light', meta: { __raw: 'threeslash' } });
    const queued = Array.from({ length: analysisLimits.pendingSnippets }, async () => {
        try {
            await prepare();
            return null;
        } catch (error) {
            return error;
        }
    });
    await expect(prepare()).rejects.toThrow(/pending snippets/u);
    const results = await Promise.all(queued);
    expect(results).toHaveLength(analysisLimits.pendingSnippets);
    expect(results.every((result) => result instanceof Error && /could not start PHPantom/u.test(result.message))).toBe(
        true,
    );
    await expect(prepare()).rejects.toThrow(/could not start PHPantom/u);
});
