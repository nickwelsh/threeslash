import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import { elements } from '../helpers/html.js';

const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

function run(args: Array<string>, input = '') {
    const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 10_000 });
    expect(result.error).toBeUndefined();
    return result;
}

test('built CLI analyzes stdin and returns visible JSON with query results', () => {
    const result = run(['--format', 'json'], '$name = "Ada";\n// ^?');
    expect(result.status, result.stderr).toBe(0);
    const data: unknown = JSON.parse(result.stdout);
    expect(data).toHaveProperty('code', '$name = "Ada";');
    expect(data).toHaveProperty('queries.0.contents', expect.stringContaining('Ada'));
});

test('built CLI attaches installed Composer dependencies to Laravel snippets', () => {
    const composerRoot = fileURLToPath(new URL('../fixtures/laravel', import.meta.url));
    const result = run(['--format', 'json', '--composer-root', composerRoot], "$names = collect(['Ada']);\n// ^?");
    expect(result.status, result.stderr).toBe(0);
    const data: unknown = JSON.parse(result.stdout);
    expect(data).toHaveProperty('queries.0.contents', expect.stringContaining("Collection<int, 'Ada'>"));
    expect(data).toHaveProperty('diagnostics', []);
});

test('built CLI emits a self-contained HTML file with safe code and browser enhancement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threeslash-cli-'));
    try {
        const source = join(directory, 'example.php');
        const output = join(directory, 'example.html');
        await writeFile(source, '$name = "<script>unsafe</script>";\n// ^?');
        const result = run([source, '--output', output]);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe('');
        const html = await readFile(output, 'utf8');
        expect(html).toMatch(/<!doctype html>/u);
        expect(html).toMatch(/threeslash-hover/u);
        expect(html).toMatch(/threeslash-query/u);
        expect(html).toMatch(/enhanceThreeslash\(\)/u);
        const nodes = elements(parse(html));
        const scripts = nodes.filter((node) => node.tagName === 'script');
        expect(scripts).toHaveLength(1);
        expect(scripts[0]?.attrs.find((attribute) => attribute.name === 'type')?.value).toBe('module');
        expect(
            nodes
                .find((node) => node.tagName === 'pre')
                ?.attrs.find((attribute) => attribute.name === 'data-threeslash-code')?.value,
        ).toBe('$name = "<script>unsafe</script>";');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('built CLI fails clearly for errors and invalid arguments', () => {
    const error = run(['--format', 'json'], 'strlen([]);');
    expect(error.status).toBe(1);
    expect(error.stdout).toBe('');
    expect(error.stderr).toMatch(/type_mismatch_argument/u);
    const invalid = run(['--format', 'invalid']);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toMatch(/--format must be html or json/u);
    const timeout = run(['--timeout', '0'], 'echo 1;');
    expect(timeout.status).toBe(1);
    expect(timeout.stderr).toMatch(/positive and finite/u);
    expect(run(['--help']).status).toBe(0);
});
