import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export type KeepAwakeStatus = "unsupported" | "idle" | "starting" | "active" | "stopping" | "failed";
export interface KeepAwakeControllerOptions {
	platform?: NodeJS.Platform;
	pid?: number;
	spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	onFailure?: (message: string) => void;
}
interface OwnedProcess {
	child: ChildProcess;
	started: boolean;
	stopping: boolean;
	exited: Promise<void>;
	resolveExit(): void;
	forceTimer?: ReturnType<typeof setTimeout>;
	deadline?: ReturnType<typeof setTimeout>;
}

/** One assertion process per main Pi session; demand is supplied by the extension. */
export class KeepAwakeController {
	private readonly platform: NodeJS.Platform;
	private readonly pid: number;
	private readonly spawn: NonNullable<KeepAwakeControllerOptions["spawn"]>;
	private active = false;
	private closed = false;
	private failed = false;
	private warned = false;
	private owned: OwnedProcess | undefined;
	private closing?: Promise<void>;

	constructor(private readonly options: KeepAwakeControllerOptions = {}) {
		this.platform = options.platform ?? process.platform;
		this.pid = options.pid ?? process.pid;
		this.spawn = options.spawn ?? nodeSpawn;
	}
	get status(): KeepAwakeStatus {
		if (this.platform !== "darwin") return "unsupported";
		if (this.failed) return "failed";
		if (!this.owned) return "idle";
		return this.owned.stopping ? "stopping" : this.owned.started ? "active" : "starting";
	}
	setActive(active: boolean): void { this.active = active; this.reconcile(); }
	retry(): void {
		if (this.closed) return;
		this.failed = false;
		this.reconcile();
	}
	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.active = false;
		const owned = this.owned;
		// Keep explicit shutdown alive until exit (or its bounded deadline), even
		// in print mode where no terminal handle remains to drive the event loop.
		owned?.child.ref();
		this.reconcile();
		return this.closing = (owned?.exited ?? Promise.resolve()).finally(() => owned?.child.unref());
	}
	private fail(message: string): void {
		this.failed = true;
		if (this.warned) return;
		this.warned = true;
		try { this.options.onFailure?.(message); } catch { /* Optional observers cannot fail agent work. */ }
	}
	private reconcile(): void {
		if (this.platform !== "darwin") return;
		if (this.owned) {
			if (!this.active || this.closed) this.stop(this.owned);
			return; // Never overlap an exiting process with a replacement.
		}
		if (!this.active || this.closed || this.failed) return;
		try {
			const child = this.spawn("/usr/bin/caffeinate", ["-d", "-i", "-w", String(this.pid)], { stdio: "ignore", shell: false });
			let resolveExit!: () => void;
			const owned: OwnedProcess = { child, started: false, stopping: false, exited: new Promise<void>((resolve) => { resolveExit = resolve; }), resolveExit: () => resolveExit() };
			this.owned = owned;
			const finish = (unexpected: boolean) => {
				if (this.owned !== owned) return;
				clearTimeout(owned.forceTimer);
				clearTimeout(owned.deadline);
				this.owned = undefined;
				owned.resolveExit();
				if (unexpected) this.fail("caffeinate exited unexpectedly; use /keep-awake on to retry");
				this.reconcile();
			};
			child.once("spawn", () => {
				if (this.owned !== owned) return;
				owned.started = true;
				if (owned.stopping) this.signal(owned, "SIGTERM");
			});
			child.on("error", (error) => {
				if (this.owned !== owned) return;
				this.fail(`caffeinate failed: ${error.message}`);
				// A spawn failure owns no OS process. A signalling failure may still do so.
				if (child.pid === undefined) finish(false);
			});
			child.once("exit", () => finish(!owned.stopping && !this.closed));
			child.unref();
		} catch (error) { this.fail(`Could not start caffeinate: ${String(error)}`); }
	}
	private signal(owned: OwnedProcess, signal: NodeJS.Signals): void {
		try { owned.child.kill(signal); }
		catch (error) { this.fail(`Could not stop caffeinate: ${String(error)}`); }
	}
	private stop(owned: OwnedProcess): void {
		if (owned.stopping) return;
		owned.stopping = true;
		owned.forceTimer = setTimeout(() => {
			if (this.owned === owned) this.signal(owned, "SIGKILL");
		}, 1_000);
		owned.forceTimer.unref();
		owned.deadline = setTimeout(() => {
			if (this.owned !== owned) return;
			this.fail("caffeinate termination could not be confirmed");
			// Bound shutdown without permitting another process to replace an unconfirmed one.
			owned.resolveExit();
		}, 2_000);
		owned.deadline.unref();
		this.signal(owned, "SIGTERM");
	}
}
