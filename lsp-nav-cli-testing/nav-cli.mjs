#!/usr/bin/env node
// nav-cli.mjs — test the code-nav LSP client directly (no pi, no LLM).
//
// Imports lsp-client.ts from the extension and calls the same LSP methods the
// six code_* tools wrap. Pure JS (no TS syntax) so node's strip-types works.
//
// The workspace root defaults to the current working directory. Override with
// the CODE_NAV_ROOT env var. The root matters for ccls (needs
// compile_commands.json under <root>/build/) and for pyright project detection.
//
// Usage:
//   node nav-cli.mjs outline <file>
//   node nav-cli.mjs hover <file> <line:1-based> <col:1-based> [<file> <line> <col> ...]
//   node nav-cli.mjs definition <file> <line:1-based> <col:1-based> [<file> <line> <col> ...]
//   node nav-cli.mjs references <file> <line:1-based> <col:1-based> [<file> <line> <col> ...]
//   node nav-cli.mjs rename <file> <line:1-based> <col:1-based> <newName>
//   node nav-cli.mjs symbol <query> [python|cpp|bash]
//   node nav-cli.mjs diagnostics <file>
//
// hover/definition/references accept one or more (file line col) triples; the
// extra triples are batched through one LSP client per language, mirroring the
// `positions` array parameter the code_definition/code_hover/code_references
// tools accept in index.ts.
//
// Examples:
//   node nav-cli.mjs outline temp.py
//   node nav-cli.mjs hover temp.py 5 5
//   node nav-cli.mjs definition second.py 16 7 second.py 10 7
//   node nav-cli.mjs references temp.py 5 5
//   node nav-cli.mjs rename temp.py 5 5 new_name
//   node nav-cli.mjs symbol "parse" python
//   node nav-cli.mjs diagnostics temp.py

import { LspClient, resolveConfig } from "/home/denin/.pi/agent/extensions/code-nav/lsp-client.ts";
import { parseSymbols, renderSymbolTable, hoverFirstLine, tsLangForFile, tsLangToLspLang } from "/home/denin/.pi/agent/extensions/code-nav/tree-sitter-parse.ts";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.CODE_NAV_ROOT ?? process.cwd();
const [cmd, ...rest] = process.argv.slice(2);

function usage() {
  console.error(`usage (root: ${ROOT}):
  node nav-cli.mjs outline <file>
  node nav-cli.mjs hover <file> <line:1-based> <col:1-based> [<file> <line> <col> ...]
  node nav-cli.mjs definition <file> <line:1-based> <col:1-based> [<file> <line> <col> ...] [--list-symbols]
  node nav-cli.mjs references <file> <line:1-based> <col:1-based> [<file> <line> <col> ...]
  node nav-cli.mjs rename <file> <line:1-based> <col:1-based> <newName>
  node nav-cli.mjs symbol <query> [python|cpp|bash]
  node nav-cli.mjs symbols-in <file> <startLine:1-based> <endLine:1-based> [--docs] [--roles type,call,member,import,var]
  node nav-cli.mjs diagnostics <file>

hover/definition/references accept one or more (file line col) triples.
definition accepts --list-symbols to also append a tree-sitter symbol table
  per returned snippet (mirrors code_definition's list_symbols parameter).
symbols-in parses a line range with tree-sitter and lists identifiers with
  their absolute 1-based position and syntactic role (type/call/member/import/var).
  --docs enriches each row with a one-line hover label (LSP round-trips).
  --roles limits which roles to emit (default: type,call,member,import — i.e.
  all except var, which are noisy locals). Pass e.g. --roles var to see only
  locals, or --roles type,call,member,import,var to see everything.
diagnostics fetches errors/warnings for a file via the LSP pull model
  (textDocument/diagnostic, request/response — no push notifications). Output
  positions are 1-based and reusable as (file line col) input to the others.

env:
  CODE_NAV_ROOT  workspace root (default: cwd)`);
  process.exit(2);
}

function kindName(k) {
  const names = ["", "File","Module","Namespace","Package","Class","Method","Property","Field","Constructor","Enum","Interface","Function","Variable","Constant","String","Number","Boolean","Array","Object","Key","Null","EnumMember","Struct","Event","Operator","TypeParameter"];
  return names[k] ?? "Symbol";
}
function renderDoc(sym, depth, lines) {
  const pad = "  ".repeat(depth);
  // Use selectionRange (the identifier span), NOT range.start (the whole symbol
  // extent, which begins at column 0 of the enclosing line and does NOT resolve
  // in hover/definition/references on servers like ty). This makes outline
  // output directly reusable as input to the other nav subcommands.
  // Output is 1-based (LSP returns 0-based; we add 1 here).
  const r = sym.selectionRange?.start;
  const pos = r ? `${r.line + 1}:${r.character + 1}` : "";
  const d = sym.detail ? `  ${sym.detail}` : "";
  lines.push(`${pad}${kindName(sym.kind)} ${sym.name}${d}  (${pos})`);
  for (const ch of sym.children ?? []) renderDoc(ch, depth + 1, lines);
}
function renderSymInfo(s, selStart) {
  const loc = s.location;
  // selStart is the resolved identifier position (0-based LSP coords) when
  // available; falls back to the symbol range start otherwise. We print 1-based
  // so the output is directly reusable as input to hover/definition/references
  // (which expect 1-based and subtract 1 internally).
  const p = selStart ?? loc.range?.start;
  return `${kindName(s.kind)} ${s.name}  ${uriToPath(loc.uri)}:${p?.line + 1 ?? 1}:${p?.character + 1 ?? 1}`;
}

// Resolve the identifier (selectionRange) start for a SymbolInformation.
// workspace/symbol only returns the full extent range (start = col 0 of the
// enclosing line), which does NOT resolve in hover/definition/references on
// servers like ty. We fetch documentSymbol for the result's file (cached per
// uri within one `symbol` call) and find the child whose name matches and whose
// range contains the SymbolInformation's range; use its selectionRange.start.
// Fallback: scan the source line for the symbol name. Returns 0-based coords.
async function resolveSelStart(client, sym, docCache) {
  const path = uriToPath(sym.location.uri);
  const rangeStart = sym.location.range?.start;
  if (!rangeStart) return undefined;
  try {
    let syms = docCache.get(path);
    if (!syms) {
      let text = "";
      try { text = await readFile(path, "utf8"); } catch {}
      const got = await client.documentSymbols(path, text);
      syms = (got && got.length && "selectionRange" in got[0]) ? got : [];
      docCache.set(path, syms);
    }
    const m = findDocSym(syms, sym.name, sym.location.range);
    if (m?.selectionRange?.start) return { line: m.selectionRange.start.line, character: m.selectionRange.start.character };
  } catch {}
  try {
    const text = await readFile(path, "utf8");
    const lineText = text.split(/\r?\n/)[rangeStart.line] ?? "";
    const idx = lineText.indexOf(sym.name);
    if (idx >= 0) return { line: rangeStart.line, character: idx };
  } catch {}
  return undefined;
}
function findDocSym(syms, name, within) {
  for (const s of syms) {
    if (s.name === name && rangeContains(s.range, within)) return s;
    const m = findDocSym(s.children ?? [], name, within);
    if (m) return m;
  }
  return undefined;
}
function rangeContains(outer, inner) {
  if (!outer?.start || !outer?.end || !inner?.start || !inner?.end) return false;
  return posKey(outer.start) <= posKey(inner.start) && posKey(outer.end) >= posKey(inner.end);
}
function posKey(p) { return p.line * 1_000_000 + p.character; }
function renderLoc(loc) {
  const s = loc.range?.start, e = loc.range?.end;
  // +1 to convert 0-based LSP coords to 1-based output (matches CLI input contract).
  return `${uriToPath(loc.uri)}:${s?.line + 1 ?? 1}:${s?.character + 1 ?? 1} - ${e?.line + 1 ?? 1}:${e?.character + 1 ?? 1}`;
}

// Resolve the full definition body for a Location returned by textDocument/definition.
// LSP servers (pyright/ty/ccls) typically return only the identifier span (e.g.
// the 9 chars of `punintend`), not the whole function/class body. To give an agent
// something useful, we fetch documentSymbol for the target file and find the
// child whose selectionRange matches the definition's identifier position; we
// then use that child's full `range` (the enclosing extent) to slice source.
// Returns { startLine, endLine } in 0-based LSP line coords, or null.
async function resolveDefBodyRange(client, loc) {
  const path = uriToPath(loc.uri);
  const idStart = loc.range?.start;
  if (!idStart) return null;
  try {
    let text = "";
    try { text = await readFile(path, "utf8"); } catch {}
    const syms = await client.documentSymbols(path, text);
    const flat = (syms && syms.length && "selectionRange" in syms[0]) ? syms : [];
    const m = findDocSymBySelStart(flat, idStart);
    if (m?.range?.start && m?.range?.end) {
      return { startLine: m.range.start.line, endLine: m.range.end.line };
    }
  } catch {}
  return null;
}

// Find a DocumentSymbol whose selectionRange.start equals `pos` (0-based).
function findDocSymBySelStart(syms, pos) {
  for (const s of syms) {
    const sel = s.selectionRange?.start;
    if (sel && sel.line === pos.line && sel.character === pos.character) return s;
    const m = findDocSymBySelStart(s.children ?? [], pos);
    if (m) return m;
  }
  return undefined;
}
function uriToPath(uri) {
  try {
    if (uri.startsWith("file://")) return fileURLToPath(uri);
    return uri;
  } catch {
    return uri;
  }
}

// --- WorkspaceEdit application (mirrors index.ts applyWorkspaceEdit/applyTextEdits) ---
// LSP lines are 0-based. Edits sorted in reverse line order so earlier offsets
// stay valid as we splice. Multi-line newText handled via split + rejoin.
async function applyWorkspaceEdit(edit) {
  const applied = [];
  const docChanges = edit.documentChanges;
  if (Array.isArray(docChanges)) {
    for (const ch of docChanges) {
      const tde = ch;
      if (tde.textDocument && Array.isArray(tde.edits)) {
        const path = uriToPath(tde.textDocument.uri ?? "");
        const edits = await applyTextEdits(path, tde.edits);
        if (edits > 0) applied.push({ path, edits });
      }
      // CreateFile / DeleteFile / RenameFile are reported but not auto-applied.
    }
  }
  const changes = edit.changes;
  if (changes) {
    for (const [uri, edits] of Object.entries(changes)) {
      const path = uriToPath(uri);
      const n = await applyTextEdits(path, edits);
      if (n > 0) applied.push({ path, edits: n });
    }
  }
  return applied;
}

async function applyTextEdits(path, edits) {
  if (edits.length === 0) return 0;
  let text;
  try { text = await readFile(path, "utf8"); } catch { return 0; }
  const lines = text.split(/\r?\n/);
  const sorted = [...edits].sort((a, b) => {
    const al = a.range?.start?.line ?? 0;
    const bl = b.range?.start?.line ?? 0;
    return bl - al;
  });
  let count = 0;
  for (const e of sorted) {
    const sr = e.range?.start?.line ?? 0;
    const sc = e.range?.start?.character ?? 0;
    const er = e.range?.end?.line ?? 0;
    const ec = e.range?.end?.character ?? 0;
    const before = lines.slice(0, sr);
    const after = lines.slice(er + 1);
    const line = (lines[sr] ?? "") + "";
    const head = line.slice(0, sc);
    const tailLine = lines[er] ?? "";
    const tail = tailLine.slice(ec);
    const replacement = (e.newText ?? "").split(/\r?\n/);
    const merged = [...before, head + replacement[0], ...replacement.slice(1, -1)];
    if (replacement.length > 1) {
      merged[merged.length - 1] = (merged[merged.length - 1] ?? "") + tail;
    } else {
      merged[merged.length - 1] = head + replacement[0] + tail;
    }
    lines.length = 0;
    lines.push(...merged, ...after);
    count++;
  }
  await writeFile(path, lines.join("\n"), "utf8");
  return count;
}
function hoverText(h) {
  if (!h) return "(no hover information)";
  const c = h.contents;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) return c.map(i => typeof i === "string" ? i : i.value).join("\n\n").trim();
  return c.value?.trim() ?? "(empty hover)";
}
// --- diagnostics rendering (mirrors index.ts severityName/diagnosticMessage/renderDiagnostic) ---
// LSP DiagnosticSeverity (1-based) → short label. Matches the tool output.
function severityName(sev) {
  switch (sev) {
    case 1: return "error";
    case 2: return "warning";
    case 3: return "info";
    case 4: return "hint";
    default: return "message";
  }
}
// Extract a plain string message from a Diagnostic (message may be MarkupContent).
function diagnosticMessage(d) {
  const m = d.message;
  if (typeof m === "string") return m;
  return m?.value ?? "";
}
// Render one Diagnostic as a single line. Output positions are 1-based (LSP is
// 0-based; +1) so they are directly reusable as input to hover/definition/
// references (the same contract as the other tools and the code_diagnostics tool).
// Format: `<path>:<line>:<col>  <severity>  <source>  <message>` (source/code
// omitted when absent). Mirrors renderDiagnostic in index.ts exactly.
function renderDiagnostic(path, d) {
  const start = d.range?.start;
  const line = start ? start.line + 1 : 1;
  const col = start ? start.character + 1 : 1;
  const sev = severityName(d.severity);
  const src = d.source ? `  ${d.source}` : "";
  const code = d.code != null ? ` (${d.code})` : "";
  return `${path}:${line}:${col}  ${sev}${src}${code}  ${diagnosticMessage(d)}`;
}
function langFor(path) {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = path.slice(dot).toLowerCase();
  if (ext === ".py") return "python";
  if ([".c",".cc",".cpp",".cxx",".h",".hh",".hpp",".hxx",".m",".mm"].includes(ext)) return "cpp";
  if (ext === ".sh" || ext === ".bash") return "bash";
  if ([".ts",".mts",".cts",".tsx",".jsx",".js",".mjs",".cjs"].includes(ext)) return "typescript";
  return null;
}

async function main() {
  if (!cmd) usage();
  if (cmd === "outline") {
    const [path] = rest; if (!path) usage();
    const lang = langFor(path); if (!lang) throw new Error(`no language for ${path}`);
    const c = new LspClient(lang, ROOT, resolveConfig(lang));
    const abs = resolve(ROOT, path);
    const text = await readFile(abs, "utf8");
    const syms = await c.documentSymbols(abs, text);
    const lines = [];
    if (syms.length === 0) { console.log("(no symbols)"); await c.shutdown(); return; }
    if ("range" in syms[0] && "selectionRange" in syms[0]) {
      for (const s of syms) renderDoc(s, 0, lines);
    } else {
      for (const s of syms) lines.push(renderSymInfo(s));
    }
    console.log(lines.join("\n"));
    await c.shutdown();
  } else if (cmd === "hover" || cmd === "definition" || cmd === "references") {
    // Accept one or more (file line col) triples. Each triple is batched
    // through one LSP client per language (mirroring the `positions` array the
    // code_definition/code_hover/code_references tools accept in index.ts).
    // `definition` also accepts a trailing --list-symbols flag (mirrors the
    // list_symbols parameter of the code_definition tool): strips it from the
    // triples and, when set, appends a tree-sitter symbol table per snippet.
    const listSymbols = rest.includes("--list-symbols");
    const positional = rest.filter(a => a !== "--list-symbols");
    if (positional.length < 3 || positional.length % 3 !== 0) usage();
    const posList = [];
    for (let i = 0; i + 2 < positional.length; i += 3) {
      posList.push({ path: positional[i], line: parseInt(positional[i + 1], 10), col: parseInt(positional[i + 2], 10) });
    }
    if (posList.length === 0) usage();
    // One client per language; reuse across positions of the same lang.
    const clients = new Map();
    const toShutdown = [];
    const out = [];
    try {
      for (const pos of posList) {
        const lang = langFor(pos.path);
        if (!lang) { out.push(`(unknown language for file: ${pos.path})`); continue; }
        let c = clients.get(lang);
        if (!c) {
          c = new LspClient(lang, ROOT, resolveConfig(lang));
          clients.set(lang, c);
          toShutdown.push(c);
        }
        const abs = resolve(ROOT, pos.path);
        let text;
        try {
          text = await readFile(abs, "utf8");
        } catch (e) {
          out.push(`(cannot read ${abs}: ${e})`);
          continue;
        }
        const header = posList.length > 1 ? `### ${pos.path}:${pos.line}:${pos.col}\n` : "";
        if (cmd === "hover") {
          out.push(header + hoverText(await c.hover(abs, pos.line - 1, pos.col - 1, text)));
        } else if (cmd === "definition") {
          const d = await c.definition(abs, pos.line - 1, pos.col - 1, text);
          const locs = Array.isArray(d) ? d : d ? [d] : [];
          if (locs.length === 0) {
            out.push(header + `(no definition found for ${pos.path}:${pos.line}:${pos.col})`);
            continue;
          }
          const block = [];
          if (posList.length > 1) block.push(`### ${pos.path}:${pos.line}:${pos.col}`);
          for (const loc of locs) {
            block.push(renderLoc(loc));
            const p = uriToPath(loc.uri);
            try {
              const src = await readFile(p, "utf8");
              // The definition range from the server is usually just the identifier
              // span. Resolve the enclosing DocumentSymbol to get the full body.
              const body = await resolveDefBodyRange(c, loc);
              const sl = body ? body.startLine : (loc.range?.start?.line ?? 0);
              const el = body ? body.endLine : (loc.range?.end?.line ?? sl);
              const snippet = src.split(/\r?\n/).slice(sl, el + 1).join("\n");
              block.push("```");
              block.push(snippet);
              block.push("```");
              // Optional tree-sitter symbol table over the snippet (mirrors
              // code_definition's list_symbols). sl/el are 0-based LSP line
              // numbers; the absolute 1-based range is (sl+1 .. el+1).
              if (listSymbols) {
                const tsLang = tsLangForFile(p);
                if (tsLang) {
                  try {
                    const entries = await parseSymbols(tsLang, {
                      text: src,
                      startLine: sl + 1,
                      endLine: el + 1,
                    });
                    if (entries && entries.length > 0) {
                      block.push(renderSymbolTable(p, sl + 1, el + 1, entries));
                    }
                  } catch (e) {
                    block.push(`(symbol scan failed: ${e})`);
                  }
                }
              }
            } catch {
              block.push("(could not read source file)");
            }
          }
          out.push(block.join("\n"));
        } else {
          const r = await c.references(abs, pos.line - 1, pos.col - 1, text);
          if (r.length === 0) {
            out.push(header + `(no references found for ${pos.path}:${pos.line}:${pos.col})`);
            continue;
          }
          out.push(header + `${r.length} reference(s):\n` + r.map(renderLoc).join("\n"));
        }
      }
      console.log(out.join("\n"));
    } finally {
      await Promise.allSettled(toShutdown.map(c => c.shutdown()));
    }
  } else if (cmd === "rename") {
    // rename <file> <line:1-based> <col:1-based> <newName>
    // Mirrors the code_rename tool in index.ts: calls textDocument/rename then
    // applies the resulting WorkspaceEdit to disk (both documentChanges and
    // changes forms), printing per-file edit counts. Mutates files on disk.
    const [path, lineStr, colStr, newName] = rest; if (!path || !lineStr || !colStr || !newName) usage();
    const line = parseInt(lineStr, 10), col = parseInt(colStr, 10);
    const lang = langFor(path); if (!lang) throw new Error(`no language for ${path}`);
    const c = new LspClient(lang, ROOT, resolveConfig(lang));
    try {
      const abs = resolve(ROOT, path);
      const text = await readFile(abs, "utf8");
      const edit = await c.rename(abs, line - 1, col - 1, text, newName);
      const applied = await applyWorkspaceEdit(edit);
      if (applied.length === 0) {
        console.log("(rename produced no edits)");
      } else {
        const lines = applied.map(f => `${f.path}: ${f.edits} edit(s)`);
        console.log(`Renamed to "${newName}". Applied:\n` + lines.join("\n"));
      }
    } finally {
      await c.shutdown();
    }
  } else if (cmd === "symbol") {
    const [query, langArg] = rest; if (!query) usage();
    const langs = langArg ? [langArg] : ["python","cpp","bash","typescript"];
    for (const lang of langs) {
      const c = new LspClient(lang, ROOT, resolveConfig(lang));
      try {
        await c.ensureReady();
        await c.ensureProjectLoaded();
        const syms = await c.workspaceSymbol(query);
        if (syms.length === 0) {
          console.error(`[${lang}] (no symbols matching "${query}")`);
        } else {
          const docCache = new Map();
          for (const s of syms) {
            const selStart = await resolveSelStart(c, s, docCache);
            console.log(`[${lang}] ${renderSymInfo(s, selStart)}`);
          }
        }
      } catch (e) {
        console.error(`[${lang}] ${e.message}`);
      }
      await c.shutdown();
    }
  } else if (cmd === "symbols-in") {
    // symbols-in <file> <startLine:1-based> <endLine:1-based> [--docs] [--roles type,call,...]
    // Mirrors the code_symbols_in tool: parses a line range with tree-sitter,
    // lists identifiers with absolute 1-based positions and syntactic roles.
    // --docs enriches each row with a one-line hover label (LSP round-trips).
    // --roles limits which roles to emit (default: all except var).
    // Pure tree-sitter by default (zero LSP calls) — same as the tool.
    const wantDocs = rest.includes("--docs");
    const rolesArg = rest.find(a => a.startsWith("--roles"));
    let roles = undefined; // undefined → parseSymbols uses DEFAULT_SYMBOL_ROLES
    if (rolesArg) {
      const val = rolesArg.includes("=") ? rolesArg.slice(rolesArg.indexOf("=") + 1) : "";
      const list = val.split(",").map(s => s.trim()).filter(Boolean);
      const valid = ["type", "call", "member", "import", "var"];
      roles = list.filter(r => valid.includes(r));
      if (roles.length === 0) throw new Error(`--roles: expected a comma list from ${valid.join(",")}`);
    }
    const positional = rest.filter(a => a !== "--docs" && !a.startsWith("--roles"));
    if (positional.length !== 3) usage();
    const [path, startStr, endStr] = positional;
    const startLine = parseInt(startStr, 10), endLine = parseInt(endStr, 10);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) usage();
    const tsLang = tsLangForFile(path);
    if (!tsLang) throw new Error(`no tree-sitter grammar for ${path}`);
    const abs = resolve(ROOT, path);
    const text = await readFile(abs, "utf8");
    const entries = await parseSymbols(tsLang, { text, startLine, endLine, roles });
    if (entries === null) { console.log(`(no grammar for ${path})`); return; }
    let docs;
    if (wantDocs && entries.length > 0) {
      const lang = tsLangToLspLang(tsLang);
      const c = new LspClient(lang, ROOT, resolveConfig(lang));
      try {
        docs = new Map();
        for (const e of entries) {
          const key = `${e.name}|${e.role}`;
          if (docs.has(key)) continue;
          const h = await c.hover(abs, e.line - 1, e.column - 1, text);
          docs.set(key, hoverFirstLine(hoverText(h)));
        }
      } finally {
        await c.shutdown();
      }
    }
    console.log(renderSymbolTable(path, startLine, endLine, entries, docs));
  } else if (cmd === "diagnostics") {
    // diagnostics <file>
    // Mirrors the code_diagnostics tool: opens the document on the server and
    // sends a single textDocument/diagnostic request (LSP 3.17 pull model) —
    // pure request/response, NO publishDiagnostics notification collection.
    // The server returns the diagnostic set for that document synchronously.
    // We do NOT pre-gate on supportsPullDiagnostics(): pyright answers the
    // request without advertising diagnosticProvider, while bash-language-server
    // rejects it with a JSON-RPC error. The request itself is the source of
    // truth — a server that can't answer returns an error we surface honestly.
    const [path] = rest; if (!path) usage();
    const lang = langFor(path); if (!lang) throw new Error(`no language for ${path}`);
    const c = new LspClient(lang, ROOT, resolveConfig(lang));
    try {
      const abs = resolve(ROOT, path);
      let text;
      try {
        text = await readFile(abs, "utf8");
      } catch (e) {
        throw new Error(`cannot read ${abs}: ${e}`);
      }
      await c.openDocument(abs, text);
      let diags;
      try {
        diags = await c.pullDiagnostics(abs);
      } catch (e) {
        throw new Error(`${lang}: textDocument/diagnostic request failed: ${e.message ?? e}`);
      }
      if (diags === null || diags.length === 0) {
        console.log(`(no diagnostics for ${path})`);
      } else {
        const lines = diags.map(d => renderDiagnostic(path, d));
        console.log(`${diags.length} diagnostic(s) for ${path}:\n` + lines.join("\n"));
      }
    } finally {
      await c.shutdown();
    }
  } else {
    usage();
  }
}
main().catch(e => { console.error("FAILED:", e); process.exit(1); });
