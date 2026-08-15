// Direct unit tests for src/lsp/server-config.ts resolution semantics.
//
// resolveConfig returns a stable `serverKind` so LspClient never guesses a
// server from a command path. These tests pin that contract WITHOUT spawning
// any language servers and WITHOUT depending on what is installed on PATH
// (unlike the older resolveConfig("python") assertion in lsp-client.test.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "/home/denin/.npm-local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const EXT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(EXT_DIR, { cache: false, interopDefault: true });
const { resolveConfig, commandExists } = await jiti.import("./src/lsp/server-config.ts");

// ---------------------------------------------------------------------------
// Default resolution (no overrides) — stable per-language identity.
// ---------------------------------------------------------------------------

test("default configs carry their canonical serverKind", () => {
    const expected = {
        cpp: "ccls",
        python: "ty",
        bash: "bash-language-server",
        typescript: "typescript-language-server",
    };
    for (const [lang, kind] of Object.entries(expected)) {
        const cfg = resolveConfig(lang);
        assert.equal(cfg.serverKind, kind, `default serverKind for ${lang}`);
        assert.ok(cfg.command, `default command for ${lang} is non-empty`);
        assert.ok(Array.isArray(cfg.args), `default args for ${lang} is an array`);
        assert.equal(typeof cfg.initOptions, "object", `default initOptions for ${lang}`);
    }
});

// ---------------------------------------------------------------------------
// args/initOptions-only overrides preserve the resolved kind.
// ---------------------------------------------------------------------------

test("args-only override preserves the default server kind", () => {
    const cfg = resolveConfig("cpp", { cpp: { args: ["--debug"] } });
    assert.equal(cfg.command, "ccls");
    assert.deepEqual(cfg.args, ["--debug"]);
    assert.equal(cfg.serverKind, "ccls");
});

test("initOptions-only override merges one level deep and preserves kind", () => {
    const cfg = resolveConfig("typescript", {
        typescript: { initOptions: { hostInfo: "custom-host" } },
    });
    assert.equal(cfg.serverKind, "typescript-language-server");
    assert.equal(cfg.initOptions.hostInfo, "custom-host");
});

// ---------------------------------------------------------------------------
// Replacement command becomes custom.
// ---------------------------------------------------------------------------

test("a different command replaces the server and becomes custom", () => {
    const cfg = resolveConfig("cpp", { cpp: { command: "clangd" } });
    assert.equal(cfg.command, "clangd");
    assert.equal(cfg.serverKind, "custom");
});

test("a different bash command becomes custom", () => {
    const cfg = resolveConfig("bash", { bash: { command: "shfmt-lsp" } });
    assert.equal(cfg.command, "shfmt-lsp");
    assert.equal(cfg.serverKind, "custom");
});

// ---------------------------------------------------------------------------
// Explicit canonical Python commands are recognized by stable identity.
// ---------------------------------------------------------------------------

test('explicit canonical Python command "ty" keeps ty readiness', () => {
    const cfg = resolveConfig("python", { python: { command: "ty" } });
    assert.equal(cfg.command, "ty");
    assert.equal(cfg.serverKind, "ty");
    assert.equal(cfg.initOptions.diagnosticMode, "workspace", "ty opts into workspace diagnostics");
});

test('explicit canonical Python command "pyright-langserver" resolves to pyright', () => {
    const cfg = resolveConfig("python", { python: { command: "pyright-langserver" } });
    assert.equal(cfg.command, "pyright-langserver");
    assert.equal(cfg.serverKind, "pyright");
});

// ---------------------------------------------------------------------------
// Custom Python servers keep pyright defaults and become custom.
// ---------------------------------------------------------------------------

test("custom Python server command becomes custom without ty/pyright identity", () => {
    const cfg = resolveConfig("python", { python: { command: "basedpyright-langserver" } });
    assert.equal(cfg.command, "basedpyright-langserver");
    assert.equal(cfg.serverKind, "custom");
});

// ---------------------------------------------------------------------------
// Explicit adapter identity (`serverKind`) is the escape hatch for
// absolute/custom paths to a known server.
// ---------------------------------------------------------------------------

test("explicit serverKind overrides classification for an absolute ty path", () => {
    const absTy = resolve("/somewhere/bin/ty");
    const cfg = resolveConfig("python", { python: { command: absTy, serverKind: "ty" } });
    assert.equal(cfg.command, absTy);
    assert.equal(cfg.serverKind, "ty");
});

test("explicit serverKind overrides classification for an absolute ccls path", () => {
    const absCcls = resolve("/somewhere/bin/ccls");
    const cfg = resolveConfig("cpp", { cpp: { command: absCcls, serverKind: "ccls" } });
    assert.equal(cfg.command, absCcls);
    assert.equal(cfg.serverKind, "ccls");
});

test("explicit serverKind pairs with an absolute pyright path", () => {
    const absPyright = resolve("/somewhere/bin/pyright-langserver");
    const cfg = resolveConfig("python", {
        python: { command: absPyright, serverKind: "pyright" },
    });
    assert.equal(cfg.command, absPyright);
    assert.equal(cfg.serverKind, "pyright");
});

// ---------------------------------------------------------------------------
// Python explicit command merges args from the opted-in server base.
// ---------------------------------------------------------------------------

test('explicit "ty" command inherits ty args when args not overridden', () => {
    const cfg = resolveConfig("python", { python: { command: "ty" } });
    assert.deepEqual(cfg.args, ["server"]);
});

test('explicit "pyright-langserver" command inherits pyright args when args not overridden', () => {
    const cfg = resolveConfig("python", { python: { command: "pyright-langserver" } });
    assert.deepEqual(cfg.args, ["--stdio"]);
});

// ---------------------------------------------------------------------------
// initOptions merging for the python explicit-command branch.
// ---------------------------------------------------------------------------

test("explicit ty command merges initOptions over ty defaults (only ty keys)", () => {
    const cfg = resolveConfig("python", {
        python: { command: "ty", initOptions: { diagnosticMode: "openFilesOnly" } },
    });
    assert.equal(cfg.serverKind, "ty");
    assert.equal(cfg.initOptions.diagnosticMode, "openFilesOnly");
});

test("explicit pyright command merges initOptions over pyright defaults", () => {
    const cfg = resolveConfig("python", {
        python: { command: "pyright-langserver", initOptions: { multiRoot: true } },
    });
    assert.equal(cfg.serverKind, "pyright");
    assert.equal(cfg.initOptions.multiRoot, true);
    assert.equal(cfg.initOptions.useLibraryCodeForTypes, true);
});

// ---------------------------------------------------------------------------
// commandExists remains deterministic and memoized for these tests.
// ---------------------------------------------------------------------------

test("commandExists returns a boolean", () => {
    assert.equal(typeof commandExists("sh"), "boolean");
});
