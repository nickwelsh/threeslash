# Threeslash

Threeslash adds PHP type hovers and diagnostics to Shiki code blocks. It uses
[PHPantom](https://github.com/PHPantom-dev/phpantom_lsp) to analyze PHP at build
time, then renders the results with Shiki. It supports Fumadocs and plain Shiki.

Readers can inspect symbols with a pointer or keyboard. Authors can show
inferred types below a line, hide setup code, and document expected errors.
Threeslash never executes the PHP snippets.

## Install

Use your package manager:

```sh
# npm
npm install @nickwelsh/threeslash shiki

# pnpm
pnpm add @nickwelsh/threeslash shiki

# Bun
bun add @nickwelsh/threeslash shiki

# Vite+
vp add @nickwelsh/threeslash shiki
```

Threeslash requires Node.js 22+, Shiki 4.5+, and PHPantom 0.11.1. Install PHPantom
on the machine that builds your documentation:

```sh
cargo install phpantom_lsp --version 0.11.1 --locked
```

You can also download a binary from the
[PHPantom 0.11.1 release](https://github.com/PHPantom-dev/phpantom_lsp/releases/tag/0.11.1).
If the executable is outside your `PATH`, set `PHPANTOM_BIN` to its absolute
path. The analyzer does not require PHP or PHPStan.

The Fumadocs integration requires Fumadocs UI 16.17+ and React 19.2+.
Threeslash tests its MDX integration with Fumadocs Core 16.17 and Fumadocs MDX 15.4.
React and Fumadocs UI are optional for plain Shiki users.

## Fumadocs and MDX

Add the transformer to `source.config.ts`. Keep Fumadocs' default transformers:

```ts
import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { rehypeCodeDefaultOptions } from 'fumadocs-core/mdx-plugins';
import { transformerThreeslashFumadocs } from '@nickwelsh/threeslash';

export const docs = defineDocs({});

export default defineConfig({
    mdxOptions: {
        rehypeCodeOptions: {
            transformers: [...(rehypeCodeDefaultOptions.transformers ?? []), transformerThreeslashFumadocs()],
        },
    },
});
```

Import Threeslash's styles after your Fumadocs styles:

```css
@import '@nickwelsh/threeslash/style.css';
```

Use `ThreeslashPre` for the MDX `pre` component:

```tsx
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { ThreeslashPre } from '@nickwelsh/threeslash/fumadocs';

export const mdxComponents = {
    ...defaultMdxComponents,
    pre: ThreeslashPre,
};
```

Mark the PHP fences you want to analyze with `threeslash`:

````mdx
```php threeslash title="greeting.php"
$name = 'Ada';
// ^?
$length = strlen($name);
// ^?
echo $length;
```
````

Ordinary fences use Fumadocs' normal highlighter. `ThreeslashPre` retains titles
and the `noCopy` option. For annotated blocks, its copy button copies the
visible PHP without hidden setup, type annotations, or diagnostic messages.

The component also opens hover popups above scrolling containers. Tab moves
between symbols and documentation links. Escape closes a popup. Hover prose
renders as sanitized Markdown, and PHP signatures retain their syntax colors.

## Annotations

Threeslash recognizes these standalone comment lines. Align `^?` beneath the
symbol you want to inspect.

| Annotation                | Result                                                      |
| ------------------------- | ----------------------------------------------------------- |
| `// ^?`                   | Show the inferred type of the symbol above the caret.       |
| `// ---cut---`            | Analyze the preceding setup code but hide it from readers.  |
| `// ---cut-after---`      | Analyze the following setup code but hide it from readers.  |
| `// @errors: code1 code2` | Require the listed diagnostic codes and allow those errors. |

The opening `<?php` tag is optional. Hidden setup can declare types that a
snippet needs:

````mdx
```php threeslash
<?php
final class User {
    public function __construct(public string $name) {}
}
// ---cut---
$user = new User('Ada');
// ^?
echo $user->name;
```
````

Unexpected errors fail the documentation build, including errors in hidden
setup. Expected errors must occur or the build fails. Warnings remain visible
and can also appear in `@errors`. The expectations apply to the whole snippet
and match diagnostic codes, not counts.

````mdx
```php threeslash
// @errors: type_mismatch_argument
strlen([]);
```
````

## Laravel and Composer dependencies

Pass `composerRoot` to load a project's installed dependencies:

```ts
transformerThreeslashFumadocs({
    composerRoot: '/absolute/path/to/laravel-app',
});
```

PHPantom reads the Composer manifest and vendor sources to resolve Eloquent
builders, model casts, relationships, and Collection types. Threeslash respects
Composer's `config.vendor-dir`.

The project must already have its Composer dependencies installed. Threeslash does
not boot Laravel, run autoload files, or connect to a database. It does not
import the application's source files or PHPantom configuration. Declare local
models and other application types in hidden snippet setup.

## Plain Shiki

Analyze the snippet, then highlight `analysis.code` with its matching result:

```ts
import { codeToHtml } from 'shiki';
import { analyzePhp, transformerThreeslash } from '@nickwelsh/threeslash';

const analysis = await analyzePhp(`$name = 'Ada';\n// ^?`);
const html = await codeToHtml(analysis.code, {
    lang: 'php',
    theme: 'github-dark',
    transformers: [transformerThreeslash(analysis)],
});
```

Include `@nickwelsh/threeslash/style.css`. The styles support pointer hover and
keyboard focus. For popups that escape scrolling containers and support
Escape, initialize the browser client after the code blocks mount:

```ts
import { enhanceThreeslash } from '@nickwelsh/threeslash/client';

const cleanup = enhanceThreeslash(document);
// Call cleanup() when the page or component unmounts.
```

`transformerThreeslashFumadocs` requires Fumadocs' asynchronous preparation hook.
Use `analyzePhp` and `transformerThreeslash` for other Shiki integrations.

## Analyzer options and results

Both `analyzePhp` and `transformerThreeslashFumadocs` accept these options:

| Option         | Default                                       | Purpose                                                  |
| -------------- | --------------------------------------------- | -------------------------------------------------------- |
| `executable`   | `PHPANTOM_BIN`, then `phpantom_lsp` on `PATH` | Select the PHPantom executable.                          |
| `composerRoot` | None                                          | Load installed dependencies from a Composer project.     |
| `timeoutMs`    | `30000`                                       | Set an analysis deadline in milliseconds (1–2147483647). |

`analyzePhp` returns `code`, `hovers`, `queries`, and `diagnostics`. Coordinates
refer to the visible code and use zero-based UTF-16 offsets, as LSP does.
The hover and query contents retain PHPantom's original text. The renderer
converts Markdown to safe HTML and displays embedded HTML as literal text.

Each snippet gets its own PHPantom process and temporary workspace. Threeslash
removes the workspace and stops the process after success, failure, or timeout.
It disables user-global configuration and external analyzer auto-detection.

Analysis uses fixed resource limits: 64 KiB of UTF-8 snippet input, 1024 input
lines, 128 query annotations, 256 expected diagnostic codes, 1024 diagnostics
per publication, 4096 semantic token tuples, and 1024 hover requests (including
queries). PHPantom's total response stream is limited to 8 MiB per snippet,
before JSON buffering and decoding. Exceeding a limit fails with an explicit
error. The Fumadocs transformer allows at most 32 pending preparations,
rejecting excess blocks before retaining them in its serialized queue.

The deadline counts preprocessing and workspace setup and is checked between
bounded synchronous operations and after filesystem and LSP awaits. The LSP
phase also has an event-loop timer. This is a cooperative deadline: it cannot
interrupt synchronous JavaScript or pending filesystem operations, and process
cleanup can take an additional second. The fixed limits bound synchronous work
independently of the timer; `timeoutMs` is not an OS CPU or memory quota.

Threeslash requires PHPantom 0.11.1 because it waits for that version's two native
diagnostic passes. Other server versions fail with an explicit error.

## CLI

The package includes the `threeslash` command. It accepts a PHP file or standard input:

```sh
pnpm exec threeslash snippet.php --output highlighted.html
pnpm exec threeslash snippet.php --format json
pnpm exec threeslash snippet.php --composer-root /path/to/laravel-app
echo '$name = "Ada";' | pnpm exec threeslash --format json
pnpm exec threeslash --help
```

The default output is a standalone HTML document with styles and the browser
client. Use `--format json` to inspect the analysis result. `--phpantom` selects
an executable, and `--timeout` sets the analysis deadline. Invalid snippets,
invalid arguments, and analyzer failures exit with a nonzero status.

## Development

Use Node.js 24 and the pnpm version in `package.json`. PHP 8.3+ and Composer
are needed to install the Laravel integration test fixtures.

```sh
pnpm install --frozen-lockfile
composer install --working-dir=test/fixtures/laravel --no-scripts --no-plugins
pnpm check
pnpm test:integration
```

`pnpm check` runs formatting, lint, type checks, unit tests, and the package
build. Integration tests require PHPantom 0.11.1 on `PATH` or through
`PHPANTOM_BIN`. They exercise real PHPantom analysis, Laravel dependencies,
Fumadocs MDX compilation, and the CLI.

Run `pnpm format` to format files, `pnpm lint:fix` to apply lint fixes, and
`pnpm test:watch` to watch unit tests. The build uses TypeScript and copies the
stylesheet into `dist`. The npm package contains compiled files, this README,
and the MIT license.
