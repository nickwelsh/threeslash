import { expect, test } from 'vitest';
import { evaluate } from '@mdx-js/mdx';
import { createElement } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyMdxPreset, defineConfig } from 'fumadocs-mdx/config';
import { rehypeCodeDefaultOptions } from 'fumadocs-core/mdx-plugins';
import { transformerThreeslashFumadocs } from '../../src/transformer.js';

const transformer = transformerThreeslashFumadocs({ executable: process.env['PHPANTOM_BIN'] ?? 'phpantom_lsp' });
const config = defineConfig({
    mdxOptions: {
        rehypeCodeOptions: {
            themes: { light: 'github-light', dark: 'github-dark' },
            transformers: [...(rehypeCodeDefaultOptions.transformers ?? []), transformer],
        },
    },
});

async function render(source: string): Promise<string> {
    const preset = typeof config.mdxOptions === 'function' ? await config.mdxOptions() : config.mdxOptions;
    const options = await applyMdxPreset(preset)('runtime');
    const { default: Content } = await evaluate(source, { ...options, Fragment, jsx, jsxs });
    return renderToStaticMarkup(createElement(Content));
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

test('fails a Fumadocs build on unexpected PHP errors and recovers on the next compilation', async () => {
    await expect(render('```php threeslash\nstrlen([]);\n```')).rejects.toThrow(/type_mismatch_argument/u);
    await expect(render('```php threeslash\nstrlen("ok");\n```')).resolves.toMatch(/threeslash-hover/u);
});
