/**
 * WorkspaceEdit filesystem application — writing LSP WorkspaceEdit / TextEdit
 * results to disk.
 *
 * Split out of `render.ts` (see docs/MAINTAINER.md): `render.ts` is now purely
 * output formatting with no filesystem or LSP dependency, while the functions
 * here read and write files on disk. Keeping them separate makes the dependency
 * boundary explicit. Used by code_rename to persist a rename's edits.
 *
 * LSP lines/characters are 0-based; this module applies them as-is to the file
 * contents.
 */

import { readFile, writeFile } from "node:fs/promises";
import type { WorkspaceEdit } from "vscode-languageserver-protocol";
import { uriToPath } from "./render";

export interface AppliedFile {
    path: string;
    edits: number;
}

export type TextEditShape = {
    range?: {
        start?: { line?: number; character?: number };
        end?: { line?: number; character?: number };
    };
    newText?: string;
};

export async function applyWorkspaceEdit(edit: WorkspaceEdit): Promise<AppliedFile[]> {
    const applied: AppliedFile[] = [];
    // documentChanges (preferred) — may contain TextDocumentEdit / CreateFile / etc.
    const docChanges = (edit as { documentChanges?: unknown[] }).documentChanges;
    if (Array.isArray(docChanges)) {
        for (const ch of docChanges) {
            const tde = ch as {
                textDocument?: { uri?: string };
                edits?: TextEditShape[];
                kind?: string;
            };
            if (tde.textDocument && Array.isArray(tde.edits)) {
                const path = uriToPath(tde.textDocument.uri ?? "");
                const edits = await applyTextEdits(path, tde.edits);
                if (edits > 0) applied.push({ path, edits });
            }
            // CreateFile / DeleteFile / RenameFile are reported but not auto-applied.
        }
    }
    // changes (legacy) — { uri: TextEdit[] }
    const changes = (edit as { changes?: Record<string, unknown[]> }).changes;
    if (changes) {
        for (const [uri, edits] of Object.entries(changes)) {
            const path = uriToPath(uri);
            const n = await applyTextEdits(path, edits as TextEditShape[]);
            if (n > 0) applied.push({ path, edits: n });
        }
    }
    return applied;
}

/** Apply TextEdits to a file on disk. LSP lines are 0-based. */
export async function applyTextEdits(path: string, edits: TextEditShape[]): Promise<number> {
    if (edits.length === 0) return 0;
    let text: string;
    try {
        text = await readFile(path, "utf8");
    } catch {
        return 0;
    }
    // Split preserving line endings; use a flat line array for offset math.
    const lines = text.split(/\r?\n/);
    // Sort edits in reverse so earlier offsets stay valid.
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