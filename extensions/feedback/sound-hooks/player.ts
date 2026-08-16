import { spawn, type ChildProcess } from "node:child_process";

export type SpawnProcess = typeof spawn;
export interface Playback { stop(): void; }

export function startSound(path: string, platform = process.platform, spawnProcess: SpawnProcess = spawn): Playback | undefined {
	if (platform !== "darwin") return undefined;
	try {
		const child = spawnProcess("afplay", [path], { detached: true, stdio: "ignore" });
		child.on("error", () => {});
		child.unref();
		return { stop: () => { try { (child as ChildProcess).kill(); } catch {} } };
	} catch { return undefined; }
}

export function playSound(path: string, platform = process.platform, spawnProcess: SpawnProcess = spawn): boolean {
	return startSound(path, platform, spawnProcess) !== undefined;
}

export type AudioKind = "response" | "success" | "error";
export interface AudioScheduler {
	setTimeout(callback: () => void, delay: number): unknown;
	clearTimeout(handle: unknown): void;
}

/** Single-channel arbitration: errors win, success is delayed/coalesced, and response completion never overlaps workflow success. */
export class AudioArbiter {
	private active: { kind: AudioKind; playback: Playback } | undefined;
	private pending: { kind: AudioKind; key: string; handle: unknown } | undefined;
	private readonly delayMs: number;
	constructor(private readonly play: (kind: AudioKind) => Playback | undefined, private readonly timers: AudioScheduler, delayMs = 120) { this.delayMs = delayMs; }
	request(kind: AudioKind, key: string = kind): boolean {
		if (kind === "error") {
			if (this.pending) this.timers.clearTimeout(this.pending.handle);
			this.pending = undefined;
			this.active?.playback.stop(); this.active = undefined;
			return this.begin(kind);
		}
		if (kind === "response" && (this.pending?.kind === "success" || this.active?.kind === "success")) return false;
		if (kind === "success") {
			if (this.pending?.kind === "success" && this.pending.key === key) return false;
			if (this.pending) this.timers.clearTimeout(this.pending.handle);
			const handle = this.timers.setTimeout(() => { this.pending = undefined; this.begin("success"); }, this.delayMs);
			this.pending = { kind, key, handle };
			return true;
		}
		return this.begin(kind);
	}
	private begin(kind: AudioKind): boolean {
		this.active?.playback.stop();
		const playback = this.play(kind);
		if (!playback) { this.active = undefined; return false; }
		this.active = { kind, playback };
		return true;
	}
	reset(): void {
		if (this.pending) this.timers.clearTimeout(this.pending.handle);
		this.pending = undefined;
		this.active?.playback.stop(); this.active = undefined;
	}
}
