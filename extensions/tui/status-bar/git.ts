import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GitConfig } from "./config.js";

export interface GitSnapshot {
	insideWorkTree: boolean;
	branch?: string;
	detachedOid?: string;
	staged: number;
	modified: number;
	untracked: number;
	ahead: number;
	behind: number;
}

export const EMPTY_GIT_SNAPSHOT: GitSnapshot = {
	insideWorkTree: false,
	staged: 0,
	modified: 0,
	untracked: 0,
	ahead: 0,
	behind: 0,
};

export function parsePorcelainV2(output: string): GitSnapshot {
	const snapshot: GitSnapshot = { ...EMPTY_GIT_SNAPSHOT, insideWorkTree: true };
	let oid: string | undefined;
	for (const line of output.split("\n")) {
		if (line.startsWith("# branch.oid ")) oid = line.slice(13).trim();
		else if (line.startsWith("# branch.head ")) {
			const head = line.slice(14).trim();
			if (head !== "(detached)") snapshot.branch = head;
		} else if (line.startsWith("# branch.ab ")) {
			const match = /\+(\d+)\s+-(\d+)/.exec(line);
			if (match) {
				snapshot.ahead = Number(match[1]);
				snapshot.behind = Number(match[2]);
			}
		} else if (line.startsWith("? ")) snapshot.untracked++;
		else if (/^[12u] /.test(line)) {
			const xy = line.slice(2, 4);
			if (xy[0] && xy[0] !== "." && xy[0] !== "?") snapshot.staged++;
			if (xy[1] && xy[1] !== "." && xy[1] !== "?") snapshot.modified++;
		}
	}
	if (!snapshot.branch && oid && oid !== "(initial)") snapshot.detachedOid = oid.slice(0, 8);
	return snapshot;
}

export function sameGitSnapshot(left: GitSnapshot, right: GitSnapshot): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export class GitPoller {
	private timer: ReturnType<typeof setInterval> | undefined;
	private inFlight = false;
	private stopped = true;
	private failures = 0;
	private nextAllowedAt = 0;
	private refreshPending = false;
	private snapshot: GitSnapshot = EMPTY_GIT_SNAPSHOT;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly cwd: string,
		private readonly config: GitConfig,
		private readonly onChange: (snapshot: GitSnapshot) => void,
	) {}

	getSnapshot(): GitSnapshot {
		return this.snapshot;
	}

	start(): void {
		if (!this.config.enabled || !this.stopped) return;
		this.stopped = false;
		void this.refresh();
		if (this.config.refreshMode === "poll") {
			this.timer = setInterval(() => void this.refresh(), this.config.pollIntervalMs);
		}
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.refreshPending = false;
	}

	requestRefresh(): void {
		if (this.stopped) return;
		this.nextAllowedAt = 0;
		if (this.inFlight) {
			this.refreshPending = true;
			return;
		}
		void this.refresh();
	}

	async refresh(): Promise<void> {
		if (this.stopped || this.inFlight || Date.now() < this.nextAllowedAt) return;
		this.inFlight = true;
		try {
			const untracked = this.config.includeUntracked ? "normal" : "no";
			const result = await this.pi.exec(
				"git",
				["status", "--porcelain=v2", "--branch", `--untracked-files=${untracked}`],
				{ cwd: this.cwd, timeout: this.config.commandTimeoutMs },
			);
			if (this.stopped) return;
			if (result.code === 0) {
				const next = parsePorcelainV2(result.stdout);
				this.failures = 0;
				if (!sameGitSnapshot(next, this.snapshot)) {
					this.snapshot = next;
					this.onChange(next);
				}
			} else {
				this.failures++;
			}
		} catch {
			this.failures++;
		} finally {
			this.inFlight = false;
			if (this.failures >= 3) {
				this.nextAllowedAt = Date.now() + Math.min(60_000, this.config.pollIntervalMs * this.failures);
			}
			if (this.refreshPending && !this.stopped) {
				this.refreshPending = false;
				queueMicrotask(() => void this.refresh());
			}
		}
	}
}
