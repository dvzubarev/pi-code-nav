import type { Lang } from "./lsp-client";

export type ProgressToken = string | number;
export interface WorkDoneProgressParams {
    token?: ProgressToken;
    value?: { kind?: string };
}

export interface ProjectProgress {
    handleWorkDoneCreate(token: ProgressToken | undefined): void;
    handleProgress(params: WorkDoneProgressParams): void;
    handleLogMessage(message: string | undefined): void;
    revision(): number;
    hasPendingWork(): boolean;
    waitForWorkDoneSince(revision: number, startMs?: number, endMs?: number): Promise<void>;
    waitUntilReady(endMs?: number): Promise<void>;
    invalidate(): void;
    reset(): void;
}

type Request = (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>;
type DeferredRequest = (method: string, params: unknown) => Promise<unknown>;

function timeoutFromEnv(name: string, fallback: number): number {
    const configured = Number.parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

/** Standard LSP work-done progress tracker backed by window/workDoneProgress/create and $/progress. */
export class WorkDoneProgress implements ProjectProgress {
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

    handleWorkDoneCreate(token: ProgressToken | undefined): void {
        if (token === undefined) return;
        this.registered.add(this.key(token));
        this.signalChange();
    }

    handleProgress(params: WorkDoneProgressParams): void {
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

    handleLogMessage(_message: string | undefined): void {}

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

    invalidate(): void {}

    reset(): void {
        this.registered.clear();
        this.active.clear();
        this.signalChange();
    }
}

/**
 * ty's workspace/diagnostic request checks all project files and exposes the
 * operation through a client-supplied work-done token. The request can remain
 * open for long-polling after progress ends, so the progress lifecycle is the
 * primary readiness barrier.
 */
export class TyProjectProgress extends WorkDoneProgress {
    private warmup: Promise<void> | null = null;

    constructor(private readonly request: DeferredRequest) {
        super("Python workspace checking");
    }

    override async waitUntilReady(): Promise<void> {
        if (this.warmup) return this.warmup;
        const run = async () => {
            const before = this.revision();
            const request = this.request("workspace/diagnostic", {
                identifier: "ty",
                previousResultIds: [],
                workDoneToken: `code-nav-ty-workspace-${process.pid}`,
            });
            const response = request.then(() => undefined);
            // An unchanged diagnostic request intentionally long-polls. Keep
            // it observed so shutdown/disposal never creates an unhandled rejection.
            request.catch(() => {});
            await Promise.race([response, this.waitForWorkDoneSince(before, 1000, 60_000)]);
        };
        this.warmup = run().catch((error) => {
            this.warmup = null;
            throw error;
        });
        return this.warmup;
    }

    override reset(): void {
        super.reset();
        this.warmup = null;
    }
}

/** bash-language-server reports its workspace scan only through window/logMessage. */
export class BashProjectProgress extends WorkDoneProgress {
    private state: "idle" | "in_progress" | "ended" = "idle";
    private stateRevision = 0;
    private stateWaiters = new Set<() => void>();

    constructor() {
        super("Bash workspace indexing");
    }

    private signalStateChange(): void {
        this.stateRevision++;
        const waiters = [...this.stateWaiters];
        this.stateWaiters.clear();
        for (const resolve of waiters) resolve();
    }

    override handleLogMessage(message: string | undefined): void {
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

    override async waitUntilReady(startMs = 1000, endMs = 60_000): Promise<void> {
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

    override reset(): void {
        super.reset();
        this.state = "idle";
        this.signalStateChange();
    }
}

/** ccls readiness is authoritative only through its $ccls/info pipeline counters. */
export class CppProjectProgress extends WorkDoneProgress {
    private state: "idle" | "in_progress" | "ended" = "idle";

    constructor(private readonly request: Request) {
        super("C++ indexing");
    }

    override handleProgress(params: WorkDoneProgressParams): void {
        super.handleProgress(params);
        if (params.token !== "index") return;
        if (params.value?.kind === "begin") this.state = "in_progress";
        else if (params.value?.kind === "end") this.state = "idle";
    }

    override invalidate(): void {
        this.state = "idle";
    }

    override async waitUntilReady(endMs = 60_000): Promise<void> {
        const endTimeout = timeoutFromEnv("CODE_NAV_INDEX_END_TIMEOUT_MS", endMs);
        if (this.state === "ended") return;
        const deadline = Date.now() + endTimeout;
        let idleEnqueued: number | undefined;
        while (Date.now() < deadline) {
            const remaining = Math.max(1, deadline - Date.now());
            const raw = (await this.request("$ccls/info", undefined, remaining)) as {
                pipeline?: { completed?: number; enqueued?: number };
            };
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

    override reset(): void {
        super.reset();
        this.state = "idle";
    }
}

export function createProjectProgress(
    lang: Lang,
    request: Request,
    deferredRequest: DeferredRequest,
    isTy: boolean,
): ProjectProgress {
    if (lang === "bash") return new BashProjectProgress();
    if (lang === "cpp") return new CppProjectProgress(request);
    if (lang === "python" && isTy) return new TyProjectProgress(deferredRequest);
    return new WorkDoneProgress(
        lang === "typescript" ? "TypeScript project loading" : "Project loading",
    );
}
