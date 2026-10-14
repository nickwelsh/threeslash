import { randomUUID } from 'node:crypto';
import type { CodeToHastOptions, ShikiTransformer, ShikiTransformerContextCommon } from 'shiki';
import { analyzePhp } from './analyze.js';
import { analysisLimits, checkInput, checkLimit } from './limits.js';
import { rendererThreeslash } from './renderer-threeslash.js';
import { rendererTwoslash, rendererTwoslashFumadocs } from './renderer-twoslash.js';
import type { PhpAnalysis, PhpOptions } from './types.js';

export interface ThreeslashRendererOptions {
    /** Use the native Twoslash renderer (default). Set false for Threeslash's custom CSS and browser client. */
    matchTwoslashStyling?: boolean;
}
export type FumadocsThreeslashOptions = PhpOptions & ThreeslashRendererOptions;

function prepareRenderer(ctx: ShikiTransformerContextCommon, analysis: PhpAnalysis, renderer: ShikiTransformer) {
    ctx.meta.threeslash = { analysis, id: `threeslash-${randomUUID()}` };
    renderer.preprocess?.call(ctx, analysis.code, ctx.options);
}

/** For plain Shiki: analyze first, then highlight analysis.code with this transformer. */
export function transformerThreeslash(
    analysis: PhpAnalysis,
    options: ThreeslashRendererOptions = {},
): ShikiTransformer {
    const renderer = options.matchTwoslashStyling === false ? rendererThreeslash() : rendererTwoslash(analysis);
    return {
        ...renderer,
        name: 'threeslash',
        preprocess(code) {
            if (code !== analysis.code) {
                throw new Error('Threeslash: highlight analysis.code with the matching analysis result.');
            }
            prepareRenderer(this, analysis, renderer);
        },
    };
}

export interface FumadocsThreeslashTransformer extends ShikiTransformer {
    _fd_prepare: (code: string, options: CodeToHastOptions) => Promise<void>;
}

/** Async preparation for Fumadocs' rehypeCode pipeline. Only `php threeslash` fences opt in. */
export function transformerThreeslashFumadocs(options: FumadocsThreeslashOptions = {}): FumadocsThreeslashTransformer {
    const prepared = new WeakMap<object, { code: string; analysis: PhpAnalysis }>();
    let renderer: ShikiTransformer | undefined =
        options.matchTwoslashStyling === false ? rendererThreeslash() : undefined;
    let pending: Promise<unknown> = Promise.resolve();
    let pendingSnippets = 0;
    return {
        name: 'threeslash',
        async _fd_prepare(code, codeOptions) {
            if (codeOptions.lang !== 'php' || !/(?:^|\s)threeslash(?:\s|$)/u.test(codeOptions.meta?.__raw ?? '')) {
                return;
            }
            checkInput(code);
            checkLimit('pending snippets', pendingSnippets + 1, analysisLimits.pendingSnippets);
            codeOptions.meta ??= {};
            const { meta } = codeOptions;
            // Serialize preparation to bound processes and retained snippet input.
            pendingSnippets += 1;
            const task = pending
                .then(async () => {
                    renderer ??= await rendererTwoslashFumadocs();
                    return analyzePhp(code, options);
                })
                .finally(() => {
                    pendingSnippets -= 1;
                });
            pending = task.catch(() => {
                /* Later snippets can recover after a failure. */
            });
            prepared.set(meta, { code, analysis: await task });
        },
        preprocess(code, codeOptions) {
            const result = codeOptions.meta && prepared.get(codeOptions.meta);
            if (!result || !renderer) {
                if (codeOptions.lang === 'php' && /(?:^|\s)threeslash(?:\s|$)/u.test(codeOptions.meta?.__raw ?? '')) {
                    throw new Error(
                        'Threeslash: async preparation did not run. Use Fumadocs rehypeCode, or analyzePhp with transformerThreeslash for plain Shiki.',
                    );
                }
                return code;
            }
            if (result.code !== code) {
                throw new Error(
                    'Threeslash: PHP code changed after async preparation. Run Threeslash before source-changing transformers.',
                );
            }
            prepareRenderer(this, result.analysis, renderer);
            return result.analysis.code;
        },
        tokens(tokens) {
            return this.meta.threeslash ? renderer?.tokens?.call(this, tokens) : undefined;
        },
        span(...args) {
            return this.meta.threeslash ? renderer?.span?.call(this, ...args) : undefined;
        },
        line(...args) {
            return this.meta.threeslash ? renderer?.line?.call(this, ...args) : undefined;
        },
        code(...args) {
            return this.meta.threeslash ? renderer?.code?.call(this, ...args) : undefined;
        },
        pre(...args) {
            return this.meta.threeslash ? renderer?.pre?.call(this, ...args) : undefined;
        },
    };
}
