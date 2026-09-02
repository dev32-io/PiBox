import { createHash } from "node:crypto";
import type { ProviderRoute } from "../provider-fallback/index.js";
import { classifyProviderFailure, defaultProviderCooldowns, isFallbackEligible, type ProviderCooldowns } from "../provider-fallback/index.js";
import type { LogicalAgentSnapshot, SubagentService, TerminalResult } from "../subagent/api.js";
import { PIBOX_RUNTIME_ROLE_ENV, PIBOX_SUBAGENT_RUNTIME_ROLE } from "../subagent/tool-policy.js";

const ACTIVE = new Set(["launching", "running", "stopping"]);
const STORY = "PIBOX_WORKFLOW_STORY_ID";
const SLOT = "PIBOX_WORKFLOW_SLOT_ID";
const TOKEN = "PIBOX_WORKFLOW_ATTEMPT_TOKEN";

export interface WorkflowSubagentLaunchInput {
	storyId: string;
	slotId: string;
	attemptToken: string;
	action: string;
	role: string;
	cwd: string;
	stableSystemContext: string;
	attemptUserPrompt: string;
	provider: string;
	model: string;
	effort: string;
	providerCandidates?: ProviderRoute[];
	tools: string[];
	extensionPaths?: string[];
	skillPaths?: string[];
	fast?: boolean;
	taskId?: string;
	env?: Record<string, string>;
	signal?: AbortSignal;
	beforeSpawn?: () => void | Promise<void>;
}

export interface WorkflowSubagentResult {
	exitCode: number;
	provider: string;
	model: string;
	effort: string;
	text: string;
	stderr: string;
	terminalReason: TerminalResult["reason"];
	serviceAttemptId: string;
}

function sameRoute(left: ProviderRoute, right: ProviderRoute): boolean { return left.provider === right.provider && left.model === right.model && left.effort === right.effort; }
function configurationKey(input: WorkflowSubagentLaunchInput, route: ProviderRoute): string {
	return createHash("sha256").update(JSON.stringify({ role: input.role, cwd: input.cwd, provider: route.provider, model: route.model, effort: route.effort, tools: input.tools, extensionPaths: input.extensionPaths ?? [], skillPaths: input.skillPaths ?? [], fast: Boolean(input.fast), stableSystemContext: input.stableSystemContext })).digest("hex");
}
function splitCredentials(env: Readonly<Record<string, string>>): { environment: Record<string, string>; credentials: Record<string, string> } {
	const environment: Record<string, string> = {}; const credentials: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) (/(?:CREDENTIAL|TOKEN|SECRET|PASSWORD|API_KEY)/i.test(key) ? credentials : environment)[key] = value;
	return { environment, credentials };
}
function result(route: ProviderRoute, terminal: TerminalResult): WorkflowSubagentResult {
	return { exitCode: terminal.status === "completed" ? terminal.exitCode ?? 0 : terminal.exitCode && terminal.exitCode !== 0 ? terminal.exitCode : 1, provider: route.provider, model: route.model, effort: route.effort, text: terminal.text, stderr: terminal.stderr ?? "", terminalReason: terminal.reason, serviceAttemptId: terminal.attemptId };
}

/** Narrow, in-memory workflow consumer of the process-global SubagentService. */
export class WorkflowSubagentLauncher {
	constructor(readonly service: SubagentService, readonly extensionPaths: readonly string[] = [], readonly cooldowns: ProviderCooldowns = defaultProviderCooldowns) {
		if (!service) throw new Error("WorkflowSubagentLauncher requires SubagentService");
	}

	private metadata(storyId: string, slotId?: string): Record<string, string> { return { [STORY]: storyId, ...(slotId ? { [SLOT]: slotId } : {}) }; }
	private snapshots(storyId: string, slotId?: string): readonly LogicalAgentSnapshot[] { return this.service.inspect(this.service.owner, { workflowMetadata: this.metadata(storyId, slotId) }); }
	activeCount(storyId?: string): number { return (storyId ? this.snapshots(storyId) : this.service.inspect(this.service.owner)).filter((agent) => ACTIVE.has(agent.state)).length; }
	/** Wake schedulers when any activation-owned child frees shared process capacity. */
	subscribeCapacity(listener: () => void): () => void {
		const replay = this.service.replay(this.service.owner);
		const subscription = this.service.subscribe(this.service.owner, replay.snapshot.cursor, (event) => {
			if (event.type === "terminal") listener();
		});
		if (subscription.initial.events.some((event) => event.type === "terminal")) queueMicrotask(listener);
		return () => subscription.unsubscribe();
	}

	async launch(input: WorkflowSubagentLaunchInput): Promise<WorkflowSubagentResult> {
		if (input.signal?.aborted) throw input.signal.reason;
		const primary = { provider: input.provider, model: input.model, effort: input.effort };
		const configured = input.providerCandidates?.length ? input.providerCandidates : [primary];
		const routes = configured.some((route) => sameRoute(route, primary)) ? [...configured] : [primary, ...configured];
		const workflowMetadata = this.metadata(input.storyId, input.slotId);
		const { environment, credentials } = splitCredentials(input.env ?? {});
		let last: WorkflowSubagentResult | undefined;

		for (const [routeIndex, route] of routes.entries()) {
			if (!this.cooldowns.available(route.provider)) continue;
			const continuationKey = configurationKey(input, route);
			const candidates = this.snapshots(input.storyId, input.slotId);
			const exact = candidates.find((agent) => agent.attemptMetadata?.[TOKEN] === input.attemptToken && agent.provider === route.provider && agent.model === route.model && agent.effort === route.effort && agent.continuationKey === continuationKey);
			let handle;
			let terminalPromise: Promise<TerminalResult>;
			if (exact) {
				handle = exact.handle;
				terminalPromise = this.service.wait(this.service.owner, exact.handle);
			} else {
				const attemptMetadata = {
					[TOKEN]: input.attemptToken,
					PIBOX_WORKFLOW_ACTION: input.action,
					PIBOX_WORKFLOW_ROUTE_INDEX: String(routeIndex),
					PIBOX_WORKFLOW_STORY_ID: input.storyId,
					...(input.taskId ? { PIBOX_WORKFLOW_TASK_ID: input.taskId } : {}),
					[PIBOX_RUNTIME_ROLE_ENV]: PIBOX_SUBAGENT_RUNTIME_ROLE,
				};
				const reusable = candidates.filter((agent) => !ACTIVE.has(agent.state) && agent.continuationKey === continuationKey).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
				await input.beforeSpawn?.();
				const beforeSpawn = input.beforeSpawn ? { beforeSpawn: input.beforeSpawn } : {};
				const started = reusable
					? await this.service.continue({ owner: this.service.owner, handle: reusable.handle, attemptUserPrompt: input.attemptUserPrompt, attemptMetadata, env: environment, workflowCredentials: credentials, ...beforeSpawn })
					: await this.service.launch({ owner: this.service.owner, agent: input.role, cwd: input.cwd, stableSystemContext: input.stableSystemContext, attemptUserPrompt: input.attemptUserPrompt, provider: route.provider, model: route.model, effort: route.effort, tools: input.tools, extensionPaths: [...(input.extensionPaths ?? this.extensionPaths)], skillPaths: input.skillPaths ?? [], fast: Boolean(input.fast), continuationKey, env: environment, workflowCredentials: credentials, workflowMetadata, attemptMetadata, ...beforeSpawn });
				handle = started.handle;
				terminalPromise = started.result;
			}
			const stop = () => { void this.service.stop(this.service.owner, handle).catch(() => undefined); };
			if (input.signal) input.signal.addEventListener("abort", stop, { once: true });
			let terminal: TerminalResult;
			try { terminal = await terminalPromise; }
			finally { input.signal?.removeEventListener("abort", stop); }
			last = result(route, terminal);
			const failure = classifyProviderFailure(last, input.signal);
			if (terminal.reason === "failure" && isFallbackEligible(failure)) {
				this.cooldowns.mark(route.provider, failure.cooldownMs);
				if (routes.slice(routeIndex + 1).some((candidate) => this.cooldowns.available(candidate.provider))) continue;
			}
			return last;
		}
		return last ?? { exitCode: 1, provider: primary.provider, model: primary.model, effort: primary.effort, text: "", stderr: "All configured provider routes are cooling down", terminalReason: "failure", serviceAttemptId: "unavailable" };
	}

	async stopStory(storyId: string): Promise<number> {
		const active = this.snapshots(storyId).filter((agent) => ACTIVE.has(agent.state));
		await Promise.all(active.map(async (agent) => { await this.service.stop(this.service.owner, agent.handle); await this.service.wait(this.service.owner, agent.handle); }));
		return active.length;
	}

	async releaseStory(storyId: string): Promise<number> {
		const settled = this.snapshots(storyId).filter((agent) => !ACTIVE.has(agent.state));
		await Promise.all(settled.map((agent) => this.service.release(this.service.owner, agent.handle)));
		return settled.length;
	}
}
