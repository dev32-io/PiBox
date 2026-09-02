import type { LogicalAgentHandle, RuntimeOwner, SubagentSnapshot } from "./api.js";

export type ActivationLifecycle = "startup" | "reload" | "new" | "resume" | "fork";

export function sameRuntimeOwner(left: RuntimeOwner, right: RuntimeOwner): boolean {
	return left.sessionId === right.sessionId
		&& left.processInstanceId === right.processInstanceId
		&& left.activationId === right.activationId;
}

export interface ActivationInput {
	readonly lifecycle: ActivationLifecycle;
	readonly sessionId: string;
	readonly processInstanceId: string;
	readonly activationId: string;
	readonly previous?: RuntimeOwner;
}

/** Pure lifecycle policy: reload preserves the live owner; every other entry starts a new activation. */
export function runtimeOwnerForActivation(input: ActivationInput): RuntimeOwner {
	if (input.lifecycle === "reload") {
		if (!input.previous) throw new Error("Reload requires the current runtime owner");
		if (input.previous.sessionId !== input.sessionId || input.previous.processInstanceId !== input.processInstanceId) {
			throw new Error("Reload cannot cross a persisted session or process instance");
		}
		return input.previous;
	}
	const owner = {
		sessionId: requireIdentity(input.sessionId, "sessionId"),
		processInstanceId: requireIdentity(input.processInstanceId, "processInstanceId"),
		activationId: requireIdentity(input.activationId, "activationId"),
	};
	if (input.previous && sameRuntimeOwner(owner, input.previous)) {
		throw new Error(`${input.lifecycle} must create a new activation`);
	}
	return owner;
}

export function assertContinuationOwner(owner: RuntimeOwner, handle: LogicalAgentHandle): void {
	if (!sameRuntimeOwner(owner, handle.owner)) throw new Error("Logical agent handle belongs to another runtime activation");
}

const ACTIVE_STATES = new Set(["launching", "running", "stopping"]);

/** Command guard used before changing the main session tree. */
export function assertTreeNavigationAllowed(owner: RuntimeOwner, snapshot: SubagentSnapshot): void {
	if (!sameRuntimeOwner(owner, snapshot.owner)) throw new Error("Subagent snapshot belongs to another runtime activation");
	if (snapshot.agents.some((agent) => ACTIVE_STATES.has(agent.state))) {
		throw new Error("Tree navigation is unavailable while subagents are active");
	}
}

function requireIdentity(value: string, name: string): string {
	if (!value) throw new Error(`${name} is required`);
	return value;
}
