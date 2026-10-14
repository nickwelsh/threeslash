#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { text } from 'node:stream/consumers';
import { codeToHtml } from 'shiki';
import { analyzePhp } from './analyze.js';
import { transformerThreeslash } from './transformer.js';

async function main(): Promise<void> {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            help: { type: 'boolean', short: 'h' },
            format: { type: 'string', default: 'html' },
            output: { type: 'string', short: 'o' },
            phpantom: { type: 'string' },
            'composer-root': { type: 'string' },
            timeout: { type: 'string' },
        },
    });
    if (values.help === true) {
        process.stdout.write(
            `Usage: threeslash [file.php] [options]\n\nAnalyze a PHP snippet from a file or stdin.\n\n  --format html|json    Standalone HTML (default) or analysis data\n  -o, --output PATH     Write to a file instead of stdout\n  --phpantom PATH      PHPantom 0.11.1 executable\n  --composer-root PATH Installed Composer dependencies\n  --timeout MS         Analysis deadline (default: 30000)\n  -h, --help           Show this help\n`,
        );
        return;
    }
    if (positionals.length > 1) {
        throw new Error('Expected at most one PHP file. See threeslash --help.');
    }
    if (!['html', 'json'].includes(values.format)) {
        throw new Error('--format must be html or json.');
    }
    if (positionals.length === 0 && process.stdin.isTTY) {
        throw new Error('Provide a PHP file or pipe a snippet into stdin.');
    }
    const code = positionals[0] === undefined ? await text(process.stdin) : await readFile(positionals[0], 'utf8');
    const analysis = await analyzePhp(code, {
        ...(values.phpantom === undefined ? {} : { executable: values.phpantom }),
        ...(values['composer-root'] === undefined ? {} : { composerRoot: values['composer-root'] }),
        ...(values.timeout === undefined ? {} : { timeoutMs: Number(values.timeout) }),
    });
    let output: string;
    if (values.format === 'json') {
        output = JSON.stringify(analysis, null, 2);
    } else {
        const html = await codeToHtml(analysis.code, {
            lang: 'php',
            theme: 'github-dark',
            transformers: [transformerThreeslash(analysis)],
        });
        const css = await readFile(new URL('style.css', import.meta.url), 'utf8');
        const client = await readFile(new URL('client.js', import.meta.url), 'utf8');
        output = `<!doctype html>
<html lang="en" class="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Threeslash · PHP</title>
<style>html{color-scheme:dark}body{margin:0;padding:clamp(1rem,4vw,3rem);background:#15171d;color:#dce3ef;font:14px/1.8 system-ui}main{max-width:70rem;margin:auto}pre{padding:1.5rem;border:1px solid #3c414c;border-radius:.7rem;font:14px/1.8 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}h1{font-size:1.2rem}p{color:#a3b0c5}${css}</style>
<main><h1>Threeslash</h1><p>Hover a symbol or focus it with Tab to inspect its PHP type. Press Escape to dismiss.</p>${html}</main>
<script type="module">${client}\nenhanceThreeslash();</script></html>`;
    }
    if (values.output === undefined) {
        process.stdout.write(`${output}\n`);
    } else {
        await writeFile(values.output, `${output}\n`);
    }
}

try {
    await main();
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
