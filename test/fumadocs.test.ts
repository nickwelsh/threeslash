import { expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThreeslashPre } from '../src/fumadocs.js';

test('fumadocs wrapper uses source-aware copying only for Threeslash blocks', () => {
    const html = renderToStaticMarkup(
        createElement(ThreeslashPre, { 'data-threeslash-code': '$value = 1;', title: 'example.php' }, 'rendered'),
    );
    expect(html).toMatch(/Copy PHP/u);
    expect(html).toMatch(/data-threeslash-code="\$value = 1;"/u);
    expect(html).toMatch(/example.php/u);
    expect(html).toMatch(/<pre[^>]*class="[^"]*threeslash/u);
    const ordinary = renderToStaticMarkup(createElement(ThreeslashPre, {}, 'ordinary'));
    expect(ordinary).not.toMatch(/Copy PHP|data-threeslash-code/u);
    expect(ordinary).toMatch(/Copy Text/u);
});

test('fumadocs noCopy is respected for annotated blocks', () => {
    const html = renderToStaticMarkup(
        createElement(ThreeslashPre, { 'data-threeslash-code': 'echo 1;', allowCopy: 'false' }),
    );
    expect(html).not.toMatch(/Copy PHP/u);
});
