import { expect, test } from 'vitest';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzePhp } from '../../src/analyze.js';

const options = { executable: process.env['PHPANTOM_BIN'] ?? 'phpantom_lsp', timeoutMs: 10_000 };
const composerRoot = fileURLToPath(new URL('../fixtures/laravel', import.meta.url));

test('resolves Eloquent builders, casts, relationships and Collection closures from real Illuminate sources', async () => {
    const results = [];
    for (const filename of ['eloquent.php', 'collections.php']) {
        const source = await readFile(join(composerRoot, filename), 'utf8');
        results.push(await analyzePhp(source, { ...options, composerRoot }));
    }
    expect(results.map((result) => result.diagnostics)).toStrictEqual([[], []]);
    expect(results[0]?.queries.map((query) => query.contents)).toStrictEqual([
        expect.stringContaining('$admins = Collection<int, User>'),
        expect.stringContaining('$admin = User'),
        expect.stringContaining('$isAdmin = bool'),
        expect.stringContaining('$posts = Collection<Post>'),
    ]);
    expect(results[1]?.queries.map((query) => query.contents)).toStrictEqual([
        expect.stringContaining("$names = Collection<int, 'Ada'|'Grace'>"),
        expect.stringContaining("$upper = Collection<int, 'ADA'|'GRACE'>"),
    ]);
    expect(results[0]?.hovers.some((hover) => hover.contents.includes('illuminate/database'))).toBe(true);
    expect(results[0]?.code).not.toContain('class User');
});

test('real PHPantom resolves inferred variables, builtins, hidden class context and queries', async () => {
    const result = await analyzePhp(
        `<?php
final class User {
    public function __construct(public string $name) {}
}
// ---cut---
$user = new User('Ada');
// ^?
$length = strlen($user->name);
// ^?
echo $length;`,
        options,
    );
    expect(result.code.startsWith('$user')).toBe(true);
    expect(result.queries).toHaveLength(2);
    expect(result.queries[0]?.contents).toMatch(/User/u);
    expect(result.queries[1]?.contents).toMatch(/int/u);
    expect(result.hovers.some((hover) => hover.contents.includes('function strlen'))).toBe(true);
    expect(result.hovers.some((hover) => hover.contents.includes('string') && hover.range.start.line === 1)).toBe(true);
    expect(result.diagnostics).toStrictEqual([]);
});

test('waits for slow type diagnostics, checks expectations, and retains exact error ranges', async () => {
    await expect(analyzePhp('strlen([]);', options)).rejects.toThrow(/type_mismatch_argument/u);
    const result = await analyzePhp('// @errors: type_mismatch_argument\nstrlen([]);', options);
    const error = result.diagnostics.find((diagnostic) => diagnostic.code === 'type_mismatch_argument');
    expect(error).toBeDefined();
    expect(error?.range).toStrictEqual({ start: { line: 0, character: 7 }, end: { line: 0, character: 9 } });
    await expect(analyzePhp('// @errors: unknown_class\nstrlen("ok");', options)).rejects.toThrow(
        /Expected diagnostics not reported/u,
    );
});

test('keeps UTF-16 offsets after emoji and removes query lines', async () => {
    const result = await analyzePhp('$name = "Ada";\necho "😀"; $name;\n           // ^?', options);
    const hover = result.hovers.find(
        (candidate) => candidate.range.start.line === 1 && candidate.contents.includes('$name'),
    );
    expect(hover?.range).toStrictEqual({ start: { line: 1, character: 11 }, end: { line: 1, character: 16 } });
    expect(result.queries[0]?.position.character).toBe(14);
});

test('rejects errors in hidden setup and isolates symbols between simultaneous snippets', async () => {
    await expect(analyzePhp('missing_function();\n// ---cut---\necho "ok";', options)).rejects.toThrow(
        /unknown_function/u,
    );
    const [first, second] = await Promise.all([
        analyzePhp('class OnlyInThisSnippet {}\n$value = new OnlyInThisSnippet();', options),
        analyzePhp('// @errors: unknown_class\n$value = new OnlyInThisSnippet();', options),
    ]);
    expect(first.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'unknown_class' }));
    expect(second.diagnostics).toContainEqual(expect.objectContaining({ code: 'unknown_class' }));
});

test('analysis timeout kills the server and allows subsequent analysis', async () => {
    await expect(analyzePhp('$value = 1;', { ...options, timeoutMs: 1 })).rejects.toThrow(/timed out/u);
    const result = await analyzePhp('echo "still works";', options);
    expect(result.diagnostics).toStrictEqual([]);
});

test('analyzes side-effecting PHP without executing the snippet', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threeslash-no-execution-'));
    const marker = join(directory, 'must-not-exist');
    try {
        await analyzePhp(`file_put_contents(${JSON.stringify(marker)}, 'executed');`, options);
        await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
