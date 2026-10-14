#!/usr/bin/env node
import process from 'node:process';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';

// Controlled LSP peer for exercising trust boundaries without a PHPantom dependency.
const connection = createMessageConnection(
    new StreamMessageReader(process.stdin),
    new StreamMessageWriter(process.stdout),
);
let scenario = '';
let count = 0;
connection.onRequest('initialize', () => ({
    serverInfo: { name: 'test-phpantom', version: '0.11.1' },
    capabilities: {
        hoverProvider: true,
        semanticTokensProvider: { full: true, legend: { tokenTypes: ['variable'], tokenModifiers: [] } },
    },
}));
/** @param {{ textDocument: { text: string, uri: string } }} params */
async function openDocument({ textDocument }) {
    const marker = textDocument.text.split('budget:')[1]?.split(':');
    scenario = marker?.[0] ?? '';
    count = Number(marker?.[1] ?? 0);
    if (scenario === 'bytes') {
        // An incomplete frame must be bounded before the reader attempts JSON.parse.
        process.stdout.write(`Content-Length: ${count + 100}\r\n\r\n`);
        process.stdout.write(' '.repeat(count));
        return;
    }
    const diagnostic = {
        severity: 2,
        code: 'warning',
        message: 'Warning',
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
    };
    const diagnostics = scenario === 'diagnostics' ? Array.from({ length: count }, () => diagnostic) : [];
    await connection.sendNotification('textDocument/publishDiagnostics', { uri: textDocument.uri, diagnostics });
    await connection.sendNotification('textDocument/publishDiagnostics', { uri: textDocument.uri, diagnostics });
}
connection.onNotification('textDocument/didOpen', openDocument);
connection.onRequest('textDocument/semanticTokens/full', () => ({
    data: Array.from({ length: scenario === 'tokens' || scenario === 'hovers' ? count : 1 }, (_, index) => [
        index === 0 ? 1 : 0,
        1,
        1,
        0,
        0,
    ]).flat(),
}));
connection.onRequest('textDocument/hover', () => ({ contents: 'Test hover' }));
connection.onRequest('shutdown', () => null);
connection.onNotification('exit', () => {
    connection.dispose();
    process.stdin.destroy();
});
connection.listen();
