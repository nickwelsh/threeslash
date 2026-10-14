import { expect, test } from 'vitest';
import { checkErrors, parseSnippet, visibleRange } from '../src/snippet.js';
import { decodeTokens } from '../src/lsp.js';
import type { Diagnostic } from '../src/types.js';
import { analysisLimits } from '../src/limits.js';

test('maps hidden context, CRLF, queries and errors into visible UTF-16 coordinates', () => {
    const snippet = parseSnippet(
        '<?php\r\nclass User {}\r\n// ---cut---\r\n// @errors: unknown_function, unknown_class\r\n$user = new User();\r\n// ^?\r\necho "😀"; $user;\r\n// ---cut-after---\r\n$user;',
    );
    expect(snippet.code).toBe('$user = new User();\necho "😀"; $user;');
    expect(snippet.source).toBe('<?php\nclass User {}\n$user = new User();\necho "😀"; $user;\n$user;');
    expect(snippet.queries).toStrictEqual([{ line: 2, character: 3 }]);
    expect(snippet.expectedErrors).toStrictEqual(['unknown_function', 'unknown_class']);
    expect(visibleRange({ start: { line: 3, character: 11 }, end: { line: 3, character: 16 } }, snippet)).toStrictEqual(
        {
            start: { line: 1, character: 11 },
            end: { line: 1, character: 16 },
        },
    );
    expect(visibleRange({ start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, snippet)).toBeUndefined();
});

test('adds an analysis-only PHP tag without moving visible coordinates', () => {
    const snippet = parseSnippet('$name = "Threeslash";\n// ^?');
    expect(snippet.source).toBe('<?php\n$name = "Threeslash";');
    expect(snippet.code).toBe('$name = "Threeslash";');
    expect(snippet.queries).toStrictEqual([{ line: 1, character: 3 }]);
    expect(snippet.visibleLines.get(1)).toBe(0);
});

test('rejects malformed markers with actionable errors', () => {
    expect(() => parseSnippet('// ^?')).toThrow(/must follow visible PHP/u);
    expect(() => parseSnippet('$a;\n       // ^?')).toThrow(/points past/u);
    expect(() => parseSnippet('// @errors:')).toThrow(/requires at least one/u);
    expect(() => parseSnippet('// ---cut---\n// ---cut---')).toThrow(/must occur once/u);
    expect(() => parseSnippet('// ---cut-after---\n// ---cut-after---')).toThrow(/duplicate/u);
});

test('requires intentional errors to exist and rejects unexpected errors', () => {
    const error: Diagnostic = {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        message: 'Example error',
        severity: 1,
        code: 'unknown_function',
    };
    expect(() => checkErrors([error], ['unknown_function'])).not.toThrow();
    expect(() => checkErrors([{ ...error, severity: 2 }], [])).not.toThrow();
    expect(() => checkErrors([error], [])).toThrow(/unknown_function at 1:1/u);
    expect(() => checkErrors([], ['unknown_function'])).toThrow(/Expected diagnostics not reported/u);
});

test('decodes LSP semantic token deltas without changing UTF-16 columns', () => {
    expect(decodeTokens([1, 0, 5, 0, 0, 0, 12, 4, 1, 0, 2, 9, 5, 0, 0], ['variable', 'keyword'])).toStrictEqual([
        { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
        { start: { line: 3, character: 9 }, end: { line: 3, character: 14 } },
    ]);
    expect(() => decodeTokens([0, 1], [])).toThrow(/malformed/u);
});

test('reports structured LSP diagnostic messages without object stringification', () => {
    const diagnostic: Diagnostic = {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        message: { kind: 'markdown', value: 'Structured <message>' },
        severity: 1,
        code: 'example_error',
    };
    expect(() => checkErrors([diagnostic], [])).toThrow('Structured <message>');
});

test('bounds snippet bytes, lines and annotations at the parser boundary', () => {
    expect(() => parseSnippet('a'.repeat(analysisLimits.inputBytes))).not.toThrow();
    expect(() => parseSnippet('a'.repeat(analysisLimits.inputBytes + 1))).toThrow(/snippet bytes/u);
    expect(() => parseSnippet('😀'.repeat(analysisLimits.inputBytes / 4 + 1))).toThrow(/snippet bytes/u);
    expect(() => parseSnippet('\r\n'.repeat(analysisLimits.lines))).toThrow(/snippet lines/u);
    expect(() => parseSnippet('\n'.repeat(analysisLimits.lines - 1))).not.toThrow();
    expect(() => parseSnippet(`// @errors: ${'x '.repeat(analysisLimits.expectedErrors)}`)).not.toThrow();
    expect(() => parseSnippet(`// @errors: ${'x '.repeat(analysisLimits.expectedErrors + 1)}`)).toThrow(
        /expected diagnostic codes/u,
    );
    expect(() => parseSnippet('// @errors: x\n'.repeat(analysisLimits.expectedErrors + 1))).toThrow(
        /expected diagnostic codes/u,
    );
    expect(() => parseSnippet(`$value;\n${'// ^?\n'.repeat(analysisLimits.queries)}`)).not.toThrow();
    expect(() => parseSnippet(`$value;\n${'// ^?\n'.repeat(analysisLimits.queries + 1)}`)).toThrow(
        /query annotations/u,
    );
});

test('bounds diagnostic collections and preserves warning expectations', () => {
    const warning: Diagnostic = {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: 2,
        code: 'warning',
        message: 'Warning',
    };
    expect(() =>
        checkErrors(
            Array.from({ length: analysisLimits.diagnostics }, () => warning),
            ['warning'],
        ),
    ).not.toThrow();
    expect(() =>
        checkErrors(
            Array.from({ length: analysisLimits.diagnostics + 1 }, () => warning),
            [],
        ),
    ).toThrow(/diagnostics exceeds/u);
    expect(() =>
        checkErrors(
            [],
            Array.from({ length: analysisLimits.expectedErrors + 1 }, () => 'warning'),
        ),
    ).toThrow(/expected diagnostic codes/u);
});

test('bounds semantic token tuples even when all tokens would be skipped', () => {
    const data = Array.from({ length: analysisLimits.tokenTuples }, () => [0, 1, 1, 0, 0]).flat();
    expect(decodeTokens(data, ['keyword'])).toStrictEqual([]);
    expect(() => decodeTokens([...data, 0, 1, 1, 0, 0], ['keyword'])).toThrow(/semantic token tuples/u);
});

test.each([
    [Number.NaN, 0, 1, 0, 0],
    [0, Infinity, 1, 0, 0],
    [-1, 0, 1, 0, 0],
    [0, 0.5, 1, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 1, 1, 0],
    [0, 0, 1, 0, -1],
    [0, 2_147_483_647, 1, 0, 0],
    [2_147_483_647, 0, 1, 0, 0, 1, 0, 1, 0, 0],
])('rejects malformed token values and coordinate overflow: %j', (...data) => {
    expect(() => decodeTokens(data, ['variable'])).toThrow(/malformed/u);
});
