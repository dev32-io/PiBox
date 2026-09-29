import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { restoreSessionScratchWorkspace, type SessionScratchBinding } from "./workspace.js";

const PAGE_SIZE = 100;
const MAX_ENTRIES = 4096;
const MAX_TEXT = 1024 * 1024;
const MAX_IMAGE = 16 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

export function scratchPath(path: string, directory = false): string[] {
	if (typeof path !== "string" || (path === "" && directory)) return [];
	const parts = path.split("/");
	if (path.length > 1024 || parts.some((part) => !part || part === "." || part === ".."
		|| part.includes("\\") || /[\u0000-\u001f\u007f]/.test(part))) throw new Error("Invalid scratch path");
	return parts;
}

function same(a: { dev: number; ino: number }, b: { dev: number; ino: number }) {
	return a.dev === b.dev && a.ino === b.ino;
}

/** Portable no-follow component checks; hostile same-UID races need OS fd-relative traversal. */
async function validatedPath(binding: SessionScratchBinding, parts: string[], kind: "directory" | "file") {
	const { paths } = await restoreSessionScratchWorkspace(binding);
	const handles = [] as Awaited<ReturnType<typeof open>>[];
	try {
		let path = paths.root;
		for (let i = -1; i < parts.length; i++) {
			if (i >= 0) path = join(path, parts[i]!);
			const type = i === parts.length - 1 ? kind : "directory";
			const before = await lstat(path);
			if (before.isSymbolicLink() || !(type === "directory" ? before.isDirectory() : before.isFile())) throw new Error("Blocked scratch entry");
			const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (type === "directory" ? constants.O_DIRECTORY : constants.O_NONBLOCK));
			handles.push(handle);
			if (!same(before, await handle.stat())) throw new Error("Scratch entry changed");
			if (i === -1 && (before.mode & 0o777) !== 0o700 || i === -1 && before.uid !== process.getuid?.()) throw new Error("Invalid scratch root");
		}
		return { path, handle: handles.at(-1)!, async verify() {
			let current = paths.root;
			for (let i = 0; i < handles.length; i++) {
				if (i) current = join(current, parts[i - 1]!);
				const stat = await lstat(current);
				if (stat.isSymbolicLink() || !same(stat, await handles[i]!.stat())) throw new Error("Scratch entry changed");
			}
		}, async close() { await Promise.all(handles.map((h) => h.close())); } };
	} catch (error) {
		await Promise.all(handles.map((h) => h.close()));
		throw error;
	}
}

export async function scratchWatchDirectory(binding: SessionScratchBinding, path: string): Promise<string> {
	const opened = await validatedPath(binding, scratchPath(path, true), "directory");
	try { await opened.verify(); return opened.path; } finally { await opened.close(); }
}

export async function listScratchDirectory(binding: SessionScratchBinding, path: string, cursor: number) {
	const parts = scratchPath(path, true);
	if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > MAX_ENTRIES) throw new Error("Invalid cursor");
	const opened = await validatedPath(binding, parts, "directory");
	try {
		const entries: { name: string; kind: "directory" | "file" | "blocked" }[] = [];
		const dir = await opendir(opened.path);
		try {
			for await (const entry of dir) {
				if (entries.length === MAX_ENTRIES) return { kind: "too-large" as const };
				entries.push({ name: entry.name, kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "blocked" });
			}
		} finally { await dir.close().catch(() => undefined); }
		await opened.verify();
		entries.sort((a, b) => (a.kind === "directory" ? 0 : 1) - (b.kind === "directory" ? 0 : 1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		return { kind: "directory" as const, entries: entries.slice(cursor, cursor + PAGE_SIZE), nextCursor: cursor + PAGE_SIZE < entries.length ? cursor + PAGE_SIZE : null };
	} finally { await opened.close(); }
}

function imageType(data: Buffer): string | undefined {
	if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
	if (/^GIF8[79]a$/.test(data.toString("ascii", 0, 6))) return "image/gif";
	if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	if (data.toString("ascii", 4, 8) === "ftyp" && ["avif", "avis"].includes(data.toString("ascii", 8, 12))) return "image/avif";
}

export async function readScratchFile(binding: SessionScratchBinding, path: string) {
	const parts = scratchPath(path);
	if (!parts.length) throw new Error("File path required");
	const opened = await validatedPath(binding, parts, "file");
	try {
		const before = await opened.handle.stat({ bigint: true });
		if (before.size > BigInt(MAX_IMAGE)) return { kind: "too-large" as const };
		const bytes = Buffer.alloc(Number(before.size) + 1);
		let size = 0;
		while (size < bytes.length) {
			const { bytesRead } = await opened.handle.read(bytes, size, bytes.length - size, size);
			if (!bytesRead) break;
			size += bytesRead;
		}
		const after = await opened.handle.stat({ bigint: true });
		await opened.verify();
		if (size > MAX_IMAGE || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("Scratch file changed during read");
		const data = bytes.subarray(0, size);
		const type = imageType(data);
		const version = `${before.ino}-${before.size}-${before.mtimeNs}-${before.ctimeNs}`;
		if (type) return { kind: "image" as const, type, version, size, data };
		if (size > MAX_TEXT) return { kind: "too-large" as const };
		if (data.includes(0)) return { kind: "binary" as const };
		try {
			const content = decoder.decode(data);
			if (/\.(?:png|jpe?g|gif|webp|avif)$/i.test(path)) return { kind: "unsupported" as const };
			return { kind: "text" as const, content, version };
		} catch { return { kind: "binary" as const }; }
	} finally { await opened.close(); }
}
