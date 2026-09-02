import { randomUUID } from "node:crypto";
import { sameRuntimeOwner } from "./activation.js";
import type { AgentProgress } from "./agent-progress.js";
import type { LogicalAgentState, RuntimeOwner } from "./api.js";

export interface SubagentUiWorkflowProvenance {
	readonly storyId: string;
	readonly slotId: string;
	readonly action?: string;
	readonly taskId?: string;
}

export interface SubagentUiAgentProjection {
	readonly agentId: string;
	readonly agent: string;
	readonly state: LogicalAgentState;
	readonly presentation: "foreground" | "background";
	readonly provider: string;
	readonly model: string;
	readonly effort: string;
	readonly tier?: string;
	readonly fast: boolean;
	readonly startedAt: string;
	readonly updatedAt: string;
	readonly progress?: AgentProgress;
	/** Whitelisted non-secret identity for a workflow-managed child. */
	readonly workflow?: SubagentUiWorkflowProvenance;
}

/** Bounded standalone background rows owned by the generic footer. */
export interface SubagentUiProjection {
	readonly owner: RuntimeOwner;
	readonly agents: readonly SubagentUiAgentProjection[];
	readonly overflow: number;
}

export interface SubagentUiWorkflowAgentProjection extends SubagentUiAgentProjection {
	readonly workflow: SubagentUiWorkflowProvenance;
}

/** Active workflow children for one story, unbounded for consumer-owned layout. */
export interface SubagentUiWorkflowProjection {
	readonly owner: RuntimeOwner;
	readonly storyId: string;
	readonly agents: readonly SubagentUiWorkflowAgentProjection[];
}

/** Immutable correlation carried by a Pi tool result into the transcript UI. */
export interface SubagentUiAgentRef {
	readonly owner: RuntimeOwner;
	readonly agentId: string;
}

export interface SubagentUiProjectionBinding {
	readonly id: string;
	readonly owner: RuntimeOwner;
	publish(agents: readonly SubagentUiAgentProjection[]): boolean;
	release(): boolean;
}

const ACTIVE_STATES = new Set<LogicalAgentState>(["launching", "running", "stopping"]);

/** Process-global, structured read model shared across isolated extension module graphs. */
export class SubagentUiProjectionRegistry {
	private binding: { id: string; owner: RuntimeOwner; agents: readonly SubagentUiAgentProjection[] } | undefined;
	private readonly listeners = new Set<() => void>();

	bind(owner: RuntimeOwner, id: string = randomUUID()): SubagentUiProjectionBinding {
		if (!id) throw new Error("Subagent UI binding id is required");
		this.binding = { id, owner: structuredClone(owner), agents: [] };
		this.changed();
		let active = true;
		return {
			id,
			owner: structuredClone(owner),
			publish: (agents) => {
				if (!active || this.binding?.id !== id || !sameRuntimeOwner(this.binding.owner, owner)) return false;
				this.binding = { id, owner: structuredClone(owner), agents: structuredClone(agents) };
				this.changed();
				return true;
			},
			release: () => {
				if (!active) return false;
				active = false;
				if (this.binding?.id !== id) return false;
				this.binding = undefined;
				this.changed();
				return true;
			},
		};
	}

	/** Owner-fenced lookup for event-driven transcript rows, including terminal agents. */
	lookup(ref: SubagentUiAgentRef): SubagentUiAgentProjection | undefined {
		const current = this.binding;
		if (!current || !ref?.agentId || !sameRuntimeOwner(current.owner, ref.owner)) return undefined;
		const agent = current.agents.find((candidate) => candidate.agentId === ref.agentId);
		return agent ? structuredClone(agent) : undefined;
	}

	project(maxRows = 3): SubagentUiProjection | undefined {
		if (!Number.isInteger(maxRows) || maxRows < 1) throw new Error("Subagent footer row limit must be a positive integer");
		const current = this.binding;
		if (!current) return undefined;
		const active = this.activeAgents(current.agents)
			.filter((agent) => agent.presentation === "background" && !agent.workflow);
		return {
			owner: structuredClone(current.owner),
			agents: structuredClone(active.slice(0, maxRows)),
			overflow: Math.max(0, active.length - maxRows),
		};
	}

	/** Active workflow-managed children for a dashboard to match by durable slot. */
	projectWorkflow(storyId: string): SubagentUiWorkflowProjection | undefined {
		if (!storyId) throw new Error("Workflow story id is required");
		const current = this.binding;
		if (!current) return undefined;
		const agents = this.activeAgents(current.agents)
			.filter((agent): agent is SubagentUiWorkflowAgentProjection => agent.workflow?.storyId === storyId);
		return {
			owner: structuredClone(current.owner),
			storyId,
			agents: structuredClone(agents),
		};
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	clear(): void {
		if (!this.binding) return;
		this.binding = undefined;
		this.changed();
	}

	private activeAgents(agents: readonly SubagentUiAgentProjection[]): SubagentUiAgentProjection[] {
		return agents
			.filter((agent) => ACTIVE_STATES.has(agent.state))
			.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.agentId.localeCompare(right.agentId));
	}

	private changed(): void {
		for (const listener of this.listeners) {
			try { listener(); } catch { /* rendering observers cannot affect process lifecycle */ }
		}
	}
}

// Versioned so /reload cannot retain a process-global registry without typed
// workflow provenance and workflow-aware footer filtering.
const UI_REGISTRY_KEY = Symbol.for("pibox:subagent-ui-projection-registry:v3");
type UiRegistryGlobal = typeof globalThis & { [UI_REGISTRY_KEY]?: SubagentUiProjectionRegistry };

export function getSubagentUiProjectionRegistry(): SubagentUiProjectionRegistry {
	const root = globalThis as UiRegistryGlobal;
	return root[UI_REGISTRY_KEY] ??= new SubagentUiProjectionRegistry();
}
