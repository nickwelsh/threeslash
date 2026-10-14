import type { Hover } from 'vscode-languageserver-protocol';

/** Flatten LSP markup and legacy marked strings without interpreting their contents. */
export function lspText(contents: Hover['contents']): string {
    if (Array.isArray(contents)) {
        return contents.map((item) => lspText(item)).join('\n\n');
    }
    return typeof contents === 'string' ? contents : contents.value;
}
