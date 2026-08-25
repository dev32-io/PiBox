import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { SessionAgentRegistry } from "../workflow-runtime/agent-registry.js";
import { WorkflowMutex } from "../workflow-runtime/storage.js";
import { describeHarnessError, HarnessError } from "./errors.js";
import { discoverRepository, readTextIfExists, type RepositoryIdentity } from "./repository.js";
import { HarnessRunStore } from "./run-store.js";

const RECENT_LEDGER_ENTRIES = 10;
const WORK_ITEM_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface WorkflowLedgerEntry {
	schemaVersion: 1;
	id: string;
	at: string;
	role: string;
	taskId?: string;
	evaluationId?: string;
	text: string;
}

function normalizedEntry(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export class WorkflowLedgerStore {
	readonly path: string;
	readonly mutex: WorkflowMutex;

	constructor(readonly identity: RepositoryIdentity, readonly workItemId: string) {
		if (!WORK_ITEM_ID.test(workItemId)) throw new HarnessError("CAPABILITY_DENIED", "Invalid workflow ledger work-item identity");
		const root = join(identity.privateRoot, "work-items", workItemId);
		this.path = join(root, "ledger.jsonl");
		this.mutex = new WorkflowMutex(join(root, "ledger-lock"));
	}

	async read(all = false): Promise<WorkflowLedgerEntry[]> {
		return this.mutex.run(`workflow-ledger:read:${this.workItemId}`, async () => {
			const entries = await this.readUnlocked();
			return all ? entries : entries.slice(-RECENT_LEDGER_ENTRIES);
		});
	}

	async append(entry: WorkflowLedgerEntry): Promise<{ entry: WorkflowLedgerEntry; appended: boolean }> {
		return this.mutex.run(`workflow-ledger:append:${entry.id}`, async () => {
			const entries = await this.readUnlocked();
			const existing = entries.find((candidate) => candidate.id === entry.id);
			if (existing) {
				if (existing.text !== entry.text) throw new HarnessError("CAPABILITY_DENIED", "This process attempt already wrote a different workflow ledger entry");
				return { entry: existing, appended: false };
			}
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			const handle = await open(this.path, "a", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			return { entry, appended: true };
		});
	}

	private async readUnlocked(): Promise<WorkflowLedgerEntry[]> {
		const content = await readTextIfExists(this.path);
		if (!content?.trim()) return [];
		return content.trimEnd().split("\n").map((line) => {
			const entry = JSON.parse(line) as WorkflowLedgerEntry;
			if (entry.schemaVersion !== 1 || !entry.id || !entry.at || !entry.role || !entry.text) throw new HarnessError("INVALID_ARTIFACT", `Workflow ledger contains an invalid entry for ${this.workItemId}`);
			return entry;
		});
	}
}

interface LedgerScope {
	identity: RepositoryIdentity;
	workItemId: string;
	id: string;
	role: string;
	taskId?: string;
	evaluationId?: string;
}

async function ledgerScope(ctx: ExtensionContext): Promise<LedgerScope> {
	if (process.env.PIBOX_HARNESS_EVALUATION) throw new HarnessError("CAPABILITY_DENIED", "Reviewers and E2E evaluators cannot access the workflow ledger");
	const identity = await discoverRepository(ctx.cwd);
	const runId = process.env.PIBOX_HARNESS_RUN_ID;
	const workItemId = process.env.PIBOX_HARNESS_WORK_ITEM;
	const taskId = process.env.PIBOX_HARNESS_TASK;
	const credential = process.env.PIBOX_HARNESS_CREDENTIAL;
	if (runId && workItemId && taskId && credential) {
		const run = await new HarnessRunStore(identity, workItemId).authorize(runId, credential);
		if (run.workItemId !== workItemId || run.taskId !== taskId || run.workspace !== ctx.cwd) throw new HarnessError("CAPABILITY_DENIED", "Workflow ledger scope does not match this task run");
		const attemptId = process.env.PIBOX_SUBAGENT_ATTEMPT_ID ?? process.env.PIBOX_WORKFLOW_LEDGER_ATTEMPT;
		if (!attemptId) throw new HarnessError("CAPABILITY_DENIED", "Workflow ledger task access requires a process-attempt identity");
		return { identity, workItemId, id: `task:${runId}:${attemptId}`, role: run.role, taskId };
	}

	const privateRoot = process.env.PIBOX_SUBAGENT_STORE_ROOT;
	const sessionId = process.env.PIBOX_WORKFLOW_SESSION_ID;
	const agentId = process.env.PIBOX_SUBAGENT_ID;
	const attemptId = process.env.PIBOX_SUBAGENT_ATTEMPT_ID;
	if (!privateRoot || !sessionId || !agentId || !attemptId) throw new HarnessError("CAPABILITY_DENIED", "Workflow ledger access requires a managed task or repair process");
	const agent = await new SessionAgentRegistry(privateRoot, sessionId).get(agentId);
	if (agent.role !== "repair-implementer" || !agent.workItemId || agent.currentAttemptId !== attemptId) throw new HarnessError("CAPABILITY_DENIED", "Only managed repair agents may access the workflow ledger through this scope");
	return {
		identity,
		workItemId: agent.workItemId,
		id: `repair:${agentId}:${attemptId}`,
		role: agent.role,
		...(agent.taskId ? { taskId: agent.taskId } : {}),
		...(agent.evaluationId ? { evaluationId: agent.evaluationId } : {}),
	};
}

function renderEntries(entries: WorkflowLedgerEntry[], all: boolean): string {
	if (entries.length === 0) return "Workflow ledger is empty.";
	const heading = all ? `Workflow ledger (${entries.length} entries):` : `Latest workflow ledger entries (${entries.length} of up to ${RECENT_LEDGER_ENTRIES}):`;
	return [heading, ...entries.map((entry) => {
		const scope = entry.taskId ? `task ${entry.taskId}` : entry.evaluationId ? `evaluation ${entry.evaluationId}` : entry.role;
		return `- ${scope}: ${entry.text}`;
	})].join("\n");
}

const result = (text: string, details: unknown = null) => ({ content: [{ type: "text" as const, text }], details });

export function registerWorkflowLedgerCapability(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "workflow_ledger",
		label: "Workflow Ledger",
		description: "Read the rolling context ledger for this managed workflow or append this process attempt's one concise handoff entry. Snapshot returns the latest 10 entries; all returns the complete ledger. Reviewers and E2E evaluators cannot access this tool.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("snapshot"), Type.Literal("all"), Type.Literal("append")]),
			entry: Type.Optional(Type.String({ minLength: 1, maxLength: 1600, description: "For append: a concise 3-5 sentence summary of only context useful to later workflow agents." })),
		}, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const scope = await ledgerScope(ctx);
				const store = new WorkflowLedgerStore(scope.identity, scope.workItemId);
				if (params.action !== "append") {
					const entries = await store.read(params.action === "all");
					return result(renderEntries(entries, params.action === "all"), entries);
				}
				if (!params.entry) throw new HarnessError("INVALID_ARTIFACT", "entry is required when appending to the workflow ledger");
				const text = normalizedEntry(params.entry);
				if (!text) throw new HarnessError("INVALID_ARTIFACT", "Workflow ledger entry must not be empty");
				const appended = await store.append({
					schemaVersion: 1,
					id: scope.id,
					at: new Date().toISOString(),
					role: scope.role,
					...(scope.taskId ? { taskId: scope.taskId } : {}),
					...(scope.evaluationId ? { evaluationId: scope.evaluationId } : {}),
					text,
				});
				return result(appended.appended ? "Workflow ledger entry appended." : "Workflow ledger entry was already appended for this process attempt.", appended.entry);
			} catch (error) {
				throw new Error(describeHarnessError(error));
			}
		},
	});
}
