import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { analyzePhp } from '../src/analyze.js';
import { analysisLimits } from '../src/limits.js';

const executable = fileURLToPath(new URL('fixtures/phpantom.mjs', import.meta.url));
const options = { executable, timeoutMs: 5000 };

test('accepts a normal LSP session and returns mapped hover results', async () => {
    const result = await analyzePhp('$value = 1;', options);
    expect(result.hovers).toStrictEqual([
        { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, contents: 'Test hover' },
    ]);
    expect(result.diagnostics).toStrictEqual([]);
});

test.each([
    ['diagnostics', analysisLimits.diagnostics + 1, /diagnostics exceeds/u],
    ['tokens', analysisLimits.tokenTuples + 1, /semantic token tuples/u],
    ['hovers', analysisLimits.hoverRequests + 1, /hover requests/u],
    ['bytes', analysisLimits.responseBytes + 1, /response bytes exceeds/u],
])(
    'rejects excessive %s through the real process transport',
    async (scenario, count, message) => {
        await expect(analyzePhp(`budget:${scenario}:${count}`, options)).rejects.toThrow(message);
        // Failure must release the transport and allow a new analysis.
        const result = await analyzePhp('$value = 1;', options);
        expect(result.hovers).toHaveLength(1);
    },
    10_000,
);
