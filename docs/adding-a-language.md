# Adding a new language

A checklist for adding support for a new language to code-nav. Every touch
point is listed in the order you'll need to touch them, with the constraint or
landmine behind each step. Read this alongside the themed docs in `docs/`
(`DESIGN.md` for the "why", `lsp.md` for LSP landmines, `IMPL.md` for the
extension glue, `code_scan.md` for tree-sitter) and the existing
python/cpp/bash/typescript branches for reference.

The work splits into four independent layers — LSP server, tree-sitter
parsing, the tool/registration layer, and the CLI test harness — plus docs and
the dev shell. Steps within a layer are grouped; layers can be done in any
order but must land together.

## 0. Language catalog — `src/languages/`

0. **Add the language to the catalog.** `src/languages/catalog.ts` is the
   **single source of truth**, and `LANGUAGES` is its ONE registry entry per
   language. Add one entry to `LANGUAGES` (an `id`, `displayName`,
   `sourceExts`, and `rootMarkers`) — `Lang`, `ALL_LANGS`, `SOURCE_EXTS`,
   `EXT_LANG`, `ROOT_MARKERS`, `DISPLAY_NAMES`, and the `Record<Lang, ...>`
   typing are ALL derived from that single list, so a language added or
   removed here propagates everywhere. `sourceExts`/`rootMarkers` may be
   empty (source scanning is the detection fallback). `src/languages/types.ts`
   is only a type-only `Lang` re-export facade. The catalog must NOT import
   `lsp-client.ts`.

## 1. LSP server — `src/lsp/server-config.ts` (+ `src/lsp/servers/`)

Server configuration no longer lives in `lsp-client.ts`: `LspClient` consumes
an already-resolved `ResolvedServerConfig` (which carries a stable
`serverKind`) and never knows why ty was selected over pyright. The built-in
per-server defaults live in `src/lsp/servers/<server>.ts`; the `ServerConfig`
/ `ServerKind` / `ResolvedServerConfig` shapes, the `DEFAULTS` table, Python
auto-detection, and `resolveConfig` live in `src/lsp/server-config.ts`.
`lsp-client.ts` re-exports the old surface purely for back-compat.

1. **`Lang` is derived, not hand-written.** The union is derived from
   `LANGUAGES` in `src/languages/catalog.ts` and re-exported (type-only) by
   `src/languages/types.ts`; do not hand-edit a union here. `lsp-client.ts`
   imports `Lang` and `SOURCE_EXTS` from the catalog. The union drives every
   `Record<Lang, ...>` and every `switch`/`if` on language downstream.

2. **Add a `ServerConfig`.** Define `<LANG>_CONFIG` (`command`, `args`,
   `initOptions`) in a new `src/lsp/servers/<server>.ts`. Add it to
   `DEFAULTS` in `src/lsp/server-config.ts` with a matching `serverKind`
   (extend the `ServerKind` union if this is a NEW server identity, not just
   a new language reusing an existing server). `resolveConfig` returns a
   `ResolvedServerConfig`, so any new server kind must be added to the
   `ServerKind` union or the build breaks.

    - Auto-detection (like Python's ty/pyright fallback) is the exception, not
      the default. Only add it if there are two real servers for the language
      and one is strictly better (see `resolveConfig`'s Python branch and the
      "Python server auto-detection" section of `DESIGN.md`). Otherwise a
      plain `DEFAULTS` entry is correct.

    - `serverKind` is the stable identity `LspClient` uses to select
      language-specific behavior (e.g. ty's workspace-diagnostic warm-up).
      Canonical command names are classified exactly (`ty` → `"ty"`,
      `pyright-langserver` → `"pyright"`); anything else resolves to
      `"custom"` unless the user supplies an explicit `serverKind` in
      `.pi/lsp.json` (the escape hatch for absolute paths).

3. **`languageIdFor` — only if the LSP convention distinguishes file kinds.**
   Most languages have one `languageId` matching the `Lang` tag and need no
   entry here. Add a branch only when one server covers several file kinds
   that tsserver-class servers distinguish via `didOpen`'s `languageId`
   (e.g. `.ts`→`typescript`, `.tsx`→`typescriptreact`).

4. **Project readiness — only when the server can answer before project work
   is complete.** Standard work-done servers reuse `WorkDoneProgress` (the
   shared `$/progress` tracker) from `project-progress.ts`. Implement a
   language-specific `ProjectReadiness` policy when completion is nonstandard
   (Bash log messages, ccls `$ccls/info`) or needs a trigger: tsserver needs a
   bootstrap `didOpen`; ty needs `workspace/diagnostic` in workspace mode. The
   policy drives the generic `ProjectHost` (`hasOpenDocuments`,
   `findBootstrapFile(extensions)`, `openDocument`, `request`) — pass
   `SOURCE_EXTS[lang]` (from the catalog) to `findBootstrapFile`. Register it
   in `createProjectReadiness(serverKind)` (selection is by server identity,
   not language: a replacement command resolves to `custom` and gets the no-op
   policy). Document whether the barrier applies to workspace-only queries or
   every per-file action via `ensureWorkspaceReady` / `ensureDocumentReady`.

5. **Verify the server is stdio-only.** All supported servers are stdio-only
   (no `--listen`/`--socket`); the extension owns the child process. Do not
   add a socket client.

## 2. tree-sitter — `src/syntax/`

The tree-sitter support is split by capability under `src/syntax/`:
`runtime.ts` (grammar lifecycle/cache + `TsLang`/`tsLangForFile`/
`tsLangToLspLang`), `symbol-scan.ts` (`parseSymbols`), `reference-context.ts`
(`referenceSyntaxContext`), `definition-context.ts` (`findEnclosingDefWithDoc`),
and `source-render.ts` (rendering). `src/tree-sitter-parse.ts` is now a
compatibility barrel re-exporting their public surface. The whole layer has
**no dependency on `lsp-client.ts`** (it makes zero LSP calls). Keep it that
way — import the neutral `Lang` from `./languages/types`, never from the LSP
module. The per-language role classifiers live in
`src/syntax/classifiers/*.ts`, dispatched by the `TsLang → RoleClassifier`
table in `src/syntax/index.ts` (shared `TSNode` / `fieldOf()` / `SymbolRole` /
`SymbolEntry` types in `src/syntax/types.ts`).

6. **Add the grammar to `TsLang` and `tsLangForFile`** (both in
   `src/syntax/runtime.ts`). Confirm the grammar
   ships in `tree-sitter-wasm`'s `out/<lang>/` (check `manifest.json`). If one
   logical language needs **two** grammars (e.g. plain vs. JSX dialects), add
   both to `TsLang` — `TsLang` is allowed to be a **superset** of `Lang`.

7. **`tsLangToLspLang` — only if `TsLang` is a superset of `Lang`.** When two
   tree-sitter grammars map to one LSP server, add the `TsLang → Lang` mapping
   here and export an `LspLang` type. If `TsLang == Lang` (one grammar per
   server), this helper stays a trivial identity and no callers need it.

8. **Add a classifier file under `src/syntax/classifiers/`** (e.g.
   `rust.ts`) and one line in `src/syntax/index.ts`'s dispatch table
   (`classifierFor`) — this is enough for `parseSymbols`. For
   each node type the grammar uses for identifiers, decide the `SymbolRole`
   (`type` / `call` / `member` / `import` / `var`) from the node's **parent
   type + field name**, not from the node text. Rules of thumb:

    - **`type`** — every occurrence of a type name, not just the definition
      site (the agent hovers any use). Include primitive/builtin type nodes
      if the grammar distinguishes them (e.g. `predefined_type`).
    - **`member`** — the right of `.`, and declared field/method/property
      names (class fields, interface members, enum members, attributes).
    - **`import`** — names brought into scope by import/Export constructs.
      This role is the **whole reason `code_scan` exists** (third-party
      discovery); get it right. Separated from `var` so the default "no var"
      filter keeps imports.
    - **`call`** — a name in call position (`call_expression`'s function
      child, `new`'s constructor).
    - **`var`** — declaration names, parameters, locals, the base of a
      member expression. Noisy by design; filtered out of the default role
      set. Match the other languages' convention: a function/variable
      _declaration name_ is `var`, not `call`.
    - Return **`null`** to skip: keywords, punctuation, comments, strings,
      namespace qualifiers whose meaningful name is a child node, and nodes
      that would duplicate a parent's row.

    Use `fieldOf(node)` (not `===`) to compare node identity — web-tree-sitter
    returns a fresh proxy per `.child()`, so reference equality is always
    false. This was a real bug; do not "simplify" it back.

    **Probe the grammar first.** Before writing rules, parse a representative
    snippet and walk the tree printing `node.type`, `node.text`,
    `node.parent.type`, and the field name — see the snippet at the end of
    this doc. The node-type names and field structure vary per grammar; do not
    guess from another language's grammar.

    **Then audit the shared node-type supersets.** The classifier covers only
    `parseSymbols`. `referenceSyntaxContext` and `findEnclosingDefWithDoc`
    still gate on hand-maintained, language-agnostic node-type sets:

    - `src/syntax/reference-context.ts`: `CALL_NODE_TYPES`, `IMPORT_NODE_TYPES`,
      `MEMBER_NODE_TYPES`, `TYPE_NODE_TYPES`, `DEFINITION_NODE_TYPES`,
      `EXPRESSION_NODE_TYPES`, `STATEMENT_NODE_TYPES`, `STRUCTURAL_NODE_TYPES`,
      `BLOCK_NODE_TYPES`, `COMPLETE_STATEMENT_NODE_TYPES`.
    - `src/syntax/definition-context.ts`: `DEF_NODE_TYPES`, `DEF_BODY_NODE_TYPES`.

    A node type that is not in the relevant set means that capability silently
    degrades: a missing definition-node type skips `enclosing` metadata, a
    missing call-expression type falls back to a passable-but-worse `read`
    context, and a missing `DEF_NODE_TYPES` entry makes `code_definition`'s
    tree-sitter resolver return null (the caller then falls back to LSP).
    Probe the new grammar for these constructs and add them.

    These supersets are collision-prone as grammars accumulate — a later
    `SyntaxLanguage` per-grammar profile will replace them. Until it lands, do
    not rely on `parseSymbols` working as evidence that the reference and
    definition support also work.

## 3. Tool layer — `index.ts`

9. **`EXT_LANG` / `SOURCE_EXTS`** — already derived from the catalog's
   `LANGUAGES[lang].sourceExts` (step 0). Nothing to touch here; route every
   extension you added to the catalog, and make sure each is also handled in
   `tsLangForFile` (step 6). If an extension has a tree-sitter grammar but no
   LSP server (or vice versa), that's a deliberate gap — document why.

10. **`loadConfig`** — iterates `ALL_LANGS` (imported from `nav.ts`) for the
    `.pi/lsp.json` merge loop, so per-project overrides pick up a new
    language automatically once it's added to `ALL_LANGS` (step 0/11) —
    nothing to touch here directly.

11. **`code_search_symbol` default `langs`** — `ALL_LANGS` lives in
    `src/languages/catalog.ts` (re-exported by `nav.ts`). It is used by
    project-language detection (all tiers), `code_search_symbol`'s
    language-validation check (so a bad `language` value fails cleanly instead
    of throwing a raw TypeError out of `resolveConfig`), `index.ts`'s
    `.pi/lsp.json` merge loop, and the `StringEnum` for the `code_search_symbol`
    tool's `language` parameter (the tool-schema-level allow-list an agent
    sees) — one array, four call sites, so adding a language here is enough;
    no separate literal to remember. If the server needs `ensureProjectLoaded`
    (step 4), the call is already there for all languages (no-op otherwise).

12. **`code_scan` `include_docs`** — if `TsLang` is a superset (step
    7), the LSP client is spawned via `tsLangToLspLang(tsLang)`, **not** a
    bare `tsLang as Lang` cast. That cast is only valid when `TsLang == Lang`.

## 4. CLI test harness — `scripts/nav-cli.mjs`

13. Nothing to mirror anymore. The CLI is a thin argv-parser around `nav.ts`
    (which `index.ts` also imports); the render helpers live in `render.ts`.
    Adding a language to the catalog (step 0) and `tsLangToLspLang`
    (in `src/syntax/runtime.ts`) is enough — both the extension and the CLI
    pick it up automatically. The only thing to verify is that the CLI's
    `symbol` subcommand (which passes `language` through to `nav.symbol`)
    accepts the new language name.

## 5. Tests — `test/`

14. Add `test/<lang>.test.mjs` pinning the new classifier's contract. Use
    `test/cpp.test.mjs` / `test/typescript.test.mjs` as templates. Assert
    every role branch (type / call / member / import / var) with
    `assertEntry` at exact 1-based positions, plus `assertNoEntry` for the
    filtered cases (e.g. declaration names dropped by the default role set).
    Add `tsLangForFile` / `tsLangToLspLang` mapping assertions to
    `test/core.test.mjs` or the per-language test, and add a
    `test/languages.test.mjs` row for the new language to pin the derived
    `SOURCE_EXTS`/`EXT_LANG`/`ROOT_MARKERS` consistency (all are derived from
    `LANGUAGES`, so this mostly guards against manual copy drift).

    **Verify positions empirically before writing assertions** — off-by-one
    column counts are the most common test bug. Parse the snippet and print
    `entry.role`, `entry.name`, `entry.line:entry.column`, then copy those
    numbers.

    Run `npm test` (pure tree-sitter, no servers needed).

## 6. Dev shell — `flake.nix`

15. Add the language server (and any runtime it wraps, e.g. `tsserver` for
    `typescript-language-server`) to `devShells.<system>.default.buildInputs`.
    Users provide servers in their own project shells; these are for
    development/testing of the extension.

## 7. Docs

16. Update `README.md` (intro line, built-in defaults, file-extension →
    language table, dependencies grammar list) and `AGENTS.md` (the "What
    this is" language-server list). Update `docs/DESIGN.md`: the supported-
    languages paragraph in the intro. Update `docs/lsp.md`: add a
    server-specific subsection if the server has quirks (lazy project load,
    non-standard SymbolKind, no pull diagnostics, etc.); the
    `TsLang`/`Lang` relationship lives there too. Update
    `docs/code_diagnostics.md`: add a row to the capability table if the new
    server rejects the pull model. Update the node-types table in
    `docs/code_scan.md` with the new language's row. If the new language has
    a per-tool design worth recording (e.g. third-party discovery quirks,
    qualified-name handling), add a `docs/code_<tool>.md` and add a row to
    the table in `MAINTAINER.md` (plus the `docs/` list in `AGENTS.md`).

## Final checks

- `npm run check` — tsc passes (the `Lang` union widening surfaces every
  `Record<Lang, ...>` that needs the new key).
- `npm test` — all unit tests pass, including the new `test/<lang>.test.mjs`.
- `npm run test:e2e` — add `test/<lang>.<tool>.e2e.mjs` files (mirror the
  language/tool split in `test/python.definition.e2e.mjs`) exercising
  `outline`/`symbol`/`definition`/`references`/`hover`/`diagnostics` against the
  real server via `nav.*`. Skip gracefully when the server isn't on PATH (see
  `serverAvailable` in `test/e2e-helpers.mjs`).
- End-to-end (manual): run `node scripts/nav-cli.mjs` against a real file
  of the new language for `outline`, `symbol`, `scan --docs`,
  `definition`, `references`, `hover`. The last three are the round-trip
  that `code_scan` positions must satisfy.

## Appendix: probing a tree-sitter grammar

Before writing classifier rules, dump the tree of a representative
snippet to learn the grammar's node types and field names:

```js
import { Parser, Language } from "web-tree-sitter";
import { getWasmPath } from "tree-sitter-wasm";
import { readFile } from "node:fs/promises";

await Parser.init();
const lang = await Language.load(await readFile(getWasmPath("<lang>")));
const p = new Parser();
p.setLanguage(lang);
const code = `/* representative snippet: imports, types, calls, members */\n`;
const tree = p.parse(code);
(function walk(n, d = 0) {
    if (!n) return;
    const t = n.type;
    if (/identifier|type|property|field/.test(t)) {
        const field = n.parent
            ? (function () {
                  for (let i = 0; i < n.parent.childCount; i++) {
                      const c = n.parent.child(i);
                      if (c && c.id === n.id) return n.parent.fieldNameForChild(i);
                  }
                  return null;
              })()
            : null;
        console.log(
            `L${n.startPosition.row + 1} ${t} | ${n.text} | parent=${n.parent?.type} | gp=${n.parent?.parent?.type} | field=${field}`,
        );
    }
    for (const c of n.children) walk(c, d + 1);
})(tree.rootNode);
```

Run it through the extension's jiti loader (same as the tests) so
`getWasmPath` resolves the same way it does in production:

```sh
node --input-type=module -e '
import { createJiti } from "/home/denin/.npm-local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
const jiti = createJiti(process.cwd(), { cache: false, interopDefault: true });
const { parseSymbols } = await jiti.import("./tree-sitter-parse.ts"); // barrel → src/syntax/symbol-scan.ts
const entries = await parseSymbols("<lang>", { text: code, startLine: 1, endLine: 1, roles: ["type","call","member","import","var"] });
for (const e of entries) console.log(`${e.role}\t${e.name}\t${e.line}:${e.column}`);
'
```
