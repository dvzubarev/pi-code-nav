// TypeScript diagnostics are unsupported; CLI guidance needs no language server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { load } from "./helpers.mjs";

const { diagnostics } = await load("./src/diagnostics.ts");
const prefix = "TypeScript/JavaScript diagnostics are unsupported by code_diagnostics. Run:\n";
const noClient = async () => assert.fail("must not start or query a language server");

async function workspace(t) {
    const root = await mkdtemp(resolve(tmpdir(), "code-nav-ts-diagnostics-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

async function commandFor(path, cwd) {
    let message;
    await assert.rejects(diagnostics({ path }, cwd, noClient), (error) => {
        message = error.message;
        assert.ok(message.startsWith(prefix), message);
        return true;
    });
    return message.slice(prefix.length);
}

for (const ext of ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]) {
    test(`diagnostics rejects .${ext} without a server and gives a project CLI command`, async (t) => {
        const root = await workspace(t);
        await writeFile(resolve(root, "tsconfig.json"), "{}");
        await writeFile(resolve(root, `file.${ext}`), "export const x = 42;\n");
        assert.equal(
            await commandFor(`file.${ext}`, root),
            `cd '${root}' && npx tsc --noEmit --pretty false -p tsconfig.json`,
        );
    });
}

test("diagnostics uses the nearest target config even outside the session cwd", async (t) => {
    const root = await workspace(t);
    const project = resolve(root, "nested");
    const source = resolve(project, "src");
    await mkdir(source, { recursive: true });
    await writeFile(resolve(root, "tsconfig.json"), "{}");
    await writeFile(resolve(project, "tsconfig.json"), "{}");
    const file = resolve(source, "file.ts");
    await writeFile(file, "export const x = 42;\n");
    assert.equal(
        await commandFor(file, tmpdir()),
        `cd '${project}' && npx tsc --noEmit --pretty false -p tsconfig.json`,
    );
});

test("diagnostics falls back to an explicit file when there is no tsconfig", async (t) => {
    const root = await workspace(t);
    for (const [ext, flags] of [
        ["ts", ""],
        ["tsx", " --jsx preserve"],
        ["js", " --allowJs --checkJs"],
        ["jsx", " --allowJs --checkJs --jsx preserve"],
        ["mjs", " --allowJs --checkJs"],
        ["cjs", " --allowJs --checkJs"],
    ]) {
        const file = `file.${ext}`;
        await writeFile(resolve(root, file), "export const x = 42;\n");
        assert.equal(
            await commandFor(file, root),
            `cd '${root}' && npx tsc --noEmit --pretty false${flags} '${file}'`,
        );
    }
});

test("CLI guidance safely quotes directories and filenames", async (t) => {
    const root = await workspace(t);
    const project = resolve(root, "project's files");
    await mkdir(project);
    const file = "file's name.ts";
    await writeFile(resolve(project, file), "export const x = 42;\n");
    for (const configured of [false, true]) {
        if (configured) await writeFile(resolve(project, "tsconfig.json"), "{}");
        const command = await commandFor(resolve(project, file), tmpdir());
        // Intercept npx rather than running the compiler or installing anything.
        const result = spawnSync(
            "bash",
            ["-c", `npx() { printf '%s\\0' "$PWD" "$@"; }; ${command}`],
            { encoding: "utf8" },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(result.stdout.split("\0").slice(0, -1), [
            project,
            "tsc",
            "--noEmit",
            "--pretty",
            "false",
            ...(configured ? ["-p", "tsconfig.json"] : [file]),
        ]);
    }
});
