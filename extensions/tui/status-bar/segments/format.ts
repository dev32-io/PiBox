import { basename } from "node:path";
import type { GitSnapshot } from "../git.js";

export function compactNumber(value: number): string {
	if (value < 1_000) return String(Math.round(value));
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

export function formatCwd(cwd: string, full = false): string {
	if (!full) return basename(cwd) || cwd;
	const home = process.env.HOME;
	return home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
}

export function formatGit(snapshot: GitSnapshot): string | undefined {
	if (!snapshot.insideWorkTree) return undefined;
	const parts = [snapshot.branch ?? (snapshot.detachedOid ? `@${snapshot.detachedOid}` : "git")];
	if (snapshot.staged > 0) parts.push(`+${snapshot.staged}`);
	if (snapshot.modified > 0) parts.push(`*${snapshot.modified}`);
	if (snapshot.untracked > 0) parts.push(`?${snapshot.untracked}`);
	if (snapshot.ahead > 0) parts.push(`↑${snapshot.ahead}`);
	if (snapshot.behind > 0) parts.push(`↓${snapshot.behind}`);
	return parts.join(" ");
}
