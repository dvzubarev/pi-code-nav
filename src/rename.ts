/**
 * code_rename — rename the symbol at (path, line, column) to `newName`,
 * applying the resulting WorkspaceEdit to disk. Edits are written directly to
 * the affected files. See docs/code_rename.md.
 */

import { readFile } from "node:fs/promises";
import {
    awaitReadyForQuery,
    ClientProvider,
    UnknownLanguageError,
    validatePosition,
} from "./nav-core";
import { applyWorkspaceEdit, langForFile, toAbs } from "./render";

export interface RenameParams {
    path: string;
    line: number;
    column: number;
    newName: string;
}

export async function rename(
    params: RenameParams,
    cwd: string,
    clientOf: ClientProvider,
): Promise<string> {
    validatePosition(params.line, params.column);
    const lang = langForFile(params.path);
    if (lang === null) throw new UnknownLanguageError(params.path);
    const abs = toAbs(params.path, cwd);
    let text: string;
    try {
        text = await readFile(abs, "utf8");
    } catch (e) {
        // Hard failure: cannot read the file. Throw so index.ts's err() sets
        // isError: true.
        throw new Error(`Cannot read ${abs}: ${e}`);
    }
    const client = await clientOf(lang);
    // Wait for ccls to finish indexing this TU before computing rename edits.
    // On a cold cache, textDocument/rename can miss cross-TU occurrences until
    // indexing finishes, producing a partial rename. No-op on a warm cache.
    await awaitReadyForQuery(lang, client, abs, text);
    const edit = await client.rename(abs, params.line - 1, params.column - 1, text, params.newName);
    const applied = await applyWorkspaceEdit(edit);
    if (applied.length === 0) return `(rename produced no edits)`;
    const lines = applied.map((f) => `${f.path}: ${f.edits} edit(s)`);
    return `Renamed to "${params.newName}". Applied:\n` + lines.join("\n");
}
