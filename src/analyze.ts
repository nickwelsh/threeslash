import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lspText } from './lsp-text.js';
import { attachComposer } from './composer.js';
import { decodeTokens, Phpantom } from './lsp.js';
import { checkErrors, parseSnippet, visibleRange } from './snippet.js';
import { analysisLimits, checkLimit } from './limits.js';
import type { PhpAnalysis, PhpHover, PhpOptions, PhpQuery } from './types.js';

export async function analyzePhp(code: string, options: PhpOptions = {}): Promise<PhpAnalysis> {
    const startedAt = performance.now();
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
        throw new Error('Threeslash: timeoutMs must be positive and finite, and at most 2147483647.');
    }
    const timeoutError = () => new Error(`Threeslash: PHPantom analysis timed out after ${timeoutMs}ms.`);
    const checkDeadline = (): void => {
        if (performance.now() - startedAt >= timeoutMs) {
            throw timeoutError();
        }
    };
    const snippet = parseSnippet(code);
    checkDeadline();
    const temporary = await mkdtemp(join(tmpdir(), 'threeslash-'));
    let server: Phpantom | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        checkDeadline();
        const workspace = join(temporary, 'workspace');
        const configHome = join(temporary, 'config');
        await mkdir(workspace);
        checkDeadline();
        if (options.composerRoot !== undefined) {
            await attachComposer(workspace, options.composerRoot);
            checkDeadline();
        }
        await mkdir(join(configHome, 'phpantom_lsp'), { recursive: true });
        checkDeadline();
        // Request all symbol ranges and prevent user-global external tool settings
        // from introducing executable hooks or nondeterministic diagnostics.
        await writeFile(
            join(configHome, 'phpantom_lsp', '.phpantom.toml'),
            '[semantic_tokens]\nmode = "full"\n[phpstan]\ncommand = ""\n[phpcs]\ncommand = ""\n[phpmd]\ncommand = ""\n[mago]\ncommand = ""\n',
        );
        checkDeadline();
        const root = await realpath(workspace);
        checkDeadline();
        server = new Phpantom(options, root, configHome);
        const client = server;
        const uri = pathToFileURL(join(root, `threeslash-${randomUUID()}.php`)).href;
        const task = async (): Promise<PhpAnalysis> => {
            const legend = await client.initialize(pathToFileURL(root).href);
            checkDeadline();
            const diagnostics = await client.open(uri, snippet.source);
            checkDeadline();
            checkErrors(diagnostics, snippet.expectedErrors);
            const tokens = await client.tokens(uri);
            checkDeadline();
            if (!tokens) {
                throw new Error('Threeslash: PHPantom returned no semantic token result.');
            }
            const hovers: Array<PhpHover> = [];
            const ranges = decodeTokens(tokens.data, legend).flatMap((range) => {
                const mapped = visibleRange(range, snippet);
                return mapped ? [{ range, mapped }] : [];
            });
            checkLimit('hover requests', ranges.length + snippet.queries.length, analysisLimits.hoverRequests);
            checkDeadline();
            // Sequential requests keep PHPantom's concurrency bounded on large examples.
            for (const { range, mapped } of ranges) {
                const hover = await client.hover(uri, range.start);
                checkDeadline();
                if (!hover) {
                    continue;
                }
                const contents = lspText(hover.contents).trim();
                if (contents) {
                    hovers.push({ range: mapped, contents });
                }
            }
            const queries: Array<PhpQuery> = [];
            for (const position of snippet.queries) {
                const hover = await client.hover(uri, position);
                checkDeadline();
                if (!hover || !lspText(hover.contents).trim()) {
                    throw new Error(
                        `Threeslash: no PHP hover at query ${position.line + 1}:${position.character + 1}. Align ^? beneath a symbol.`,
                    );
                }
                const visibleLine = snippet.visibleLines.get(position.line);
                if (visibleLine === undefined) {
                    throw new Error('Threeslash: query is outside visible PHP code.');
                }
                const mappedPosition = { line: visibleLine, character: position.character };
                const containing = hovers.find(
                    (item) =>
                        item.range.start.line === mappedPosition.line &&
                        item.range.start.character <= mappedPosition.character &&
                        item.range.end.character > mappedPosition.character,
                );
                const range = containing?.range ?? {
                    start: mappedPosition,
                    end: { ...mappedPosition, character: mappedPosition.character + 1 },
                };
                queries.push({ position: mappedPosition, range, contents: lspText(hover.contents).trim() });
            }
            const result = {
                code: snippet.code,
                hovers,
                queries,
                diagnostics: diagnostics.flatMap((diagnostic) => {
                    const range = visibleRange(diagnostic.range, snippet);
                    return range ? [{ ...diagnostic, range }] : [];
                }),
            };
            checkDeadline();
            return result;
        };
        // Install the timer before starting LSP work, charging preprocessing and setup
        // against the same deadline. Fixed budgets bound synchronous work separately.
        const timedOut = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(timeoutError()), timeoutMs - (performance.now() - startedAt));
        });
        return await Promise.race([task(), timedOut]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
        await server?.close();
        await rm(temporary, { recursive: true, force: true });
    }
}
