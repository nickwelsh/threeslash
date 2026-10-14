import { expect, test } from 'vitest';
import { evaluate } from '@mdx-js/mdx';
import { createElement } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseFragment } from 'parse5';
import { elements } from '../helpers/html.js';
import { ThreeslashPre, Popup, PopupContent, PopupTrigger } from '../../src/fumadocs.js';
import { applyMdxPreset, defineConfig } from 'fumadocs-mdx/config';
import { rehypeCodeDefaultOptions } from 'fumadocs-core/mdx-plugins';
import { transformerThreeslashFumadocs } from '../../src/transformer.js';
import { transformerTwoslash } from 'fumadocs-twoslash';

function createConfig(matchTwoslashStyling: boolean) {
    const transformer = transformerThreeslashFumadocs({
        executable: process.env['PHPANTOM_BIN'] ?? 'phpantom_lsp',
        ...(matchTwoslashStyling ? {} : { matchTwoslashStyling: false }),
    });
    return defineConfig({
        mdxOptions: {
            rehypeCodeOptions: {
                themes: { light: 'github-light', dark: 'github-dark' },
                transformers: [...(rehypeCodeDefaultOptions.transformers ?? []), transformerTwoslash(), transformer],
            },
        },
    });
}

const config = createConfig(false);
const twoslashConfig = createConfig(true);

async function render(source: string, matchTwoslashStyling = false): Promise<string> {
    const selected = matchTwoslashStyling ? twoslashConfig : config;
    const preset = typeof selected.mdxOptions === 'function' ? await selected.mdxOptions() : selected.mdxOptions;
    const options = await applyMdxPreset(preset)('runtime');
    const { default: Content } = await evaluate(source, { ...options, Fragment, jsx, jsxs });
    return renderToStaticMarkup(
        createElement(
            Content,
            matchTwoslashStyling ? { components: { pre: ThreeslashPre, Popup, PopupContent, PopupTrigger } } : {},
        ),
    );
}

test('compiles real Fumadocs MDX with annotated and ordinary fences, titles, and dual themes', async () => {
    const html = await render(`# PHP with Threeslash

\`\`\`php threeslash title="example.php"
<?php
class User {}
// ---cut---
$user = new User();
// ^?
\`\`\`

\`\`\`php
echo "ordinary";
\`\`\`

\`\`\`php threeslash
// @errors: type_mismatch_argument
strlen([]);
\`\`\`
`);
    expect(html).toMatch(/threeslash-hover/u);
    expect(html).toMatch(/threeslash-query/u);
    expect(html).toMatch(/threeslash-error/u);
    expect(html).toMatch(/type_mismatch_argument/u);
    expect(html).toMatch(/title="example.php"/u);
    expect(html).toMatch(/ordinary/u);
    expect(html).toMatch(/--shiki-dark/u);
    expect(html).toContain('<a href="https://php.net/manual/en/function.strlen.php">');
    expect(html).toContain('<strong>$string</strong>');
    expect(html).toContain('<code>int&lt;0, max&gt;</code>');
    expect(html).not.toMatch(/---cut---|\^\?|@errors|class User/u);
});

test.each([false, true])(
    'shares native popup components with TypeScript on a mixed page (PHP first: %s)',
    async (phpFirst) => {
        const php = '```php threeslash\n$name = "Ada";\n// ^?\necho strlen($name);\n```';
        const ts = '```ts twoslash\nconst name = "Ada";\n//    ^?\nconsole.log(name);\n```';
        const html = await render(phpFirst ? `${php}\n\n${ts}` : `${ts}\n\n${php}`, true);
        const nodes = elements(parseFragment(html));
        expect(nodes.filter((node) => node.tagName === 'pre')).toHaveLength(2);
        expect(
            nodes.filter((node) =>
                node.attrs.some(
                    (attribute) => attribute.name === 'class' && attribute.value.includes('twoslash-query-line'),
                ),
            ),
        ).toHaveLength(2);
        expect(
            nodes.filter((node) => node.attrs.some((attribute) => attribute.name === 'data-threeslash-code')),
        ).toHaveLength(1);
        expect(html).not.toMatch(/class="[^"]*threeslash/u);
        expect(html).not.toContain('fd-twoslash-popover');
    },
);

test('fails a Fumadocs build on unexpected PHP errors and recovers on the next compilation', async () => {
    await expect(render('```php threeslash\nstrlen([]);\n```')).rejects.toThrow(/type_mismatch_argument/u);
    await expect(render('```php threeslash\nstrlen("ok");\n```')).resolves.toMatch(/threeslash-hover/u);
});

test('compiles Twoslash-styled PHP through the Fumadocs transformer and pre component', async () => {
    const html = await render(
        '```php threeslash title="example.php"\n$name = "Ada";\n// ^?\n// @errors: type_mismatch_argument\nstrlen([]);\n```',
        true,
    );
    expect(html).toContain('twoslash-hover');
    expect(html).toContain('twoslash-popup-container');
    expect(html).toContain('twoslash-popup-code');
    expect(html).toContain('twoslash-query-line');
    expect(html).toContain('twoslash-error-line');
    expect(html).toContain('data-threeslash-code=');
    expect(html).toContain('Copy PHP');
    expect(html).toMatch(/<pre[^>]*class="[^"]*twoslash/u);
    expect(html).not.toMatch(/class="[^"]*threeslash/u);
    expect(html).not.toContain('@errors');
    const nodes = elements(parseFragment(html));
    expect(
        nodes.filter((node) =>
            node.attrs.some(
                (attribute) => attribute.name === 'class' && attribute.value.includes('fd-twoslash-popover'),
            ),
        ),
    ).toHaveLength(0);
    expect(
        nodes.some(
            (node) =>
                node.tagName === 'button' &&
                node.attrs.some(
                    (attribute) => attribute.name === 'class' && attribute.value.includes('twoslash-hover'),
                ),
        ),
    ).toBe(true);
    const annotations = nodes.filter((node) =>
        node.attrs.some((attribute) => attribute.name === 'class' && attribute.value.includes('twoslash-meta-line')),
    );
    expect(annotations).toHaveLength(2);
    expect(annotations.every((node) => node.parentNode?.nodeName === 'code')).toBe(true);
    expect(annotations.every((node) => node.attrs.every((attribute) => attribute.name !== 'style'))).toBe(true);
    const queries = nodes.filter(
        (node) =>
            node.parentNode?.nodeName === 'div' &&
            node.attrs.some(
                (attribute) => attribute.name === 'class' && attribute.value.includes('twoslash-popup-container'),
            ),
    );
    expect(queries).toHaveLength(1);
    expect(queries.every((node) => node.attrs.every((attribute) => attribute.name !== 'style'))).toBe(true);
});
