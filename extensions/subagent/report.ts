import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import type { TerminalResult } from "./api.js";

export const DEFAULT_REPORT_CHARACTERS = 8_000;
export const MAX_REPORT_CHARACTERS = 12_000;

export function terminalReportText(terminal: TerminalResult): string {
	return terminal.text || terminal.stderr || `Subagent ${terminal.status}.`;
}

export interface ReportEvidence {
	readonly bytes?: number;
	readonly sha256?: string;
}

export interface ValidatedReport {
	readonly text: string;
	readonly bytes: number;
	readonly characters: number;
	readonly sha256: string;
}

/** Opens one private regular report without following a replaced symlink. */
export async function readPrivateReport(path: string, evidence: ReportEvidence = {}): Promise<ValidatedReport> {
	let handle;
	try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new Error(`report file is missing: ${path}`);
		if (code === "ELOOP") throw new Error(`report path must not be a symbolic link: ${path}`);
		throw error;
	}
	try {
		assertPrivateRegularReport(await handle.stat(), path);
		const text = await handle.readFile("utf8");
		assertPrivateRegularReport(await handle.stat(), path);
		const bytes = Buffer.byteLength(text, "utf8");
		if (evidence.bytes !== undefined && bytes !== evidence.bytes) throw new Error(`report byte count changed after capture: expected ${evidence.bytes}, received ${bytes}`);
		const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
		if (evidence.sha256 !== undefined && sha256 !== evidence.sha256) throw new Error("report content changed after capture");
		return { text, bytes, characters: Array.from(text).length, sha256 };
	} finally {
		await handle.close();
	}
}

/** Compatibility reader for the same harness-owned report advertised to normal read/grep. */
export async function readTerminalReport(terminal: TerminalResult): Promise<string> {
	if (!terminal.reportPath) return terminalReportText(terminal);
	const expectedDigest = terminal.reportSha256 ?? createHash("sha256").update(terminal.text, "utf8").digest("hex");
	try {
		return (await readPrivateReport(terminal.reportPath, {
			...(terminal.reportBytes === undefined ? {} : { bytes: terminal.reportBytes }),
			sha256: expectedDigest,
		})).text;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/report file is missing/i.test(message)) throw new Error(`Subagent report file is missing: ${terminal.reportPath}`);
		throw new Error(`Unable to read subagent report ${terminal.reportPath}: ${message}`);
	}
}

function assertPrivateRegularReport(stats: Stats, path: string): void {
	if (!stats.isFile()) throw new Error(`report path is not a regular file: ${path}`);
	if ((stats.mode & 0o077) !== 0) throw new Error(`report file permissions are not private: ${path}`);
}

/** Code-point offsets avoid splitting Unicode characters; at most 48KB of report text. */
export function readReportPage(text: string, offset = 0, limit = DEFAULT_REPORT_CHARACTERS) {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Report offset must be a non-negative safe integer");
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REPORT_CHARACTERS) throw new Error(`Report limit must be between 1 and ${MAX_REPORT_CHARACTERS}`);
	const characters = Array.from(text);
	if (offset > characters.length) throw new Error(`Report offset exceeds ${characters.length} characters`);
	const count = Math.min(limit, characters.length - offset);
	const end = offset + count;
	return {
		text: characters.slice(offset, end).join(""),
		offset,
		count,
		totalCharacters: characters.length,
		...(end < characters.length ? { nextOffset: end } : {}),
	};
}
