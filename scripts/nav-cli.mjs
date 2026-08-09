#!/usr/bin/env node
// nav-cli.mjs — exercise the code-nav tool implementations directly (no pi, no LLM).
//
// This CLI is a THIN argv-parser around the real tool implementations in
// nav.ts (which index.ts also uses). It does NOT re-implement any rendering
// or tool logic — the old "keep this file in sync with index.ts by hand"
// landmine is gone. Both the extension and this CLI import from src/render.ts +
// src/nav.ts, so they produce byte-identical output by construction.
//
// We load the .ts modules through jiti — the same loader pi uses to load
// extensions — so bare-specifier resolution (web-tree-sitter,
// vscode-languageserver-protocol, etc.) matches production and works without
// the install symlink. The jiti binary comes from pi's own node_modules.
//
// The workspace root defaults to the current working directory. Override with
// the CODE_NAV_ROOT env var. The root matters for ccls (needs
// compile_commands.json under <root>/build/) and for pyright project detection.
//
// Usage:
//   node nav-cli.mjs outline <file> [offset:1-based] [limit]
//   node nav-cli.mjs hover <file> <line:1-based> <col:1-based>
//   node nav-cli.mjs definition <file> <line:1-based> <col:1-based> [--list-symbols]
//   node nav-cli.mjs references <file> <line:1-based> <col:1-based> [--context none|syntax|enclosing] [--offset N] [--limit N] [--list-symbols]
//   node nav-cli.mjs rename <file> <line:1-based> <col:1-based> <newName>
//   node nav-cli.mjs symbol <query> [python|cpp|bash|typescript] [--include definition,hover,references] [--kinds function,method] [--name-pattern <regexp>]
//   node nav-cli.mjs scan <file> [<startLine:1-based> <endLine:1-based>] [--pattern <regexp>] [--docs] [--roles type,call,member,import,var]
//   node nav-cli.mjs diagnostics <file>
//
// hover/definition/references each take a SINGLE (file line col) triple —
// one symbol per call. definition and contextual references also accept a
// --list-symbols flag (mirrors their list_symbols tool parameter).
//
// Examples:
//   node nav-cli.mjs outline temp.py
//   node nav-cli.mjs outline temp.py 1 50
//   node nav-cli.mjs scan temp.py                  # whole file
//   node nav-cli.mjs scan temp.py --pattern load   # filter by name
//   node nav-cli.mjs hover temp.py 5 5
//   node nav-cli.mjs definition second.py 16 7
//   node nav-cli.mjs references temp.py 5 5
//   node nav-cli.mjs rename temp.py 5 5 new_name
//   node nav-cli.mjs symbol "parse" python
//   node nav-cli.mjs symbol "push_back" cpp --include definition,references
//   node nav-cli.mjs symbol "foo" --kinds function --name-pattern "^foo$"
//   node nav-cli.mjs diagnostics temp.py

import { createJiti } from "/home/denin/.npm-local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// EXT_DIR is the extension root (parent of scripts/). jiti resolves modules
// relative to it — same as the unit tests (test/helpers.mjs) and as pi at
// runtime. This means the CLI exercises the EXACT .ts source, not a copy.
const EXT_DIR = resolve(__dirname, "..");

const jiti = createJiti(EXT_DIR, { cache: false, interopDefault: true });
const { LspClient, resolveConfig } = await jiti.import("./src/lsp-client.ts");
const nav = await jiti.import("./src/nav.ts");

const ROOT = resolve(process.env.CODE_NAV_ROOT ?? process.cwd());
const [cmd, ...rest] = process.argv.slice(2);

function usage() {
    console.error(`usage (root: ${ROOT}):
  node nav-cli.mjs outline <file> [offset:1-based] [limit]
  node nav-cli.mjs hover <file> <line:1-based> <col:1-based>
  node nav-cli.mjs definition <file> <line:1-based> <col:1-based> [--list-symbols]
  node nav-cli.mjs references <file> <line:1-based> <col:1-based> [--context none|syntax|enclosing] [--offset N] [--limit N] [--list-symbols]
  node nav-cli.mjs rename <file> <line:1-based> <col:1-based> <newName>
  node nav-cli.mjs symbol <query> [python|cpp|bash|typescript] [--include definition,hover,references] [--kinds function,method] [--name-pattern <regexp>]
  node nav-cli.mjs scan <file> [<startLine:1-based> <endLine:1-based>] [--pattern <regexp>] [--docs] [--roles type,call,member,import,var]
  node nav-cli.mjs diagnostics <file>

hover/definition/references each take a SINGLE (file line col) triple — one
  symbol per call. outline prints a structural overview (classes, methods,
  functions, constructors, interfaces, structs) with signatures, body line
  ranges, and a one-line doc snippet per entry — constants/variables/properties
  are dropped. Paginated: optional offset (1-based) and limit (default 20).
definition accepts a SINGLE (file line col) triple and returns the source body
  with absolute line-number gutters (header \`<defPath>:<sl>-<el>\`, no fence).
  Throws a hard error if it cannot return source code. --list-symbols adds
  compact name@column role metadata below relevant source lines. references
  accepts the same flag for contextual source output.
scan lists identifiers with their absolute 1-based position and syntactic role
  (type/call/member/import/var). With no line range it scans the whole file.
  --pattern filters symbols by name regexp. --docs enriches each row with a
  one-line hover label (LSP round-trips). --roles limits which roles to emit
  (default: type,call,member,import — i.e. all except var, which are noisy
  locals). Pass e.g. --roles var to see only locals, or
  --roles type,call,member,import,var to see everything.
diagnostics fetches errors/warnings for a file using pull diagnostics first,
  with a bounded push-diagnostics fallback for servers that do not support the
  pull method. Output positions are 1-based and reusable as (file line col)
  input to the others.

env:
  CODE_NAV_ROOT  workspace root (default: cwd)`);
    process.exit(2);
}

// One LSP client per language, spawned lazily and reused across calls in one
// invocation (so a batched `symbol` over 4 languages opens 4 clients, not 4×N).
// All spawned clients are shut down on exit (success or error).
const clients = new Map();
const clientOf = async (lang) => {
    let c = clients.get(lang);
    if (!c) {
        c = new LspClient(lang, ROOT, resolveConfig(lang));
        clients.set(lang, c);
    }
    await c.ensureReady();
    return c;
};
async function shutdownAll() {
    await Promise.allSettled([...clients.values()].map((c) => c.shutdown()));
    clients.clear();
}

async function main() {
    if (!cmd) usage();
    if (cmd === "outline") {
        const [path, off, lim] = rest;
        if (!path) usage();
        const params = { path };
        if (off) params.offset = parseInt(off, 10);
        if (lim) params.limit = parseInt(lim, 10);
        console.log(await nav.outline(params, ROOT, clientOf));
    } else if (cmd === "hover" || cmd === "references") {
        // Both take a SINGLE (file line col) triple — one symbol per call.
        if (rest.length < 3) usage();
        const params = {
            path: rest[0],
            line: parseInt(rest[1], 10),
            column: parseInt(rest[2], 10),
        };
        if (cmd === "hover") {
            if (rest.length !== 3) usage();
            console.log(await nav.hover(params, ROOT, clientOf));
        } else {
            for (let i = 3; i < rest.length;) {
                const flag = rest[i];
                if (flag === "--list-symbols") {
                    params.list_symbols = true;
                    i += 1;
                    continue;
                }
                const value = rest[i + 1];
                if (!value) usage();
                if (flag === "--context") params.context = value;
                else if (flag === "--offset") params.offset = parseInt(value, 10);
                else if (flag === "--limit") params.limit = parseInt(value, 10);
                else usage();
                i += 2;
            }
            console.log(await nav.references(params, ROOT, clientOf));
        }
    } else if (cmd === "definition") {
        // definition takes a SINGLE (file line col) triple — it returns the
        // numbered source body of one symbol (no batching). --list-symbols is
        // optional and adds compact metadata below relevant source lines.
        const listSymbols = rest.includes("--list-symbols");
        const symbolRoles = ["type", "call", "member", "import", "var"];
        const positional = rest.filter((a) => a !== "--list-symbols");
        if (positional.length !== 3) usage();
        const params = {
            path: positional[0],
            line: parseInt(positional[1], 10),
            column: parseInt(positional[2], 10),
            list_symbols: listSymbols ? symbolRoles : undefined,
        };
        console.log(await nav.definition(params, ROOT, clientOf));
    } else if (cmd === "rename") {
        const [path, lineStr, colStr, newName] = rest;
        if (!path || !lineStr || !colStr || !newName) usage();
        const line = parseInt(lineStr, 10),
            column = parseInt(colStr, 10);
        console.log(await nav.rename({ path, line, column, newName }, ROOT, clientOf));
    } else if (cmd === "symbol") {
        // symbol <query> [python|cpp|bash|typescript] [--include definition,hover,references] [--kinds function,method] [--name-pattern <regexp>]
        const langArg = rest.find(
            (a) =>
                /^[a-z]+$/.test(a) &&
                a !== rest[0] &&
                !["--include", "--kinds", "--name-pattern"].includes(a),
        );
        const query = rest[0];
        if (!query) usage();
        const params = { query };
        // Optional --include <comma list of definition|hover|references>
        const includeIdx = rest.indexOf("--include");
        if (includeIdx >= 0) {
            const val = rest[includeIdx + 1] ?? "";
            const list = val
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
            const valid = ["definition", "hover", "references"];
            const include = list.filter((s) => valid.includes(s));
            if (include.length > 0) params.include = include;
        }
        // Optional --kinds <comma list of friendly kind names>
        const kindsIdx = rest.indexOf("--kinds");
        if (kindsIdx >= 0) {
            const val = rest[kindsIdx + 1] ?? "";
            params.kinds = val
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
        }
        // Optional --name-pattern <regexp>
        const namePatternIdx = rest.indexOf("--name-pattern");
        if (namePatternIdx >= 0) {
            params.name_pattern = rest[namePatternIdx + 1];
            if (!params.name_pattern) throw new Error("--name-pattern requires a regexp argument");
        }
        // Optional language (positional after query, not a flag).
        const flags = new Set(["--include", "--kinds", "--name-pattern"]);
        const flagVals = new Set([
            rest[includeIdx + 1],
            rest[kindsIdx + 1],
            rest[namePatternIdx + 1],
        ]);
        const langCandidate = rest
            .slice(1)
            .find(
                (a) =>
                    !a.startsWith("--") &&
                    a !== query &&
                    !flags.has(a) &&
                    !flagVals.has(a) &&
                    ["python", "cpp", "bash", "typescript"].includes(a),
            );
        if (langCandidate) params.language = langCandidate;
        console.log(await nav.symbol(params, ROOT, clientOf));
    } else if (cmd === "scan") {
        // scan <file> [<startLine> <endLine>] [--pattern <re>] [--docs] [--roles ...]
        // With no line range, scan the whole file. --pattern filters by name.
        const wantDocs = rest.includes("--docs");
        const rolesArg = rest.find((a) => a.startsWith("--roles"));
        let roles;
        if (rolesArg) {
            const val = rolesArg.includes("=") ? rolesArg.slice(rolesArg.indexOf("=") + 1) : "";
            const list = val
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
            const valid = ["type", "call", "member", "import", "var"];
            roles = list.filter((r) => valid.includes(r));
            if (roles.length === 0)
                throw new Error(`--roles: expected a comma list from ${valid.join(",")}`);
        }
        let pattern;
        const patIdx = rest.indexOf("--pattern");
        if (patIdx >= 0) {
            pattern = rest[patIdx + 1];
            if (!pattern) throw new Error("--pattern requires a regexp argument");
        }
        // Positional args: path, optionally startLine + endLine. Strip flags and
        // the --pattern value from the positional set so they aren't parsed as
        // path/line numbers.
        const isFlaglike = (a) => a === "--docs" || a.startsWith("--roles") || a === "--pattern";
        const positional = rest.filter((a, i) => {
            if (a === "--pattern") return false;
            if (i > 0 && rest[i - 1] === "--pattern") return false;
            return !isFlaglike(a);
        });
        if (positional.length !== 1 && positional.length !== 3) usage();
        const [path, startStr, endStr] = positional;
        const params = { path, roles, include_docs: wantDocs, pattern };
        if (positional.length === 3) {
            const startLine = parseInt(startStr, 10),
                endLine = parseInt(endStr, 10);
            if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) usage();
            params.startLine = startLine;
            params.endLine = endLine;
        }
        console.log(await nav.scan(params, ROOT, clientOf));
    } else if (cmd === "diagnostics") {
        const [path] = rest;
        if (!path) usage();
        console.log(await nav.diagnostics({ path }, ROOT, clientOf));
    } else {
        usage();
    }
}

try {
    await main();
} catch (e) {
    console.error("FAILED:", e);
    process.exitCode = 1;
} finally {
    await shutdownAll();
}
