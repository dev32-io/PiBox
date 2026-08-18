import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { HarnessError } from "./errors.js";
import { atomicWriteFile, readTextIfExists, runGit, type RepositoryIdentity } from "./repository.js";

export interface RepairRecoveryRecord {
	schemaVersion: 1;
	workItemId: string;
	evaluationId: string;
	agentId: string;
	operationId: string;
	iteration: number;
	head: string;
	fingerprint: string;
	dirty: boolean;
	recordedAt: string;
}

async function workspaceFingerprint(root: string): Promise<{ head: string; fingerprint: string; dirty: boolean }> {
	const [head, status, diff, untrackedText] = await Promise.all([
		runGit(root, ["rev-parse", "HEAD"]),
		runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
		runGit(root, ["diff", "--binary", "HEAD", "--", "."]),
		runGit(root, ["ls-files", "--others", "--exclude-standard"]),
	]);
	const hash = createHash("sha256").update(head).update("\0").update(status).update("\0").update(diff);
	for (const path of untrackedText.split("\n").filter(Boolean).sort()) {
		hash.update("\0").update(path).update("\0");
		const content = await readFile(join(root, path)).catch(() => Buffer.from("<unreadable>"));
		hash.update(content);
	}
	return { head, fingerprint: `sha256:${hash.digest("hex")}`, dirty: Boolean(status) };
}

export class RepairRecoveryStore {
	constructor(readonly identity: RepositoryIdentity) {}

	path(workItemId: string, evaluationId: string): string {
		return join(this.identity.privateRoot, "work-items", workItemId, "repair-recovery", `${evaluationId}.yaml`);
	}

	async record(input: { workItemId: string; evaluationId: string; agentId: string; operationId: string; iteration: number }): Promise<RepairRecoveryRecord> {
		const workspace = await workspaceFingerprint(this.identity.root);
		const record: RepairRecoveryRecord = { schemaVersion: 1, ...input, ...workspace, recordedAt: new Date().toISOString() };
		await atomicWriteFile(this.path(input.workItemId, input.evaluationId), stringify(record), 0o600);
		return record;
	}

	async read(workItemId: string, evaluationId: string): Promise<RepairRecoveryRecord | undefined> {
		const text = await readTextIfExists(this.path(workItemId, evaluationId));
		if (!text) return undefined;
		const record = parse(text) as Partial<RepairRecoveryRecord>;
		if (record.schemaVersion !== 1 || record.workItemId !== workItemId || record.evaluationId !== evaluationId || typeof record.agentId !== "string" || typeof record.operationId !== "string" || typeof record.iteration !== "number" || typeof record.head !== "string" || typeof record.fingerprint !== "string" || typeof record.dirty !== "boolean" || typeof record.recordedAt !== "string") {
			throw new HarnessError("INVALID_ARTIFACT", `Invalid repair recovery record for ${workItemId}/${evaluationId}`);
		}
		return record as RepairRecoveryRecord;
	}

	async assertCurrent(record: RepairRecoveryRecord): Promise<void> {
		const current = await workspaceFingerprint(this.identity.root);
		if (current.head !== record.head || current.fingerprint !== record.fingerprint) {
			throw new HarnessError("DIRTY_CANONICAL_BRANCH", `Repair workspace changed after fixer ${record.agentId} failed; preserved work requires user-directed recovery`, { evaluationId: record.evaluationId, agentId: record.agentId, recordedAt: record.recordedAt });
		}
	}

	async clear(workItemId: string, evaluationId: string): Promise<void> {
		await rm(this.path(workItemId, evaluationId), { force: true });
		await rm(dirname(this.path(workItemId, evaluationId)), { recursive: false }).catch(() => undefined);
	}
}
