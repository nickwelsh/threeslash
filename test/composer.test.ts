import { expect, test } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachComposer } from '../src/composer.js';

test('attaches a custom Composer vendor directory while excluding application autoload and settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threeslash-composer-'));
    const project = join(directory, 'project');
    const workspace = join(directory, 'workspace');
    const vendor = join(project, 'dependencies');
    const manifest = {
        require: { 'illuminate/database': '^12.0' },
        autoload: { 'psr-4': { 'App\\': 'app/' }, files: ['bootstrap.php'] },
        'autoload-dev': { 'psr-4': { 'Tests\\': 'tests/' } },
        config: { 'vendor-dir': 'dependencies' },
    };
    try {
        await mkdir(join(vendor, 'composer'), { recursive: true });
        await mkdir(workspace);
        await writeFile(join(project, 'composer.json'), JSON.stringify(manifest));
        await writeFile(join(project, '.phpantom.toml'), '[phpstan]\ncommand = "must-not-run"\n');
        await writeFile(join(vendor, 'composer', 'installed.json'), '{"packages":[]}');
        await attachComposer(workspace, project);
        const vendorPath = await realpath(vendor);
        await expect(realpath(join(workspace, 'vendor'))).resolves.toBe(vendorPath);
        const isolatedManifest: unknown = JSON.parse(await readFile(join(workspace, 'composer.json'), 'utf8'));
        expect(isolatedManifest).toStrictEqual({
            require: manifest.require,
            autoload: {},
            'autoload-dev': {},
            config: { 'vendor-dir': 'vendor' },
        });
        await expect(readFile(join(workspace, '.phpantom.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
        // Removing the isolated workspace must never remove the linked vendor tree.
        await rm(workspace, { recursive: true, force: true });
        await expect(readFile(join(vendor, 'composer', 'installed.json'), 'utf8')).resolves.toBe('{"packages":[]}');
        const originalManifest: unknown = JSON.parse(await readFile(join(project, 'composer.json'), 'utf8'));
        expect(originalManifest).toStrictEqual(manifest);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test.each([null, [], { config: [] }, { config: { 'vendor-dir': 12 } }, { config: { 'vendor-dir': '' } }])(
    'rejects malformed Composer project metadata: %j',
    async (manifest) => {
        const directory = await mkdtemp(join(tmpdir(), 'threeslash-composer-invalid-'));
        try {
            await writeFile(join(directory, 'composer.json'), JSON.stringify(manifest));
            await expect(attachComposer(directory, directory)).rejects.toThrow(/Threeslash:/u);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);
