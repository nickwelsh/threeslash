import { lspText } from './lsp-text.js';
import { analysisLimits, checkInput, checkLimit } from './limits.js';
import type { Diagnostic, Position, Range } from './types.js';

export interface Snippet {
    source: string;
    code: string;
    queries: Array<Position>;
    expectedErrors: Array<string>;
    visibleLines: Map<number, number>;
}

/** Remove annotation lines while preserving an explicit source-to-display map. */
export function parseSnippet(input: string): Snippet {
    checkInput(input);
    const lines = input.replaceAll(/\r\n?/gu, '\n').split('\n');
    checkLimit('snippet lines', lines.length, analysisLimits.lines);
    const hasCut = lines.some((line) => /^\s*\/\/ ---cut---\s*$/u.test(line));
    const source: Array<string> = [];
    const visible: Array<string> = [];
    const visibleLines = new Map<number, number>();
    const queries: Array<Position> = [];
    const expectedErrors: Array<string> = [];
    let shown = !hasCut;
    let cut = false;
    let cutAfter = false;
    let previous: number | undefined;

    for (const [index, line] of lines.entries()) {
        if (/^\s*\/\/ ---cut---\s*$/u.test(line)) {
            if (cut || cutAfter) {
                throw new Error('Threeslash: ---cut--- must occur once, before ---cut-after---.');
            }
            shown = true;
            cut = true;
            previous = undefined;
            continue;
        }
        if (/^\s*\/\/ ---cut-after---\s*$/u.test(line)) {
            if (cutAfter) {
                throw new Error('Threeslash: duplicate ---cut-after---.');
            }
            cutAfter = true;
            shown = false;
            previous = undefined;
            continue;
        }
        const errorDirective = '// @errors:';
        const trimmed = line.trimStart();
        if (trimmed.startsWith(errorDirective)) {
            const codes = trimmed
                .slice(errorDirective.length)
                .trim()
                .split(/[\s,]+/u)
                .filter(Boolean);
            if (codes.length === 0) {
                throw new Error('Threeslash: @errors requires at least one diagnostic code.');
            }
            checkLimit(
                'expected diagnostic codes',
                expectedErrors.length + codes.length,
                analysisLimits.expectedErrors,
            );
            expectedErrors.push(...codes);
            continue;
        }
        if (/^\s*\/\/\s*\^\?\s*$/u.test(line)) {
            const character = line.indexOf('^');
            if (previous === undefined || !shown || !visibleLines.has(previous)) {
                throw new Error(`Threeslash: query on line ${index + 1} must follow visible PHP code.`);
            }
            if (character >= (source[previous]?.length ?? 0)) {
                throw new Error(`Threeslash: query on line ${index + 1} points past the previous line.`);
            }
            checkLimit('query annotations', queries.length + 1, analysisLimits.queries);
            queries.push({ line: previous, character });
            continue;
        }
        previous = source.length;
        if (shown) {
            visibleLines.set(previous, visible.length);
            visible.push(line);
        }
        source.push(line);
    }

    // PHP snippets commonly omit the opening tag. It belongs to analysis only.
    if (!/^\s*<\?php\b/iu.test(source.join('\n'))) {
        source.unshift('<?php');
        for (const query of queries) {
            query.line += 1;
        }
        const shifted = [...visibleLines].map(([line, visibleLine]) => [line + 1, visibleLine] as const);
        visibleLines.clear();
        for (const [line, visibleLine] of shifted) {
            visibleLines.set(line, visibleLine);
        }
    }

    return { source: source.join('\n'), code: visible.join('\n'), queries, expectedErrors, visibleLines };
}

export function visibleRange(range: Range, snippet: Snippet): Range | undefined {
    const start = snippet.visibleLines.get(range.start.line);
    const end = snippet.visibleLines.get(range.end.line);
    if (start === undefined || end === undefined) {
        return undefined;
    }
    return {
        start: { line: start, character: range.start.character },
        end: { line: end, character: range.end.character },
    };
}

/** Validate all errors, including hidden setup, before filtering for presentation. */
export function checkErrors(diagnostics: Array<Diagnostic>, expected: Array<string>): void {
    checkLimit('diagnostics', diagnostics.length, analysisLimits.diagnostics);
    checkLimit('expected diagnostic codes', expected.length, analysisLimits.expectedErrors);
    const expectedCodes = new Set(expected);
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 1);
    const actual = new Set(diagnostics.map((diagnostic) => String(diagnostic.code ?? 'unknown')));
    const missing = expected.filter((code) => !actual.has(code));
    const unexpected = errors.filter((diagnostic) => !expectedCodes.has(String(diagnostic.code ?? 'unknown')));
    if (missing.length > 0 || unexpected.length > 0) {
        const details = unexpected.map(
            (diagnostic) =>
                `${diagnostic.code ?? 'unknown'} at ${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}: ${lspText(diagnostic.message)}`,
        );
        if (missing.length > 0) {
            details.push(`Expected diagnostics not reported: ${missing.join(', ')}`);
        }
        throw new Error(
            `Threeslash: PHP errors in snippet. Use // @errors: code to acknowledge intentional errors.\n${details.join('\n')}`,
        );
    }
}
