// End-to-end TypeScript outline scenarios.

import assert from "node:assert/strict";
import { nav, resolve, runOrSkip, withWorkspace, writeFile } from "./typescript-helpers.mjs";

runOrSkip(
    "code_outline on a .ts file fetches signatures via parallel hover (detail empty)",
    async () => {
        // tsserver leaves DocumentSymbol.detail empty, so code_outline falls
        // back to one LSP hover per row (fired in parallel via Promise.all —
        // JSON-RPC over stdio supports concurrent in-flight requests). The
        // hover signature becomes the signature column. This is the path where
        // the per-row hover cost lives; the default limit (20) bounds it.
        const ws = await withWorkspace([]);
        try {
            const file = resolve(ws.root, "svc.ts");
            await writeFile(
                file,
                [
                    `const NOISE = 1;`,
                    `export function greet(name: string): string { return name; }`,
                    `export class Service {`,
                    `  constructor(private id: number) {}`,
                    `  getId(): number { return this.id; }`,
                    `}`,
                    ``,
                ].join("\n"),
                "utf8",
            );
            const out = await nav.outline({ path: "svc.ts" }, ws.root, ws.clientOf);
            // Multi-line blocks: header on line 1, then `  signature:` sub-line.
            assert.match(
                out,
                /^Class Service  .*\.ts:\d+:\d+  range=\d+-\d+$/m,
                `Service header missing:\n${out}`,
            );
            // Its direct members are kept (indented).
            assert.match(
                out,
                /^  Method getId  .*\.ts:\d+:\d+  range=\d+-\d+$/m,
                `getId header missing:\n${out}`,
            );
            // NOISE (Constant, kind 14) is dropped by the outline allowlist.
            assert.ok(
                !/NOISE/.test(out),
                `NOISE should be dropped (not a structural kind):\n${out}`,
            );
            // The parameter property `id` is a Property (kind 7), also dropped
            // by the allowlist (see OUTLINE_KEEP_KINDS — Property/Field are
            // dropped because tsserver emits them for object-literal keys too).
            assert.ok(
                !/Property id/.test(out),
                `id should be dropped (Property not kept):\n${out}`,
            );
            // greet (Function) IS kept (it's a structural kind).
            assert.match(
                out,
                /^Function greet  .*\.ts:\d+:\d+  range=\d+-\d+$/m,
                `greet header missing:\n${out}`,
            );
        } finally {
            await ws.cleanup();
        }
    },
);
