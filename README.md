# code-nav

LSP-backed semantic code navigation for pi. `/code-nav` enables seven agent
tools backed by ccls, ty/pyright, bash-language-server, and
typescript-language-server.

This is a highly opinionated project. It focuses mainly on few language
servers, which are assumed to be available in dev environment where agent runs,
and ships with fixed language- server defaults that can be overridden per
project.

| Tool                 | Backing                               | Purpose                                                |
|----------------------|---------------------------------------|--------------------------------------------------------|
| `code_search_symbol` | `workspace/symbol`                    | Ranked workspace and indexed third-party symbol search |
| `code_outline`       | `textDocument/documentSymbol` + hover | Structural file outline with signatures and docs       |
| `code_definition`    | `textDocument/definition`             | Definition location and complete source body           |
| `code_references`    | `textDocument/references`             | Semantic references/usages with source context         |
| `code_hover`         | `textDocument/hover`                  | Signature, inferred type, and documentation            |
| `code_rename`        | `textDocument/rename`                 | Semantic workspace rename applied to disk              |
| `code_diagnostics`   | language-server diagnostics           | Current errors, warnings, and hints                    |

## Start with discovery

The intended workflow starts with one of two entry points:

1. Use **`code_search_symbol`** when you know a bare or qualified symbol name.
2. Use **`code_outline`** when you know the file and want to understand its
   classes, functions, methods, signatures, and ranges.
3. Pass the returned `path:line:column` directly to `code_definition`,
   `code_references`, `code_hover`, or `code_rename`.
4. After editing, run `code_diagnostics` on the changed file.

`code_search_symbol` is the main name-based entry point. Its `include` option
can retrieve definitions, hover information, and references for up to five
exact matches in the same call:

```text
code_search_symbol(query="parse", include=["definition", "references"])
code_search_symbol(query="cbor2.loads", include=["definition", "hover"])
code_search_symbol(query="vector::push_back", kinds=["method"],
                   name_pattern="int", include=["definition"])
```

`code_outline` is the corresponding file-based entry point. It returns reusable
identifier positions separately from symbol body ranges and supports pagination.

All tool inputs and outputs use **1-based positions**. `code_definition`,
`code_hover`, and `code_references` take `path` + `line` and exactly one of
`column` or `symbol`; the `symbol` form selects the first exact occurrence on
that line. `code_rename` requires an exact column.

`code_references` returns AST-aware source context by default. Use
`context: "none"` for compact locations or `context: "enclosing"` for the
containing statement. Discovery and reference results are paginated.

### Third-party symbol search

`code_search_symbol` searches beyond the project when the language server can
index relevant dependencies:

- **Python with ty:** direct dependencies discovered from the environment are
  added as workspace roots.
- **C++ with ccls:** included headers and their transitive includes are
  available through the compilation database and ccls index.

This covers dependencies relevant to the current project, not every installed
package or system header. Qualified names such as `commerce.domain.Invoice`,
`typing.cast`, and `std::vector::push_back` improve ranking and narrow results.


## Install and enable

```bash
./install.sh
```

The installer symlinks this checkout to
`~/.pi/agent/extensions/code-nav/` and installs npm dependencies if needed.
Language servers must already be available on `PATH`.

The tools are opt-in per session:

| Command            | Effect                                                  |
|--------------------|---------------------------------------------------------|
| `/code-nav`        | Enable the seven `code_*` tools                         |
| `/code-nav:off`    | Disable the tools and stop all running language servers |
| `/code-nav:status` | Show running language servers and their commands        |

Servers start lazily on the first relevant tool call and stop on
`session_shutdown` (`/new`, `/resume`, `/reload`, or quit).

## Configuration

The workspace root is always the directory in which pi was started. The
extension runs one server per `(workspace, language)`.

Optional project configuration lives in `.pi/lsp.json`. A global
`~/.pi/lsp.json` is also supported. Each language can override `command`,
`args`, and `initOptions`:

```json
{
  "cpp": { "initOptions": { "compilationDatabaseDirectory": "cmake-build-debug" } },
  "python": { "command": "basedpyright-langserver", "args": ["--stdio"] }
}
```

### Built-in defaults

| Language              | Default server                       | Notes                                                                             |
|-----------------------|--------------------------------------|-----------------------------------------------------------------------------------|
| C/C++/Objective-C     | `ccls`                               | Uses `build/compile_commands.json` by default and caches under `~/.cache/ccls-pi` |
| Python                | `ty server`                          | Preferred when available; falls back to `pyright-langserver --stdio`              |
| Bash                  | `bash-language-server start`         | No initialization options                                                         |
| TypeScript/JavaScript | `typescript-language-server --stdio` | One server covers TS, JS, JSX, and module variants                                |

An explicit Python `command` disables auto-detection. ty is preferred because
it implements `workspace/symbol`; pyright's known limitation is that this
request returns no results.

Supported source extensions:

| Language              | Extensions                                 |
|-----------------------|--------------------------------------------|
| C/C++/Objective-C     | `.c .cc .cpp .cxx .h .hh .hpp .hxx .m .mm` |
| Python                | `.py`                                      |
| Bash                  | `.sh .bash`                                |
| TypeScript/JavaScript | `.ts .tsx .js .jsx .mts .cts .mjs .cjs`    |

## Testing

The repository has unit tests and full end-to-end integration tests:

```bash
npm test            # pure syntax/rendering unit tests; no LSP servers needed
npm run test:e2e    # full nav → LSP client → real language server integration
npm run check       # TypeScript type-check
```

The integration tests call the same `src/nav.ts` implementations used by the
extension and cover Python, C++, Bash, and TypeScript/JavaScript, including
outlines, symbol search, definitions, references, hover, diagnostics, and
synchronization after file changes. They load TypeScript through jiti, as pi
does at runtime.

Individual integration suites skip when their required language server is not
available. Set `CODE_NAV_SKIP_E2E=1` to skip the complete integration suite
explicitly.
