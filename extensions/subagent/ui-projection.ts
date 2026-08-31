import { randomUUID } from "node:crypto";
import { sameRuntimeOwner } from "./activation.js";
import type { AgentProgress } from "./agent-progress.js";
import type { LogicalAgentState, RuntimeOwner } from "./api.js";

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
}

export interface SubagentUiProjection {
	readonly owner: RuntimeOwner;
	readonly agents: readonly SubagentUiAgentProjection[];
	readonly overflow: number;
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

	project(maxRows = 3): SubagentUiProjection | undefined {
		if (!Number.isInteger(maxRows) || maxRows < 1) throw new Error("Subagent footer row limit must be a positive integer");
		const current = this.binding;
		if (!current) return undefined;
		const active = current.agents
			.filter((agent) => ACTIVE_STATES.has(agent.state) && agent.presentation === "background")
			.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.agentId.localeCompare(right.agentId));
		return {
			owner: structuredClone(current.owner),
			agents: structuredClone(active.slice(0, maxRows)),
			overflow: Math.max(0, active.length - maxRows),
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

	private changed(): void {
		for (const listener of this.listeners) {
			try { listener(); } catch { /* rendering observers cannot affect process lifecycle */ }
		}
	}
}

const UI_REGISTRY_KEY = Symbol.for("pibox:subagent-ui-projection-registry:v1");
type UiRegistryGlobal = typeof globalThis & { [UI_REGISTRY_KEY]?: SubagentUiProjectionRegistry };

export function getSubagentUiProjectionRegistry(): SubagentUiProjectionRegistry {
	const root = globalThis as UiRegistryGlobal;
	return root[UI_REGISTRY_KEY] ??= new SubagentUiProjectionRegistry();
}
