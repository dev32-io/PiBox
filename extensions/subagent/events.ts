import { sameRuntimeOwner } from "./activation.js";
import type { RuntimeOwner, SubagentEvent, SubagentEventListener, SubagentEventType, SubagentReplay, SubagentSnapshot, SubagentSubscription } from "./api.js";

export interface AppendSubagentEvent {
	readonly agentId: string;
	readonly attemptId: string;
	readonly type: SubagentEventType;
	readonly at?: string;
	readonly data?: Readonly<Record<string, unknown>>;
}

interface RecordedEvent {
	event: SubagentEvent;
	snapshotAfter: SubagentSnapshot;
}

/** Bounded in-memory replay buffer for one activation. */
export class SubagentEventBuffer {
	private cursor = 0;
	private readonly initialSnapshot: SubagentSnapshot;
	private snapshot: SubagentSnapshot;
	private readonly records: RecordedEvent[] = [];
	private readonly listeners = new Set<SubagentEventListener>();
	private readonly attemptSequences = new Map<string, number>();
	private readonly attemptPhases = new Map<string, "open" | "exited" | "drained" | "terminal">();

	constructor(readonly owner: RuntimeOwner, initial: Omit<SubagentSnapshot, "owner" | "cursor"> = { agents: [] }, private readonly capacity = 256) {
		if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Event capacity must be a positive integer");
		this.initialSnapshot = cloneSnapshot({ ...initial, owner, cursor: 0 });
		this.snapshot = cloneSnapshot(this.initialSnapshot);
	}

	append(input: AppendSubagentEvent, snapshotAfter: Omit<SubagentSnapshot, "owner" | "cursor">): SubagentEvent {
		this.assertOrdering(input);
		const key = attemptKey(input.agentId, input.attemptId);
		const event: SubagentEvent = {
			owner: this.owner,
			cursor: ++this.cursor,
			agentId: input.agentId,
			attemptId: input.attemptId,
			sequence: (this.attemptSequences.get(key) ?? 0) + 1,
			type: input.type,
			at: input.at ?? new Date().toISOString(),
			...(input.data ? { data: structuredClone(input.data) } : {}),
		};
		this.attemptSequences.set(key, event.sequence);
		this.advancePhase(key, input.type);
		this.snapshot = cloneSnapshot({ ...snapshotAfter, owner: this.owner, cursor: event.cursor });
		this.records.push({ event, snapshotAfter: this.snapshot });
		if (this.records.length > this.capacity) this.records.shift();
		for (const listener of this.listeners) {
			try { listener(event); } catch { /* projection observers cannot affect lifecycle */ }
		}
		return event;
	}

	replay(owner: RuntimeOwner, afterCursor = this.cursor): SubagentReplay {
		this.assertOwner(owner);
		if (!Number.isInteger(afterCursor) || afterCursor < 0 || afterCursor > this.cursor) throw new Error("Invalid subagent event cursor");
		if (afterCursor === this.cursor) return { snapshot: cloneSnapshot(this.snapshot), events: [], reset: false };
		const firstCursor = this.records[0]?.event.cursor ?? this.cursor + 1;
		if (afterCursor < firstCursor - 1) return { snapshot: cloneSnapshot(this.snapshot), events: [], reset: true };
		const baseline = afterCursor === 0
			? this.initialSnapshot
			: this.records.find((record) => record.event.cursor === afterCursor)?.snapshotAfter;
		if (!baseline) return { snapshot: cloneSnapshot(this.snapshot), events: [], reset: true };
		return {
			snapshot: cloneSnapshot(baseline),
			events: this.records.filter((record) => record.event.cursor > afterCursor).map((record) => structuredClone(record.event)),
			reset: false,
		};
	}

	subscribe(owner: RuntimeOwner, afterCursor: number, listener: SubagentEventListener): SubagentSubscription {
		this.assertOwner(owner);
		const initial = this.replay(owner, afterCursor);
		this.listeners.add(listener);
		let subscribed = true;
		return {
			initial,
			unsubscribe: () => {
				if (!subscribed) return;
				subscribed = false;
				this.listeners.delete(listener);
			},
		};
	}

	close(): void {
		this.listeners.clear();
	}

	private assertOwner(owner: RuntimeOwner): void {
		if (!sameRuntimeOwner(owner, this.owner)) throw new Error("Subagent events belong to another runtime activation");
	}

	private assertOrdering(input: AppendSubagentEvent): void {
		const phase = this.attemptPhases.get(attemptKey(input.agentId, input.attemptId)) ?? "open";
		if (phase === "terminal") throw new Error("Cannot append an event after terminal settlement");
		if (phase === "exited" && input.type !== "output_drained") throw new Error("Only output drain may follow process exit");
		if (phase === "drained" && input.type !== "terminal") throw new Error("Only terminal settlement may follow output drain");
		if (phase === "open" && input.type === "output_drained") throw new Error("Output drain must follow process exit");
		if (phase === "open" && input.type === "terminal") throw new Error("Terminal settlement must follow output drain");
	}

	private advancePhase(key: string, type: SubagentEventType): void {
		if (type === "process_exited") this.attemptPhases.set(key, "exited");
		else if (type === "output_drained") this.attemptPhases.set(key, "drained");
		else if (type === "terminal") this.attemptPhases.set(key, "terminal");
	}
}

function attemptKey(agentId: string, attemptId: string): string {
	return `${agentId}\0${attemptId}`;
}

function cloneSnapshot(snapshot: SubagentSnapshot): SubagentSnapshot {
	return structuredClone(snapshot);
}
