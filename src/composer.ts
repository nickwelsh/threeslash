import { readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Attach dependencies without importing project settings, executing PHP, or sharing snippet declarations. */
export async function attachComposer(workspace: string, composerRoot: string): Promise<void> {
    const root = await realpath(composerRoot);
    const manifest: unknown = JSON.parse(await readFile(join(root, 'composer.json'), 'utf8'));
    if (!isRecord(manifest) || (manifest['config'] !== undefined && !isRecord(manifest['config']))) {
        throw new Error('Threeslash: composer.json must contain an object with a valid config object.');
    }
    const config = isRecord(manifest['config']) ? manifest['config'] : {};
    const vendorDir = config['vendor-dir'] ?? 'vendor';
    if (typeof vendorDir !== 'string' || vendorDir.length === 0) {
        throw new Error('Threeslash: Composer vendor-dir must be a nonempty string.');
    }
    const vendor = await realpath(resolve(root, vendorDir));
    const vendorStat = await stat(vendor);
    if (!vendorStat.isDirectory()) {
        throw new Error('Threeslash: Composer vendor-dir must be a directory.');
    }
    await stat(join(vendor, 'composer', 'installed.json'));
    // The synthetic project loads vendor symbols only. Hidden snippet setup owns
    // application declarations; source-project PHPantom config is not imported.
    await writeFile(
        join(workspace, 'composer.json'),
        JSON.stringify({
            ...manifest,
            autoload: {},
            'autoload-dev': {},
            config: { ...config, 'vendor-dir': 'vendor' },
        }),
    );
    await symlink(vendor, join(workspace, 'vendor'), 'junction');
}
