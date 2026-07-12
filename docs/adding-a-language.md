# Adding a new language

A checklist for adding support for a new language to code-nav. Every touch
point is listed in the order you'll need to touch them, with the constraint or
landmine behind each step. Read this alongside `MAINTAINER.md` (the "why") and
the existing python/cpp/bash/typescript branches for reference.

The work splits into four independent layers — LSP server, tree-sitter
parsing, the tool/registration layer, and the CLI test harness — plus docs and
the dev shell. Steps within a layer are grouped; layers can be done in any
order but must land together.

## 1. LSP server — `lsp-client.ts`

1. **Add the language to `Lang`.** The union drives every `Record<Lang, ...>`
   and every `switch`/`if` on language downstream.

2. **Add a `ServerConfig`.** Define `<LANG>_CONFIG` (`command`, `args`,
   `initOptions`). Add it to `DEFAULTS`.

   - Auto-detection (like Python's ty/pyright fallback) is the exception, not
     the default. Only add it if there are two real servers for the language
     and one is strictly better (see `resolveConfig`'s Python branch and the
     "Python server auto-detection" section of MAINTAINER.md). Otherwise a
     plain `DEFAULTS` entry is correct.

3. **`languageIdFor` — only if the LSP convention distinguishes file kinds.**
   Most languages have one `languageId` matching the `Lang` tag and need no
   entry here. Add a branch only when one server covers several file kinds
   that tsserver-class servers distinguish via `didOpen`'s `languageId`
   (e.g. `.ts`→`typescript`, `.tsx`→`typescriptreact`).

4. **`ensureProjectLoaded` — only if the server loads projects lazily.**
   Most servers index eagerly on `initialize` and hit the fast `return true`
   path. Add a real pre-load step only if the server throws "No Project"-style
   errors on `workspace/symbol` before any file is opened (tsserver does;
   ccls/pyright/ty/bash-language-server do not). `findFirstSourceFile` +
   `SOURCE_EXTS` are the scanning helpers.

5. **Verify the server is stdio-only.** All supported servers are stdio-only
   (no `--listen`/`--socket`); the extension owns the child process. Do not
   add a socket client.

## 2. tree-sitter — `tree-sitter-parse.ts`

This module has **no dependency on `lsp-client.ts`** (it makes zero LSP
calls). Keep it that way — do not import `Lang` from the LSP module.

6. **Add the grammar to `TsLang` and `tsLangForFile`.** Confirm the grammar
   ships in `tree-sitter-wasm`'s `out/<lang>/` (check `manifest.json`). If one
   logical language needs **two** grammars (e.g. plain vs. JSX dialects), add
   both to `TsLang` — `TsLang` is allowed to be a **superset** of `Lang`.

7. **`tsLangToLspLang` — only if `TsLang` is a superset of `Lang`.** When two
   tree-sitter grammars map to one LSP server, add the `TsLang → Lang` mapping
   here and export an `LspLang` type. If `TsLang == Lang` (one grammar per
   server), this helper stays a trivial identity and no callers need it.

8. **Add a branch to `classifyRole`.** This is the heart of the work. For
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
     *declaration name* is `var`, not `call`.
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

## 3. Tool layer — `index.ts`

9. **`EXT_LANG`** — map every file extension to the `Lang`. This is the LSP
   routing key. All extensions here should also be handled in
   `tsLangForFile` (step 6); if an extension has a tree-sitter grammar but no
   LSP server (or vice versa), that's a deliberate gap — document why.

10. **`loadConfig`** — add the language to the `["cpp", "python", "bash",
    ...]` array in the `.pi/lsp.json` merge loop so per-project overrides
    work for it.

11. **`code_search_symbol` default `langs`** — add the language to the default list
    so `code_search_symbol` with no `language` param searches it. If the server
    needs `ensureProjectLoaded` (step 4), the call is already there for all
    languages (no-op otherwise).

12. **`code_scan` `include_docs`** — if `TsLang` is a superset (step
    7), the LSP client is spawned via `tsLangToLspLang(tsLang)`, **not** a
    bare `tsLang as Lang` cast. That cast is only valid when `TsLang == Lang`.

## 4. CLI test harness — `scripts/nav-cli.mjs`

13. Nothing to mirror anymore. The CLI is a thin argv-parser around `nav.ts`
    (which `index.ts` also imports); the render helpers live in `render.ts`.
    Adding a language to `EXT_LANG` (in `render.ts`) and `tsLangToLspLang`
    (in `tree-sitter-parse.ts`) is enough — both the extension and the CLI
    pick it up automatically. The only thing to verify is that the CLI's
    `symbol` subcommand (which passes `language` through to `nav.symbol`)
    accepts the new language name.

## 5. Tests — `test/`

14. Add `test/<lang>.test.mjs` pinning the `classifyRole` contract. Use
    `test/cpp.test.mjs` / `test/typescript.test.mjs` as templates. Assert
    every role branch (type / call / member / import / var) with
    `assertEntry` at exact 1-based positions, plus `assertNoEntry` for the
    filtered cases (e.g. declaration names dropped by the default role set).
    Add `tsLangForFile` / `tsLangToLspLang` mapping assertions to
    `test/core.test.mjs` or the per-language test.

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
    this is" language-server list). Update `docs/MAINTAINER.md`: the
    language-server paragraph, the diagnostics capability table (if the new
    server rejects the pull model, add a row), the `TsLang`/`Lang`
    relationship paragraph, the dependency note's grammar list, and add a
    server-specific subsection if the server has quirks (lazy project load,
    no pull diagnostics, non-standard SymbolKind, etc.). Update the
    node-types table in `docs/code_scan.md` with the new language's
    row.

## Final checks

- `npm run check` — tsc passes (the `Lang` union widening surfaces every
  `Record<Lang, ...>` that needs the new key).
- `npm test` — all unit tests pass, including the new `test/<lang>.test.mjs`.
- `npm run test:e2e` — add `test/<lang>.e2e.mjs` (mirror `test/python.e2e.mjs`)
  exercising `outline`/`symbol`/`definition`/`references`/`hover`/`diagnostics`
  against the real server via `nav.*`. Skip gracefully when the server isn't on
  PATH (see `serverAvailable` in `test/e2e-helpers.mjs`).
- End-to-end (manual): run `node scripts/nav-cli.mjs` against a real file
  of the new language for `outline`, `symbol`, `scan --docs`,
  `definition`, `references`, `hover`. The last three are the round-trip
  that `code_scan` positions must satisfy.

## Appendix: probing a tree-sitter grammar

Before writing `classifyRole` rules, dump the tree of a representative
snippet to learn the grammar's node types and field names:

```js
import { Parser, Language } from "web-tree-sitter";
import { getWasmPath } from "tree-sitter-wasm";
import { readFile } from "node:fs/promises";

await Parser.init();
const lang = await Language.load(await readFile(getWasmPath("<lang>")));
const p = new Parser(); p.setLanguage(lang);
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
const { parseSymbols } = await jiti.import("./tree-sitter-parse.ts");
const entries = await parseSymbols("<lang>", { text: code, startLine: 1, endLine: 1, roles: ["type","call","member","import","var"] });
for (const e of entries) console.log(`${e.role}\t${e.name}\t${e.line}:${e.column}`);
'
```
