import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { analysisLimits, checkLimit } from './limits.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import type { MessageConnection } from 'vscode-jsonrpc/node';
import type { Diagnostic, Hover, InitializeResult, SemanticTokens } from 'vscode-languageserver-protocol';
import type { PhpOptions, Position, Range } from './types.js';

/** One process per snippet: there is no shared symbol state between examples. */
export class Phpantom {
    public readonly child: ChildProcessWithoutNullStreams;
    public readonly connection: MessageConnection;
    public readonly stopped: Promise<never>;
    private readonly started: Promise<void>;
    private stop!: (reason: Error) => void;
    private readonly diagnostics = new Map<string, (diagnostics: Array<Diagnostic>) => void>();
    private stderr = '';
    private closing = false;
    private readonly output: Transform;

    public constructor(options: PhpOptions, cwd: string, configHome: string) {
        const executable = options.executable ?? process.env['PHPANTOM_BIN'] ?? 'phpantom_lsp';
        this.child = spawn(executable, ['--stdio'], {
            cwd,
            stdio: 'pipe',
            env: { ...process.env, XDG_CONFIG_HOME: configHome, APPDATA: configHome },
        });
        this.stopped = new Promise<never>((_resolve, reject) => {
            this.stop = reject;
        });
        this.started = new Promise<void>((resolve) => {
            this.child.once('spawn', resolve);
        });
        // A process can fail between requests. Keep the rejection handled until the next race.
        void this.stopped.catch(() => {
            /* The rejection is propagated through request races. */
        });
        this.child.stderr.on('data', (chunk: Buffer) => {
            this.stderr = (this.stderr + chunk.toString()).slice(-8192);
        });
        this.child.on('error', (error) =>
            this.stop(
                new Error(
                    `Threeslash: could not start PHPantom (${executable}). Install phpantom_lsp or set PHPANTOM_BIN. ${error.message}`,
                ),
            ),
        );
        this.child.on('exit', (code, signal) => {
            if (!this.closing) {
                this.stop(new Error(`Threeslash: PHPantom exited (${signal ?? code}). ${this.stderr}`));
            }
        });
        // Bound the entire session before JSON-RPC buffering and JSON decoding.
        // This also bounds incomplete frames, notification floods and retained hover text.
        let responseBytes = 0;
        // oxlint-disable promise/prefer-await-to-callbacks -- Node Transform requires its callback to release each chunk.
        this.output = new Transform({
            transform: (chunk: Buffer, _encoding, callback) => {
                responseBytes += chunk.length;
                if (responseBytes > analysisLimits.responseBytes) {
                    callback(
                        new Error(
                            `Threeslash: PHPantom response bytes exceeds the analysis limit of ${analysisLimits.responseBytes}.`,
                        ),
                    );
                    return;
                }
                callback(null, chunk);
            },
        });
        // oxlint-enable promise/prefer-await-to-callbacks
        this.output.on('error', (error: Error) => this.stop(error));
        this.connection = createMessageConnection(
            new StreamMessageReader(this.output),
            new StreamMessageWriter(this.child.stdin),
        );
        this.connection.onError(([error]) =>
            this.stop(new Error(`Threeslash: PHPantom transport failed: ${error.message}`)),
        );
        this.connection.onClose(() => {
            if (!this.closing) {
                this.stop(new Error(`Threeslash: PHPantom connection closed. ${this.stderr}`));
            }
        });
        this.connection.onNotification(
            'textDocument/publishDiagnostics',
            (params: { uri: string; diagnostics: Array<Diagnostic> }) => {
                if (params.diagnostics.length > analysisLimits.diagnostics) {
                    this.stop(
                        new Error(
                            `Threeslash: diagnostics exceeds the analysis limit of ${analysisLimits.diagnostics}.`,
                        ),
                    );
                    return;
                }
                this.diagnostics.get(params.uri)?.(params.diagnostics);
            },
        );
        // These requests carry no UI actions or workspace mutations.
        this.connection.onRequest('workspace/configuration', (params: { items: Array<unknown> }) =>
            params.items.map(() => null),
        );
        this.connection.onRequest('client/registerCapability', () => null);
        this.connection.onRequest('window/workDoneProgress/create', () => null);
        this.connection.listen();
        this.child.stdout.pipe(this.output);
    }

    public async request<T>(method: string, params: unknown): Promise<T> {
        await Promise.race([this.started, this.stopped]);
        return Promise.race([this.connection.sendRequest<T>(method, params), this.stopped]);
    }

    public async initialize(rootUri: string): Promise<Array<string>> {
        const result = await this.request<InitializeResult>('initialize', {
            processId: process.pid,
            rootUri,
            workspaceFolders: [{ uri: rootUri, name: 'threeslash' }],
            clientInfo: { name: 'threeslash', version: '0.0.1' },
            capabilities: {
                general: { positionEncodings: ['utf-16'] },
                textDocument: {
                    hover: { contentFormat: ['markdown', 'plaintext'] },
                    // Push diagnostics let us await both native diagnostic phases.
                    publishDiagnostics: { relatedInformation: true },
                    semanticTokens: {
                        requests: { full: true },
                        tokenTypes: [],
                        tokenModifiers: [],
                        formats: ['relative'],
                    },
                },
            },
        });
        // LSP has no native "diagnostics complete" notification. PHPantom 0.11.1
        // publishes twice per native pass (fast, then slow), even for empty sets.
        // Pin this contract instead of guessing completeness with a quiet timer.
        if (result.serverInfo?.version !== '0.11.1') {
            throw new Error(
                `Threeslash: PHPantom 0.11.1 is required; received ${result.serverInfo?.version ?? 'an unknown version'}.`,
            );
        }
        if (result.capabilities.positionEncoding !== undefined && result.capabilities.positionEncoding !== 'utf-16') {
            throw new Error('Threeslash: PHPantom must use UTF-16 positions.');
        }
        const provider = result.capabilities.semanticTokensProvider;
        if (
            provider?.full === undefined ||
            provider.full === false ||
            result.capabilities.hoverProvider === undefined ||
            result.capabilities.hoverProvider === false
        ) {
            throw new Error('Threeslash: PHPantom must support full semantic tokens and hover.');
        }
        await this.connection.sendNotification('initialized', {});
        return provider.legend.tokenTypes;
    }

    public async open(uri: string, text: string): Promise<Array<Diagnostic>> {
        let publications = 0;
        const diagnostics = new Promise<Array<Diagnostic>>((resolve) => {
            this.diagnostics.set(uri, (items) => {
                publications += 1;
                if (publications === 2) {
                    resolve(items);
                }
            });
        });
        await this.connection.sendNotification('textDocument/didOpen', {
            textDocument: { uri, languageId: 'php', version: 1, text },
        });
        try {
            return await Promise.race([diagnostics, this.stopped]);
        } finally {
            this.diagnostics.delete(uri);
        }
    }

    public async tokens(uri: string): Promise<SemanticTokens | null> {
        return this.request('textDocument/semanticTokens/full', { textDocument: { uri } });
    }

    public async hover(uri: string, position: Position): Promise<Hover | null> {
        return this.request('textDocument/hover', { textDocument: { uri }, position });
    }

    public async close(): Promise<void> {
        if (this.closing) {
            return;
        }
        this.closing = true;
        // Shutdown is bounded even if initialization failed or the server wedged.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            if (this.child.pid !== undefined && this.child.exitCode === null && this.child.signalCode === null) {
                await Promise.race([
                    this.connection
                        .sendRequest('shutdown', null)
                        .then(async () => this.connection.sendNotification('exit')),
                    new Promise<void>((resolve) => {
                        timer = setTimeout(resolve, 1000);
                    }),
                ]);
            }
        } catch {
            // Closed transports may throw synchronously. Preserve the analysis error
            // and always continue to forced process cleanup.
        } finally {
            if (this.child.exitCode === null && this.child.signalCode === null) {
                this.child.kill('SIGKILL');
            }
            if (timer) {
                clearTimeout(timer);
            }
            this.connection.dispose();
            this.child.stdin.destroy();
            this.child.stdout.destroy();
            this.output.destroy();
            this.child.stderr.destroy();
        }
    }
}

/** Decode relative LSP tokens. JavaScript strings and LSP both count UTF-16 units. */
export function decodeTokens(data: Array<number>, legend: Array<string>): Array<Range> {
    checkLimit('semantic token tuples', data.length / 5, analysisLimits.tokenTuples);
    if (data.length % 5 !== 0) {
        throw new Error('Threeslash: malformed PHPantom semantic tokens.');
    }
    const ranges: Array<Range> = [];
    let line = 0;
    let character = 0;
    // oxlint-disable typescript/no-non-null-assertion -- The length check above guarantees complete five-number LSP tuples.
    for (let i = 0; i < data.length; i += 5) {
        const deltaLine = data[i]!;
        const deltaCharacter = data[i + 1]!;
        const length = data[i + 2]!;
        const tokenType = data[i + 3]!;
        const modifiers = data[i + 4]!;
        if (
            ![deltaLine, deltaCharacter, length, tokenType, modifiers].every(
                (value) => Number.isInteger(value) && value >= 0 && value <= 2_147_483_647,
            ) ||
            length === 0 ||
            tokenType >= legend.length
        ) {
            throw new Error('Threeslash: malformed PHPantom semantic tokens.');
        }
        line += deltaLine;
        character = (deltaLine === 0 ? character : 0) + deltaCharacter;
        if (line > 2_147_483_647 || character + length > 2_147_483_647) {
            throw new Error('Threeslash: malformed PHPantom semantic tokens.');
        }
        if (['keyword', 'comment'].includes(legend[tokenType] ?? '')) {
            continue;
        }
        ranges.push({ start: { line, character }, end: { line, character: character + length } });
    }
    // oxlint-enable typescript/no-non-null-assertion
    return ranges;
}
