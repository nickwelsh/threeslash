import type { Diagnostic, Position, Range } from 'vscode-languageserver-protocol';

export type { Diagnostic, Position, Range } from 'vscode-languageserver-protocol';

export interface PhpOptions {
    /** PHPantom executable, not a shell command. Defaults to PHPANTOM_BIN or phpantom_lsp. */
    executable?: string;
    /** Load installed Composer dependencies from this directory. Application files remain snippet-local. */
    composerRoot?: string;
    /** Analysis deadline including preprocessing and setup, checked between bounded work. Cleanup is additional. Defaults to 30 seconds. */
    timeoutMs?: number;
}

export interface PhpHover {
    range: Range;
    /** Original LSP content, retained as text; never interpreted as HTML. */
    contents: string;
}

export interface PhpQuery extends PhpHover {
    position: Position;
}

export interface PhpAnalysis {
    /** Visible PHP, without Threeslash annotations or hidden context. */
    code: string;
    hovers: Array<PhpHover>;
    queries: Array<PhpQuery>;
    /** Coordinates refer to visible code, in zero-based UTF-16 units (LSP). */
    diagnostics: Array<Diagnostic>;
}
