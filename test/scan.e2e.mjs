// Scenario-style coverage for the server-free tree-sitter scanner.

import { nav, SHOULD_RUN_E2E } from "./e2e-helpers.mjs";
import { matches, notMatches, scenario } from "./scenario.mjs";

const skip = !SHOULD_RUN_E2E;
const serverFree = async () => {
    throw new Error("code_scan without include_docs must not call clientOf");
};

scenario("code_scan scans a complete file without an LSP client", {
    skip,
    given: {
        files: {
            "svc.ts": `
                import { readFile } from "node:fs/promises";
                export function greet(name: string): string { return name; }
                export class Service {
                  constructor(private id: number) {}
                  getId(): number { return this.id; }
                }
            `,
        },
    },
    when: ({ root }) => nav.scan({ path: "svc.ts" }, root, serverFree),
    then: [
        matches(/Symbols in svc\.ts:1-7 /, "whole-file header missing"),
        matches(/import\s+readFile\s+:1:\d+/, "import missing"),
        matches(/type\s+Service/, "type missing"),
        matches(/member\s+getId/, "member missing"),
    ],
});

scenario("code_scan filters symbol names with a regexp", {
    skip,
    given: {
        files: {
            "svc.ts": `
                import { readFile } from "node:fs/promises";
                import { writeFile } from "node:fs/promises";
                export function greet(name: string): string { return name; }
                export class Service {
                  constructor(private id: number) {}
                  getId(): number { return this.id; }
                }
            `,
        },
    },
    when: ({ root }) => nav.scan({ path: "svc.ts", pattern: "File$" }, root, serverFree),
    then: [
        matches(/import\s+readFile\s+:1:\d+/),
        matches(/import\s+writeFile\s+:2:\d+/),
        notMatches(/type\s+Service/, "non-matching type should be removed"),
        notMatches(/member\s+getId/, "non-matching member should be removed"),
        notMatches(/greet/, "non-matching declaration should be removed"),
    ],
});

scenario("code_scan rejects an invalid regexp", {
    skip,
    given: { files: { "svc.ts": "const x = 1;" } },
    when: ({ root }) => nav.scan({ path: "svc.ts", pattern: "(" }, root, serverFree),
    error: /Invalid regexp/,
});

scenario("code_scan honors an explicit line range", {
    skip,
    given: {
        files: {
            "svc.ts": `
                import { readFile } from "node:fs/promises";
                export function greet(name: string): string { return name; }
                export class Service {
                  getId(): number { return this.id; }
                }
            `,
        },
    },
    when: ({ root }) => nav.scan({ path: "svc.ts", startLine: 1, endLine: 1 }, root, serverFree),
    then: [
        matches(/Symbols in svc\.ts:1-1 /, "range header missing"),
        matches(/import\s+readFile/, "in-range import missing"),
        notMatches(/type\s+Service/, "out-of-range type should be absent"),
    ],
});
