import type {
	ContinuationSpec,
	LaunchSpec,
	LogicalAgentHandle,
	LogicalAgentSnapshot,
	RuntimeOwner,
	SubagentEventListener,
	SubagentInspection,
	SubagentReplay,
	SubagentService,
	SubagentSubscription,
	TerminalResult,
} from "../../../subagent/api.js";
import { promptContextHashes } from "../../../subagent/prompt-context.js";

export type FakeRequest =
	| { kind: "launch"; agentId: string; spec: LaunchSpec }
	| { kind: "continue"; agentId: string; spec: ContinuationSpec };

export type FakeHandler = (request: FakeRequest) => Promise<Partial<TerminalResult> & Pick<TerminalResult, "status">> | Partial<TerminalResult> & Pick<TerminalResult, "status">;

interface Entry {
	handle: LogicalAgentHandle;
	stableSystemContext: string;
	snapshot: LogicalAgentSnapshot;
	result?: Promise<TerminalResult>;
	resolveStop: ((result: TerminalResult) => void) | undefined;
	last?: TerminalResult;
}

export const fakeOwner: RuntimeOwner = { sessionId: "session-test", processInstanceId: "process-test", activationId: "activation-test" };

export class FakeSubagentService implements SubagentService {
	readonly protocolVersion = 1;
	readonly owner: RuntimeOwner;
	readonly requests: FakeRequest[] = [];
	readonly released: string[] = [];
	private readonly entries = new Map<string, Entry>();
	private nextId = 0;
	private cursor = 0;

	constructor(private readonly handler: FakeHandler = () => ({ status: "completed", reason: "completed", exitCode: 0, text: "done" }), owner: RuntimeOwner = fakeOwner) {
		this.owner = owner;
	}

	async launch(spec: LaunchSpec) {
		this.assertOwner(spec.owner);
		await spec.beforeSpawn?.();
		const agentId = `service-agent-${++this.nextId}`;
		const handle = { owner: this.owner, agentId, continuationCapability: `cap-${agentId}` };
		const now = new Date().toISOString();
		const contextHashes = promptContextHashes(spec.stableSystemContext, spec.attemptUserPrompt);
		const entry: Entry = {
			handle,
			stableSystemContext: spec.stableSystemContext,
			resolveStop: undefined,
			snapshot: {
				handle, agent: spec.agent, state: "running", attemptId: `service-attempt-${this.nextId}`, contextHashes,
				provider: spec.provider, model: spec.model, effort: spec.effort, fast: spec.fast,
				...(spec.continuationKey ? { continuationKey: spec.continuationKey } : {}),
				...(spec.workflowMetadata ? { workflowMetadata: spec.workflowMetadata } : {}),
				...(spec.attemptMetadata ? { attemptMetadata: spec.attemptMetadata } : {}),
				startedAt: now, updatedAt: now,
			},
		};
		this.entries.set(agentId, entry);
		const request: FakeRequest = { kind: "launch", agentId, spec };
		this.requests.push(request);
		entry.result = this.run(entry, request);
		return { handle, result: entry.result };
	}

	async continue(spec: ContinuationSpec) {
		this.assertOwner(spec.owner);
		await spec.beforeSpawn?.();
		const entry = this.require(spec.handle);
		if (entry.snapshot.state === "running" || entry.snapshot.state === "launching" || entry.snapshot.state === "stopping") throw new Error("active writer");
		entry.snapshot = { ...entry.snapshot, state: "running", attemptId: `service-attempt-${++this.nextId}`, contextHashes: promptContextHashes(entry.stableSystemContext, spec.attemptUserPrompt), ...(spec.attemptMetadata ? { attemptMetadata: spec.attemptMetadata } : {}), updatedAt: new Date().toISOString() };
		const request: FakeRequest = { kind: "continue", agentId: spec.handle.agentId, spec };
		this.requests.push(request);
		entry.result = this.run(entry, request);
		return { handle: entry.handle, result: entry.result };
	}

	async wait(owner: RuntimeOwner, handle: LogicalAgentHandle): Promise<TerminalResult> {
		this.assertOwner(owner);
		const entry = this.require(handle);
		if (entry.result) return entry.result;
		if (entry.last) return entry.last;
		throw new Error("no attempt");
	}

	inspect(owner: RuntimeOwner, query: SubagentInspection = {}): readonly LogicalAgentSnapshot[] {
		this.assertOwner(owner);
		return [...this.entries.values()].map((entry) => entry.snapshot).filter((snapshot) => {
			if (query.handle && snapshot.handle.agentId !== query.handle.agentId) return false;
			return !query.workflowMetadata || Object.entries(query.workflowMetadata).every(([key, value]) => snapshot.workflowMetadata?.[key] === value);
		});
	}

	async stop(owner: RuntimeOwner, handle: LogicalAgentHandle): Promise<void> {
		this.assertOwner(owner);
		const entry = this.require(handle);
		if (entry.snapshot.state !== "running" && entry.snapshot.state !== "launching" && entry.snapshot.state !== "stopping") throw new Error("inactive handle");
		const result = this.terminal(entry, { status: "cancelled", reason: "explicit_stop", exitCode: null, text: "" });
		entry.resolveStop?.(result);
		entry.last = result;
		entry.snapshot = { ...entry.snapshot, state: "cancelled", updatedAt: new Date().toISOString() };
	}

	async release(owner: RuntimeOwner, handle: LogicalAgentHandle): Promise<void> {
		this.assertOwner(owner);
		const entry = this.require(handle);
		if (entry.snapshot.state === "running" || entry.snapshot.state === "launching" || entry.snapshot.state === "stopping") throw new Error("active handle");
		this.entries.delete(handle.agentId);
		this.released.push(handle.agentId);
	}

	replay(owner: RuntimeOwner): SubagentReplay {
		this.assertOwner(owner);
		return { snapshot: { owner: this.owner, cursor: this.cursor, agents: this.inspect(owner) }, events: [], reset: false };
	}

	subscribe(owner: RuntimeOwner, _afterCursor: number, _listener: SubagentEventListener): SubagentSubscription {
		return { initial: this.replay(owner), unsubscribe() {} };
	}

	teardown(): void {}

	private async run(entry: Entry, request: FakeRequest): Promise<TerminalResult> {
		const stopped = new Promise<TerminalResult>((resolve) => { entry.resolveStop = resolve; });
		const handled = Promise.resolve(this.handler(request)).then((partial) => this.terminal(entry, partial));
		const result = await Promise.race([handled, stopped]);
		entry.resolveStop = undefined;
		entry.last = result;
		entry.snapshot = { ...entry.snapshot, state: result.status, updatedAt: new Date().toISOString(), summary: result.text };
		this.cursor++;
		return result;
	}

	private terminal(entry: Entry, partial: Partial<TerminalResult> & Pick<TerminalResult, "status">): TerminalResult {
		return {
			owner: this.owner,
			handle: entry.handle,
			attemptId: entry.snapshot.attemptId ?? "service-attempt",
			contextHashes: partial.contextHashes ?? entry.snapshot.contextHashes ?? promptContextHashes(entry.stableSystemContext, ""),
			status: partial.status,
			reason: partial.reason ?? (partial.status === "completed" ? "completed" : partial.status === "cancelled" ? "explicit_stop" : "failure"),
			exitCode: partial.exitCode ?? (partial.status === "completed" ? 0 : 1),
			text: partial.text ?? "",
			...(partial.stderr ? { stderr: partial.stderr } : {}),
			...(partial.progress ? { progress: partial.progress } : {}),
		};
	}

	private require(handle: LogicalAgentHandle): Entry {
		const entry = this.entries.get(handle.agentId);
		if (!entry || entry.handle.continuationCapability !== handle.continuationCapability) throw new Error("stale handle");
		return entry;
	}

	private assertOwner(owner: RuntimeOwner): void {
		if (owner.sessionId !== this.owner.sessionId || owner.processInstanceId !== this.owner.processInstanceId || owner.activationId !== this.owner.activationId) throw new Error("wrong owner");
	}
}
