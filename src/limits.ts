/** Fixed work budgets for documentation examples, independent of the async timeout. */
export const analysisLimits = {
    inputBytes: 65_536,
    lines: 1024,
    queries: 128,
    expectedErrors: 256,
    diagnostics: 1024,
    tokenTuples: 4096,
    hoverRequests: 1024,
    responseBytes: 8 * 1024 * 1024,
    pendingSnippets: 32,
} as const;

export function checkLimit(resource: string, count: number, maximum: number): void {
    if (count > maximum) {
        throw new Error(`Threeslash: ${resource} exceeds the analysis limit of ${maximum}.`);
    }
}

/** Check length first so even measuring UTF-8 never scans an unbounded string. */
export function checkInput(input: string): void {
    checkLimit('snippet bytes', input.length, analysisLimits.inputBytes);
    checkLimit('snippet bytes', Buffer.byteLength(input, 'utf8'), analysisLimits.inputBytes);
}
