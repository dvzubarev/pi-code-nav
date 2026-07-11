// End-to-end test helpers: spin up real LSP clients and call the nav.* tool
// implementations through them — the exact code path index.ts uses.
//
// Unlike the unit tests (test/helpers.mjs, which load only tree-sitter-parse.ts),
// these tests exercise the FULL pipeline: nav.* → LspClient → real language
// server → render.ts → rendered text string. A real server must be on PATH
// (ty/pyright for python, ccls for cpp, typescript-language-server for TS,
// bash-language-server for bash — provided by the project nix shell).
//
// Tests that import from here are SKIPPED automatically when CODE_NAV_SKIP_E2E
// is set (CI without language servers) or when the first server fails to spawn.
// This keeps `npm test` green on machines without servers while `npm run
// test:e2e` runs the full suite on machines that have them.

import { createJiti } from "/home/denin/.npm-local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

export const EXT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

const jiti = createJiti(EXT_DIR, { cache: false, interopDefault: true });
const { LspClient, resolveConfig } = await jiti.import("./lsp-client.ts");
export const nav = await jiti.import("./nav.ts");

export const SHOULD_RUN_E2E = !process.env.CODE_NAV_SKIP_E2E;

/**
 * Create an isolated temp workspace, copy the named fixture files into it,
 * and return a { root, clientOf, cleanup } bundle. `clientOf` is a
 * ClientProvider backed by real LspClients scoped to `root`. All spawned
 * clients are shut down in `cleanup()`.
 *
 * @param {string[]} fixtureNames - filenames under test/fixtures/ to copy in
 *   (relative paths are preserved; subdirs created as needed).
 */
export async function withWorkspace(fixtureNames = []) {
	const root = await mkdtemp(resolve(tmpdir(), "code-nav-e2e-"));
	const toShutdown = [];
	const clients = new Map();

	// Copy fixtures into the temp root.
	for (const name of fixtureNames) {
		const src = resolve(FIXTURES_DIR, name);
		const dst = resolve(root, name);
		const { dirname: d } = await import("node:path");
		await mkdir(resolve(root, d(name)), { recursive: true });
		const { readFile } = await import("node:fs/promises");
		await writeFile(dst, await readFile(src, "utf8"), "utf8");
	}

	const clientOf = async (lang) => {
		let c = clients.get(lang);
		if (!c) {
			c = new LspClient(lang, root, resolveConfig(lang));
			clients.set(lang, c);
			toShutdown.push(c);
		}
		await c.ensureReady();
		return c;
	};

	return {
		root,
		clientOf,
		async cleanup() {
			await Promise.allSettled(toShutdown.map((c) => c.shutdown()));
			clients.clear();
			await rm(root, { recursive: true, force: true });
		},
	};
}

/**
 * Probe whether a server for `lang` can be spawned in this environment.
 * Returns true if the server starts and responds to initialize. Used by tests
 * to skip themselves gracefully when a server isn't installed (e.g. bash).
 */
export async function serverAvailable(lang, cwd) {
	try {
		const c = new LspClient(lang, cwd ?? tmpdir(), resolveConfig(lang));
		await c.ensureReady();
		await c.shutdown();
		// Give the child process a moment to flush + exit so its stdio streams
		// close cleanly before the test harness checks for lingering async
		// activity (otherwise node:test reports ERR_STREAM_DESTROYED).
		await new Promise((r) => setTimeout(r, 50));
		return true;
	} catch {
		return false;
	}
}
