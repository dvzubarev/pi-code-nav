import { SOURCE_EXTS } from "./languages/catalog";
import type { ServerKind } from "./lsp/server-config";

export type ProgressToken = string | number;
export interface WorkDoneProgressParams {
    token?: ProgressToken;
    value?: { kind?: string };
}

/**
 * Generic operations a project-readiness policy can ask of its host. The host
 * (LspClient) is deliberately transport-bound here: it owns the connection,
 * the document table, and the bootstrap scan, but it does NOT know what any
 * given language server considers "ready" — each policy owns that.
 */
export interface ProjectHost {
    /** Whether any document has been opened on this server yet. */
    hasOpenDocuments(): boolean;
    /** Find the first source file matching `extensions` under the workspace root. */
    findBootstrapFile(extensions: readonly string[]): Promise<string | null>;
    /** Read the file from disk and open it on the server (didOpen). */
    openDocument(path: string): Promise<void>;
    /** Send an LSP request. Omit `timeoutMs` for long-polling requests. */
    request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
}

/**
 * Project-readiness policy. One implementation per language/server pair:
 *
 *   - `NoopProjectReadiness`       — pyright, custom servers (no warm-up).
 *   - `TypeScriptProjectReadiness` — bootstrap didOpen + work-done begin/end.
 *   - `CppProjectReadiness`        — bootstrap didOpen + `$ccls/info` polling.
 *   - `BashProjectReadiness`       — window/logMessage BackgroundAnalysis.
 *   - `TyProjectReadiness`         — workspace/diagnostic + work-done end.
 *
 * The policy receives otherwise language-agnostic protocol events (work-done
 * create, `$/progress`, log messages, document sync) and interprets only the
 * ones it cares about. It is instantiated by `createProjectReadiness()` once
 * per client, so the transport layer never branches on language identity.
 */
export interface ProjectReadiness {
    onWorkDoneCreate(token: ProgressToken | undefined): void;
    onProgress(params: WorkDoneProgressParams): void;
    onLogMessage(message: string | undefined): void;
    onDocumentSynced(path: string): void;

    /** Establish workspace-level readiness. Returns false if no source file exists. */
    ensureWorkspaceReady(host: ProjectHost): Promise<boolean>;
    /** Establish readiness for a single document (which callers open first). */
    ensureDocumentReady(host: ProjectHost, path: string): Promise<void>;

    reset(): void;
}

function timeoutFromEnv(name: string, fallback: number): number {
    const configured = Number.parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

/**
 * Standard LSP work-done progress tracker backed by window/workDoneProgress/
 * create and $/progress. This is shared machinery (token lifetimes + the
 * begin/end wait with a start/end timeout split), not a readiness policy on
 * its own. The TypeScript and ty policies embed it; ccls observes it but only
 * trusts $ccls/info for completion.
 */
export class WorkDoneProgress {
    private registered = new Set<string>();
    private active = new Set<string>();
    private currentRevision = 0;
    private waiters = new Set<() => void>();
    protected readonly label: string;

    constructor(label = "Project loading") {
        this.label = label;
    }

    private key(token: ProgressToken): string {
        return `${typeof token}:${token}`;
    }

    protected signalChange(): void {
        this.currentRevision++;
        const waiters = [...this.waiters];
        this.waiters.clear();
        for (const resolve of waiters) resolve();
    }

    onWorkDoneCreate(token: ProgressToken | undefined): void {
        if (token === undefined) return;
        this.registered.add(this.key(token));
        this.signalChange();
    }

    onProgress(params: WorkDoneProgressParams): void {
        if (params.token === undefined) return;
        const key = this.key(params.token);
        if (params.value?.kind === "begin") {
            // Be tolerant of servers and client-provided tokens that skip create.
            this.registered.add(key);
            this.active.add(key);
            this.signalChange();
        } else if (params.value?.kind === "end") {
            this.active.delete(key);
            this.registered.delete(key);
            this.signalChange();
        }
    }

    revision(): number {
        return this.currentRevision;
    }

    hasPendingWork(): boolean {
        return this.registered.size > 0 || this.active.size > 0;
    }

    private async waitForChange(revision: number, timeoutMs: number): Promise<void> {
        if (this.currentRevision !== revision || timeoutMs <= 0) return;
        await new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.waiters.delete(finish);
                resolve();
            };
            const timer = setTimeout(finish, timeoutMs);
            this.waiters.add(finish);
            // Close the check-to-registration race.
            if (this.currentRevision !== revision) finish();
        });
    }

    /**
     * Wait for any work-done interval created after `revision`: first a short
     * start wait that tolerates a gap before `begin`, then an end wait bounded
     * by `endMs`. If no work ever starts (e.g. a warm cache with no progress),
     * the start deadline returns cleanly rather than waiting the full budget.
     */
    async waitForWorkDoneSince(revision: number, startMs = 1000, endMs = 60_000): Promise<void> {
        const startTimeout = timeoutFromEnv("CODE_NAV_PROJECT_LOAD_START_TIMEOUT_MS", startMs);
        const endTimeout = timeoutFromEnv("CODE_NAV_PROJECT_LOAD_END_TIMEOUT_MS", endMs);
        const startDeadline = Date.now() + startTimeout;

        while (this.currentRevision === revision && !this.hasPendingWork()) {
            const remaining = startDeadline - Date.now();
            if (remaining <= 0) return;
            await this.waitForChange(revision, remaining);
        }

        const endDeadline = Date.now() + endTimeout;
        while (this.hasPendingWork()) {
            const remaining = endDeadline - Date.now();
            if (remaining <= 0) throw new Error(`${this.label} timed out after ${endTimeout}ms`);
            const before = this.currentRevision;
            await this.waitForChange(before, remaining);
        }
    }

    async waitUntilReady(): Promise<void> {
        if (this.hasPendingWork()) await this.waitForWorkDoneSince(this.currentRevision);
    }

    reset(): void {
        this.registered.clear();
        this.active.clear();
        this.signalChange();
    }
}

class NoopProjectReadiness implements ProjectReadiness {
    onWorkDoneCreate(): void {}
    onProgress(): void {}
    onLogMessage(): void {}
    onDocumentSynced(): void {}
    async ensureWorkspaceReady(): Promise<boolean> {
        return true;
    }
    async ensureDocumentReady(): Promise<void> {}
    reset(): void {}
}

/**
 * tsserver loads a project lazily on the first didOpen, reporting the load as
 * a standard work-done begin/end interval. DidOpen is not itself a barrier, so
 * the policy snapshots the tracker revision BEFORE the bootstrap open and then
 * waits for the matching interval. Once any document is open the project is
 * loaded; subsequent opens need no wait.
 */
class TypeScriptProjectReadiness implements ProjectReadiness {
    private readonly progress = new WorkDoneProgress("TypeScript project loading");

    onWorkDoneCreate(token: ProgressToken | undefined): void {
        this.progress.onWorkDoneCreate(token);
    }

    onProgress(params: WorkDoneProgressParams): void {
        this.progress.onProgress(params);
    }

    onLogMessage(): void {}

    onDocumentSynced(): void {}

    async ensureWorkspaceReady(host: ProjectHost): Promise<boolean> {
        if (host.hasOpenDocuments()) {
            if (this.progress.hasPendingWork()) await this.progress.waitUntilReady();
            return true;
        }
        const file = await host.findBootstrapFile(SOURCE_EXTS.typescript);
        if (!file) return false;
        const before = this.progress.revision();
        try {
            await host.openDocument(file);
        } catch {
            return false;
        }
        await this.progress.waitForWorkDoneSince(before);
        return true;
    }

    async ensureDocumentReady(_host: ProjectHost, _path: string): Promise<void> {
        // Per-file queries open the target document BEFORE this is called
        // (awaitReadyForQuery), so there is no observable pre-open snapshot
        // point here and the cold revision-before-open branch could never
        // execute in production. tsserver's lazy bootstrap load — including
        // the revision-before-open wait — is owned by ensureWorkspaceReady().
        // Per-file readiness is therefore a no-op, matching the pre-policy
        // behavior: document opens load the project naturally.
    }

    reset(): void {
        this.progress.reset();
    }
}

/**
 * ccls readiness is authoritative only through its $ccls/info pipeline
 * counters (completed/enqueued) — it can omit a $/progress begin/end pair for
 * a single-TU batch. The policy still observes progress so `in_progress` is
 * recorded as a hint, but completion is a poll that requires two stable idle
 * samples (so the final queued database update reaches the query DB).
 * Bootstrap: ccls only indexes after a didOpen, so open one source file.
 * A document change/sync invalidates the established-idle state so a fresh
 * didChange re-index is awaited.
 */
class CppProjectReadiness implements ProjectReadiness {
    private readonly progress = new WorkDoneProgress("C++ indexing");
    private state: "idle" | "in_progress" | "ended" = "idle";
    // Bumped whenever new indexing may have been enqueued (a document sync or
    // an `index` begin). `pollPipeline` snapshots this and restarts its
    // two-stable-idle-samples requirement whenever the generation changes, so
    // an invalidation landing mid-poll cannot be satisfied by stale samples
    // taken before the new queue was visible to $ccls/info.
    private invalidationGeneration = 0;
    private poll: Promise<void> | null = null;

    onWorkDoneCreate(token: ProgressToken | undefined): void {
        this.progress.onWorkDoneCreate(token);
    }

    onProgress(params: WorkDoneProgressParams): void {
        this.progress.onProgress(params);
        if (params.token !== "index") return;
        if (params.value?.kind === "begin") {
            this.state = "in_progress";
            this.invalidationGeneration++;
        } else if (params.value?.kind === "end") this.state = "idle";
    }

    onLogMessage(): void {}

    onDocumentSynced(): void {
        // A didChange can enqueue fresh indexing work; drop the "ended"
        // completed cache and bump the invalidation generation so an in-flight
        // poll restarts its idle-samples requirement rather than completing on
        // counts sampled before the new queue was visible.
        this.state = "idle";
        this.invalidationGeneration++;
    }

    async ensureWorkspaceReady(host: ProjectHost): Promise<boolean> {
        if (!host.hasOpenDocuments()) {
            const file = await host.findBootstrapFile(SOURCE_EXTS.cpp);
            if (!file) return false;
            try {
                await host.openDocument(file);
            } catch {
                return false;
            }
            // didOpen can enqueue fresh indexing work.
            this.state = "idle";
            this.invalidationGeneration++;
        }
        await this.ensureIndexed(host);
        return true;
    }

    async ensureDocumentReady(host: ProjectHost, _path: string): Promise<void> {
        await this.ensureIndexed(host);
    }

    private ensureIndexed(host: ProjectHost): Promise<void> {
        // "ended" is the only sticky readiness cache. `poll` is in-flight
        // deduplication ONLY — it must not survive into a subsequent stale
        // read after the poll has settled (a later $/progress begin or a
        // document sync invalidates `state`, and the next call must re-poll).
        if (this.state === "ended") return Promise.resolve();
        if (this.poll) return this.poll;
        this.poll = this.pollPipeline(host).then(
            () => {
                this.poll = null;
            },
            (error) => {
                this.poll = null;
                throw error;
            },
        );
        return this.poll;
    }

    private async pollPipeline(host: ProjectHost, endMs = 60_000): Promise<void> {
        const endTimeout = timeoutFromEnv("CODE_NAV_INDEX_END_TIMEOUT_MS", endMs);
        if (this.state === "ended") return;
        const deadline = Date.now() + endTimeout;
        let idleEnqueued: number | undefined;
        let generation = this.invalidationGeneration;
        while (Date.now() < deadline) {
            const remaining = Math.max(1, deadline - Date.now());
            const raw = (await host.request("$ccls/info", undefined, remaining)) as {
                pipeline?: { completed?: number; enqueued?: number };
            };
            // An invalidation (document sync or index begin) may have arrived
            // while the request was in flight. Require two stable idle samples
            // sampled AFTER the latest invalidation.
            if (this.invalidationGeneration !== generation) {
                generation = this.invalidationGeneration;
                idleEnqueued = undefined;
            }
            const completed = raw?.pipeline?.completed;
            const enqueued = raw?.pipeline?.enqueued;
            if (typeof completed !== "number" || typeof enqueued !== "number") {
                throw new Error("ccls returned invalid $ccls/info pipeline statistics");
            }
            if (completed === enqueued) {
                if (idleEnqueued === enqueued) {
                    this.state = "ended";
                    return;
                }
                idleEnqueued = enqueued;
            } else {
                this.state = "in_progress";
                idleEnqueued = undefined;
            }
            await new Promise<void>((resolve) =>
                setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))),
            );
        }
        throw new Error(`ccls indexing timed out after ${endTimeout}ms`);
    }

    reset(): void {
        this.progress.reset();
        this.state = "idle";
        this.invalidationGeneration = 0;
        this.poll = null;
    }
}

/**
 * bash-language-server reports its workspace scan only through window/logMessage.
 * The barrier is launch-triggered (the scan starts from `initialized`), not
 * document-triggered, so per-document readiness is a no-op; workspace queries
 * await the log-message completion.
 */
class BashProjectReadiness implements ProjectReadiness {
    private state: "idle" | "in_progress" | "ended" = "idle";
    private stateRevision = 0;
    private stateWaiters = new Set<() => void>();
    private barrier: Promise<void> | null = null;

    onWorkDoneCreate(): void {}
    onProgress(): void {}

    onLogMessage(message: string | undefined): void {
        if (!message) return;
        if (message.includes("BackgroundAnalysis: resolving glob")) {
            this.state = "in_progress";
            this.signalStateChange();
        } else if (
            message.includes("BackgroundAnalysis: Completed") ||
            message.includes("BackgroundAnalysis: skipping") ||
            message.includes("BackgroundAnalysis: failed resolved glob")
        ) {
            this.state = "ended";
            this.signalStateChange();
        }
    }

    onDocumentSynced(): void {}

    private signalStateChange(): void {
        this.stateRevision++;
        const waiters = [...this.stateWaiters];
        this.stateWaiters.clear();
        for (const resolve of waiters) resolve();
    }

    private async waitForStateChange(revision: number, timeoutMs: number): Promise<void> {
        if (this.stateRevision !== revision || timeoutMs <= 0) return;
        await new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.stateWaiters.delete(finish);
                resolve();
            };
            const timer = setTimeout(finish, timeoutMs);
            this.stateWaiters.add(finish);
            if (this.stateRevision !== revision) finish();
        });
    }

    async ensureWorkspaceReady(_host: ProjectHost): Promise<boolean> {
        // Only a confirmed "ended" completion is sticky. Everything else —
        // including a soft "start not observed" outcome — must be re-checked
        // on the next workspace query, because the scan can start after the
        // start window has already elapsed.
        if (this.state === "ended") return true;
        // In-flight dedup: concurrent workspace queries share one wait.
        if (this.barrier) return this.barrier.then(() => true);
        this.barrier = this.waitForBackgroundAnalysis().then(
            () => {
                if (this.state !== "ended") this.barrier = null;
            },
            (error) => {
                this.barrier = null;
                throw error;
            },
        );
        await this.barrier;
        return true;
    }

    // No per-document barrier: BackgroundAnalysis is a workspace scan that
    // already completed (or was awaited) before document queries matter.
    async ensureDocumentReady(): Promise<void> {}

    private async waitForBackgroundAnalysis(startMs = 1000, endMs = 60_000): Promise<void> {
        if (this.state === "ended") return;
        const startTimeout = timeoutFromEnv("CODE_NAV_PROJECT_LOAD_START_TIMEOUT_MS", startMs);
        const endTimeout = timeoutFromEnv("CODE_NAV_PROJECT_LOAD_END_TIMEOUT_MS", endMs);
        if (this.state === "idle") {
            const before = this.stateRevision;
            await this.waitForStateChange(before, startTimeout);
            // Info logs can be disabled by the server configuration.
            if (this.state === "idle") return;
        }
        const deadline = Date.now() + endTimeout;
        while (this.state === "in_progress") {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new Error(`Bash workspace indexing timed out after ${endTimeout}ms`);
            }
            await this.waitForStateChange(this.stateRevision, remaining);
        }
    }

    reset(): void {
        this.state = "idle";
        this.barrier = null;
        this.signalStateChange();
    }
}

/**
 * ty performs its whole-workspace check only when workspace/diagnostic is
 * requested, reporting standard work-done begin/end on the request's token.
 * The request may deliberately long-poll after the check completes, so the
 * progress end (or a normal response) is the completion barrier.
 */
class TyProjectReadiness implements ProjectReadiness {
    private readonly progress = new WorkDoneProgress("Python workspace checking");
    private warmup: Promise<void> | null = null;

    onWorkDoneCreate(token: ProgressToken | undefined): void {
        this.progress.onWorkDoneCreate(token);
    }

    onProgress(params: WorkDoneProgressParams): void {
        this.progress.onProgress(params);
    }

    onLogMessage(): void {}

    onDocumentSynced(): void {}

    async ensureWorkspaceReady(host: ProjectHost): Promise<boolean> {
        if (this.warmup) return this.warmup.then(() => true);
        const run = async () => {
            const before = this.progress.revision();
            const request = host.request("workspace/diagnostic", {
                identifier: "ty",
                previousResultIds: [],
                workDoneToken: `code-nav-ty-workspace-${process.pid}`,
            });
            const response = request.then(() => undefined);
            // An unchanged diagnostic request intentionally long-polls. Keep
            // it observed so shutdown/disposal never creates an unhandled
            // rejection.
            request.catch(() => {});
            await Promise.race([
                response,
                this.progress.waitForWorkDoneSince(before, 1000, 60_000),
            ]);
        };
        this.warmup = run().catch((error) => {
            this.warmup = null;
            throw error;
        });
        await this.warmup;
        return true;
    }

    // ty's answers are authoritative only after the whole workspace has been
    // checked once; reuse the single workspace warm-up.
    async ensureDocumentReady(host: ProjectHost, _path: string): Promise<void> {
        await this.ensureWorkspaceReady(host);
    }

    reset(): void {
        this.progress.reset();
        this.warmup = null;
    }
}

/**
 * Select the project-readiness policy by resolved server identity (see
 * server-config.ts). Selection is by `serverKind`, NOT by language: a
 * replacement command resolves to `"custom"` specifically so it does not
 * inherit a built-in server's quirks, while a built-in server behind an
 * explicit `serverKind` escape hatch keeps its policy.
 */
export function createProjectReadiness(serverKind: ServerKind): ProjectReadiness {
    if (serverKind === "ccls") return new CppProjectReadiness();
    if (serverKind === "typescript-language-server") return new TypeScriptProjectReadiness();
    if (serverKind === "bash-language-server") return new BashProjectReadiness();
    if (serverKind === "ty") return new TyProjectReadiness();
    return new NoopProjectReadiness(); // pyright + custom
}
