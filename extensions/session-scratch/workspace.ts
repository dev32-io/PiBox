import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionScratchBinding, SessionScratchPaths, SessionScratchWorkspace } from "./types.js";

const SCRATCH_ROOT = "/tmp";
const WORKSPACE_PREFIX = "pibox-session-";
const WORKSPACE_ID = /^[0-9a-f]{32}$/;
const MAX_CREATE_ATTEMPTS = 32;
const MAX_META_BYTES = 16 * 1024;
export const MAX_SCRATCH_NOTE_BYTES = 128 * 1024;
const MAX_SESSION_ID_BYTES = 4 * 1024;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

const PLAN_TEMPLATE = `# Session Scratch Plan

> Non-authoritative private scratch. Temporary; not a product, workflow, or repository source of truth.

Research -> Plan -> Approval -> Execution until the agreed goal and Done criteria are met. Proactively draft once enough findings support a useful approach; do not wait for a separate plan request.

## Research

Complete enough read-only research for a defensible approach. Review and reconcile relevant delegated findings before presenting a plan; keep researching or ask clarifying questions while they remain pending. Separate facts, assumptions, and material decisions.

## Plan

Write and show a discussion draft as soon as enough evidence is available. Record one current Goal, Deliverable, verifiable Done criteria, and a concise checklist (- [ ] / - [x]). Each step should name its next action, dependencies, completion checks, and whether work is sequential or independent. Group independent work into parallel lanes with explicit prerequisites, file ownership, shared interfaces/resources, and integration checks. Checklist order is not a scheduling dependency. Subagents and ad hoc branches/worktrees are available for safe concurrency; plan isolation and integration where needed. State remaining assumptions. Use this draft to clarify what the user wants and revise it as discussion and targeted research resolve open questions; planning does not authorize implementation.

## Approval

Wait for explicit user approval before implementation or implementation delegation. Routine iteration within approved scope needs no renewed approval. Material goal, scope, or reserved user decisions do; genuine blockers also pause with the remaining gap and required input recorded.

## Execution

After approval, use this file as the control loop without routine prompt pauses. After compaction, resume, background completion, or missing context, recover the approved goal and current unchecked step here; consult ledger.md for evidence and decisions.

For every result, inspect it and run the current step's completion checks. Once verified, immediately edit the actual checkbox from - [ ] to - [x]. Leave partial or blocked work unchecked and record completed substeps plus the remaining gap. Record evidence and decisions in ledger.md, then launch or continue all safely ready items within available capacity. Reassess dependencies after each result; do not wait for unrelated lanes or impose numbered-order waves. Serialize only actual dependencies or conflicting edits/resources; worktrees do not isolate shared test services. Verify all Done criteria before claiming completion.

At goal changes and completion, remove obsolete or superseded detail using judgment, retaining summaries or pointers only where useful—without forced archives, hard caps, or automatic deletion.

`;
const LEDGER_TEMPLATE = `# Session Scratch Ledger

> Non-authoritative scratch material. This file is temporary and is not a durable workflow ledger or repository source of truth.

Keep currently useful facts, decisions and rationale, evidence pointers, approaches tried or ruled out, and unresolved issues so work can continue without repeated investigation. This is context, not a chronological activity log. At goal changes and completion, consolidate and remove obsolete or superseded detail using judgment, retaining summaries or pointers only where useful—without forced archives, hard caps, or automatic deletion.

`;

interface WorkspaceMetadata {
	schemaVersion: 1;
	workspaceId: string;
	sessionId: string;
	createdAt: string;
}

export class WorkspaceValidationError extends Error {
	readonly code = "INVALID_SESSION_SCRATCH_WORKSPACE";

	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorkspaceValidationError";
	}
}

function pathsFor(workspaceId: string): SessionScratchPaths {
	const root = join(SCRATCH_ROOT, `${WORKSPACE_PREFIX}${workspaceId}`);
	return {
		root,
		meta: join(root, "meta.json"),
		plan: join(root, "plan.md"),
		ledger: join(root, "ledger.md"),
		scripts: join(root, "scripts"),
		results: join(root, "results"),
	};
}

function validateBinding(binding: SessionScratchBinding): void {
	if (!WORKSPACE_ID.test(binding.workspaceId)) {
		throw new WorkspaceValidationError("Workspace id must be 32 lowercase hexadecimal characters");
	}
	if (typeof binding.sessionId !== "string" || binding.sessionId.length === 0) {
		throw new WorkspaceValidationError("Session id must be a non-empty string");
	}
	if (Buffer.byteLength(binding.sessionId, "utf8") > MAX_SESSION_ID_BYTES) {
		throw new WorkspaceValidationError("Session id is too large");
	}
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

async function createDirectory(path: string): Promise<void> {
	await mkdir(path, { mode: DIRECTORY_MODE });
	await chmod(path, DIRECTORY_MODE);
}

/** Publish a complete file without ever replacing an existing directory entry. */
async function createInitialFile(path: string, content: string): Promise<void> {
	const temporary = join(dirname(path), `.${randomBytes(16).toString("hex")}.tmp`);
	const handle = await open(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		FILE_MODE,
	);
	try {
		await handle.writeFile(content, "utf8");
		await handle.chmod(FILE_MODE);
		await handle.sync();
	} finally {
		await handle.close();
	}

	try {
		await link(temporary, path);
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

function metadataFor(binding: SessionScratchBinding): WorkspaceMetadata {
	return {
		schemaVersion: 1,
		workspaceId: binding.workspaceId,
		sessionId: binding.sessionId,
		createdAt: new Date().toISOString(),
	};
}

/**
 * Lazily creates scratch storage when explicitly called. Calling this again for a
 * fork or new session creates a distinct opaque workspace.
 */
export async function createSessionScratchWorkspace(sessionId: string): Promise<SessionScratchWorkspace> {
	validateBinding({ workspaceId: "00000000000000000000000000000000", sessionId });

	for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
		const binding = { workspaceId: randomBytes(16).toString("hex"), sessionId };
		const paths = pathsFor(binding.workspaceId);
		try {
			await createDirectory(paths.root);
		} catch (error) {
			if (isNodeError(error, "EEXIST")) continue;
			throw error;
		}

		try {
			await createDirectory(paths.scripts);
			await createDirectory(paths.results);
			await createInitialFile(paths.plan, PLAN_TEMPLATE);
			await createInitialFile(paths.ledger, LEDGER_TEMPLATE);
			// Publish metadata last so it is also the initialization-ready marker.
			await createInitialFile(paths.meta, `${JSON.stringify(metadataFor(binding), null, 2)}\n`);
			return { binding, paths };
		} catch (error) {
			await rm(paths.root, { recursive: true, force: true }).catch(() => undefined);
			throw error;
		}
	}

	throw new Error(`Could not allocate a session scratch workspace after ${MAX_CREATE_ATTEMPTS} attempts`);
}

async function openValidated(path: string, kind: "directory" | "file", mode: number) {
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW
			| (kind === "directory" ? constants.O_DIRECTORY : constants.O_NONBLOCK));
	} catch (error) {
		throw new WorkspaceValidationError(`Scratch workspace contains an invalid ${kind}: ${path}`, { cause: error });
	}

	try {
		const stats = await handle.stat();
		const correctKind = kind === "directory" ? stats.isDirectory() : stats.isFile();
		if (!correctKind || (stats.mode & 0o777) !== mode) {
			throw new WorkspaceValidationError(`Scratch workspace contains an invalid ${kind}: ${path}`);
		}
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function readBoundedMetadata(path: string): Promise<WorkspaceMetadata> {
	const handle = await openValidated(path, "file", FILE_MODE);
	try {
		const chunks: Buffer[] = [];
		let total = 0;
		while (total <= MAX_META_BYTES) {
			const chunk = Buffer.allocUnsafe(Math.min(4096, MAX_META_BYTES + 1 - total));
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
			if (bytesRead === 0) break;
			chunks.push(chunk.subarray(0, bytesRead));
			total += bytesRead;
		}
		if (total > MAX_META_BYTES) throw new WorkspaceValidationError("Scratch workspace metadata is too large");

		let value: unknown;
		try {
			value = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
		} catch (error) {
			throw new WorkspaceValidationError("Scratch workspace metadata is not valid JSON", { cause: error });
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new WorkspaceValidationError("Scratch workspace metadata is invalid");
		}
		const metadata = value as Partial<WorkspaceMetadata>;
		if (metadata.schemaVersion !== 1 || typeof metadata.workspaceId !== "string"
			|| typeof metadata.sessionId !== "string" || typeof metadata.createdAt !== "string") {
			throw new WorkspaceValidationError("Scratch workspace metadata is invalid");
		}
		return metadata as WorkspaceMetadata;
	} finally {
		await handle.close();
	}
}

async function validateWorkspace(binding: SessionScratchBinding): Promise<SessionScratchWorkspace> {
	validateBinding(binding);
	const paths = pathsFor(binding.workspaceId);

	let rootEntry;
	try {
		rootEntry = await lstat(paths.root);
	} catch (error) {
		throw new WorkspaceValidationError("Scratch workspace does not exist", { cause: error });
	}
	if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
		throw new WorkspaceValidationError("Scratch workspace root is not a directory");
	}

	const rootHandle = await openValidated(paths.root, "directory", DIRECTORY_MODE);
	try {
		const metadata = await readBoundedMetadata(paths.meta);
		if (metadata.workspaceId !== binding.workspaceId || metadata.sessionId !== binding.sessionId) {
			throw new WorkspaceValidationError("Scratch workspace binding does not match its metadata");
		}

		for (const path of [paths.plan, paths.ledger]) {
			const handle = await openValidated(path, "file", FILE_MODE);
			await handle.close();
		}
		for (const path of [paths.scripts, paths.results]) {
			const handle = await openValidated(path, "directory", DIRECTORY_MODE);
			await handle.close();
		}

		const [openedRoot, currentRoot] = await Promise.all([rootHandle.stat(), lstat(paths.root)]);
		if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink()
			|| openedRoot.dev !== currentRoot.dev || openedRoot.ino !== currentRoot.ino) {
			throw new WorkspaceValidationError("Scratch workspace root changed during validation");
		}
	} finally {
		await rootHandle.close();
	}

	return { binding: { ...binding }, paths };
}

/** Restore an existing workspace only when both opaque id and owning Pi session id match. */
export async function restoreSessionScratchWorkspace(binding: SessionScratchBinding): Promise<SessionScratchWorkspace> {
	return validateWorkspace(binding);
}

export interface SessionScratchNote {
	markdown: string;
	truncated: boolean;
}

/** Bounded, read-only projection of the two notes; never serves arbitrary workspace files. */
export async function readSessionScratchNotes(binding: SessionScratchBinding): Promise<{ plan: SessionScratchNote; ledger: SessionScratchNote }> {
	const workspace = await validateWorkspace(binding);
	const root = await openValidated(workspace.paths.root, "directory", DIRECTORY_MODE);
	const readNote = async (path: string): Promise<SessionScratchNote> => {
		const handle = await openValidated(path, "file", FILE_MODE);
		try {
			const [openedRoot, currentRoot] = await Promise.all([root.stat(), lstat(workspace.paths.root)]);
			if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || openedRoot.dev !== currentRoot.dev || openedRoot.ino !== currentRoot.ino) {
				throw new WorkspaceValidationError("Scratch workspace changed during note read");
			}
			const buffer = Buffer.alloc(MAX_SCRATCH_NOTE_BYTES + 1);
			let total = 0;
			while (total < buffer.length) {
				const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
				if (!bytesRead) break;
				total += bytesRead;
			}
			const truncated = total > MAX_SCRATCH_NOTE_BYTES;
			return { markdown: new TextDecoder().decode(buffer.subarray(0, Math.min(total, MAX_SCRATCH_NOTE_BYTES)), { stream: truncated }), truncated };
		} finally { await handle.close(); }
	};
	try {
		// Read sequentially so every handle has settled before the root handle is closed.
		return { plan: await readNote(workspace.paths.plan), ledger: await readNote(workspace.paths.ledger) };
	} finally { await root.close(); }
}

/** Permanently remove a workspace after revalidating its complete layout and binding. */
export async function purgeSessionScratchWorkspace(binding: SessionScratchBinding): Promise<void> {
	const workspace = await validateWorkspace(binding);
	await rm(workspace.paths.root, { recursive: true });
}

export type { SessionScratchBinding, SessionScratchPaths, SessionScratchWorkspace } from "./types.js";
