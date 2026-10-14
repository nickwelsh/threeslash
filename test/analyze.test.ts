import { expect, test, vi } from 'vitest';
import { analyzePhp } from '../src/analyze.js';
import { analysisLimits } from '../src/limits.js';

test('reports a missing executable and closes its transport', async () => {
    await expect(analyzePhp('$value = 1;', { executable: '/threeslash-does-not-exist/phpantom_lsp' })).rejects.toThrow(
        /could not start PHPantom/u,
    );
}, 3000);

test('validates timeouts before starting a process', async () => {
    for (const timeoutMs of [0, -1, Infinity, Number.NaN, 2_147_483_648]) {
        await expect(analyzePhp('', { timeoutMs })).rejects.toThrow(/positive and finite/u);
    }
});

test('rejects oversized input before workspace or process startup', async () => {
    await expect(
        analyzePhp('a'.repeat(analysisLimits.inputBytes + 1), { executable: '/must-not-be-started' }),
    ).rejects.toThrow(/snippet bytes/u);
});

test('charges synchronous preprocessing against the deadline before process startup', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(100);
    try {
        await expect(analyzePhp('$value = 1;', { timeoutMs: 50, executable: '/must-not-be-started' })).rejects.toThrow(
            /timed out after 50ms/u,
        );
    } finally {
        now.mockRestore();
    }
});
