import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { restoreScratchEntry } from "../session-scratch/binding.js";
import { readSessionScratchNotes, restoreSessionScratchWorkspace } from "../session-scratch/workspace.js";
import type { SessionScratchBinding } from "../session-scratch/types.js";
import { sanitizeDistillText } from "./core.js";

const MAX_INVENTORY_ENTRIES = 500;

/** The scratch workspace a session's own branch bound, ignoring notes inherited from a fork parent. */
export function scratchBindingFor(sessionId: string, entries: any[]): SessionScratchBinding | undefined {
	const binding = restoreScratchEntry({ sessionManager: { getBranch: () => entries } } as any).binding;
	return binding?.sessionId === sessionId ? binding : undefined;
}

export async function scratchAvailable(binding: SessionScratchBinding | undefined): Promise<boolean> {
	if (!binding) return false;
	try { await restoreSessionScratchWorkspace(binding); return true; } catch { return false; }
}

async function inventory(directory: string, output: string[]): Promise<void> {
	let names: string[];
	try { names = (await readdir(directory)).sort(); } catch { return; }
	for (const name of names) {
		if (output.length >= MAX_INVENTORY_ENTRIES) return;
		const path = join(directory, name);
		const info = await lstat(path).catch(() => undefined);
		if (!info || info.isSymbolicLink()) continue;
		if (info.isDirectory()) await inventory(path, output);
		else if (info.isFile()) output.push(`- \`${path}\` (${info.size} bytes)`);
	}
}

/** Sanitized plan/ledger notes plus a path inventory of scratch scripts and results for each selected session. */
export async function renderSessionScratch(sessions: Array<{ sessionId: string; binding: SessionScratchBinding | undefined }>): Promise<string> {
	const rows = ["# Session scratch (sanitized, non-authoritative)", ""];
	if (!sessions.length) rows.push("No sessions selected.");
	for (const { sessionId, binding } of sessions) {
		rows.push(`## Session ${sessionId}`, "");
		if (!binding) { rows.push("No scratch workspace bound.", ""); continue; }
		try {
			const workspace = await restoreSessionScratchWorkspace(binding);
			const notes = await readSessionScratchNotes(binding);
			rows.push(`Root: \`${workspace.paths.root}\``, "");
			for (const [name, note] of [["plan.md", notes.plan], ["ledger.md", notes.ledger]] as const) {
				rows.push(`### ${name}${note.truncated ? " (truncated)" : ""}`, "", note.markdown.trim() || "[empty]", "");
			}
			const files: string[] = [];
			for (const directory of [workspace.paths.scripts, workspace.paths.results]) await inventory(directory, files);
			rows.push("### Other scratch files", "", files.length ? files.join("\n") : "None.", "");
			if (files.length >= MAX_INVENTORY_ENTRIES) rows.push(`Inventory stopped at ${MAX_INVENTORY_ENTRIES} entries.`, "");
		} catch (error) {
			rows.push(`Scratch unavailable: ${error instanceof Error ? error.message : String(error)}`, "");
		}
	}
	return sanitizeDistillText(rows.join("\n"));
}
