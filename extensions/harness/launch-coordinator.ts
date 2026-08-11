import { dirname, join } from "node:path";
import { SessionAgentRegistry, type AgentScope, type SessionAgentRecord } from "./agent-registry.js";
import { runDirectAgent, type DirectAgentResult } from "./direct-agent.js";

export interface CoordinatedLaunchInput extends AgentScope {
	operationId: string;
	role: string;
	task: string;
	assignment: unknown;
	cwd: string;
	provider: string;
	model: string;
	effort: string;
	tools: string[];
	promptPath?: string;
	rolePrompt?: string;
	skillPaths?: string[];
	env?: Record<string, string>;
	signal?: AbortSignal;
	onText?: (text: string) => void;
	onSpawn?: (pid: number | undefined) => void;
	invocationResolver?: (args: string[]) => { command: string; args: string[] };
	deferCompletion?: boolean;
}

export interface CoordinatedLaunchResult {
	agent: SessionAgentRecord;
	result: DirectAgentResult;
}

/** One process gateway for direct specialists. Managed task/evaluator adapters converge here incrementally. */
export class LaunchCoordinator {
	constructor(
		readonly registry: SessionAgentRegistry,
		readonly mainAgentId: string,
		readonly invocationResolver?: (args: string[]) => { command: string; args: string[] },
	) {}

	async launch(input: CoordinatedLaunchInput): Promise<CoordinatedLaunchResult> {
		const reserved = await this.registry.reserve({
			operationId: input.operationId,
			parentAgentId: this.mainAgentId,
			parentDepth: 0,
			role: input.role,
			provider: input.provider,
			model: input.model,
			effort: input.effort,
			assignment: input.assignment,
			...(input.workItemId ? { workItemId: input.workItemId } : {}),
			...(input.taskId ? { taskId: input.taskId } : {}),
			...(input.evaluationId ? { evaluationId: input.evaluationId } : {}),
			...(input.runId ? { runId: input.runId } : {}),
			...(input.workspace ? { workspace: input.workspace } : {}),
		});
		const { attempt } = await this.registry.startAttempt(reserved.id);
		const attemptRoot = join(this.registry.root, "agents", reserved.id, "attempts", attempt.id);
		let running: Promise<unknown> | undefined;
		const invocationResolver = input.invocationResolver ?? this.invocationResolver;
		try {
			const result = await runDirectAgent({
				role: input.role,
				task: input.task,
				cwd: input.cwd,
				provider: input.provider,
				model: input.model,
				effort: input.effort,
				tools: input.tools,
				outputDirectory: attemptRoot,
				env: {
					...input.env,
					PIBOX_HARNESS_ROOT_SESSION_ID: this.registry.sessionId,
					PIBOX_HARNESS_AGENT_ID: reserved.id,
					PIBOX_HARNESS_PARENT_AGENT_ID: this.mainAgentId,
					PIBOX_HARNESS_AGENT_DEPTH: String(reserved.depth),
					PIBOX_HARNESS_ATTEMPT_ID: attempt.id,
					PIBOX_HARNESS_AGENT_ROOT: join(this.registry.root, "agents", reserved.id),
					PIBOX_HARNESS_REPOSITORY_PRIVATE_ROOT: dirname(dirname(this.registry.root)),
					PIBOX_HARNESS_ASSIGNMENT_PATH: join(this.registry.root, reserved.assignmentPath),
					PIBOX_HARNESS_AGENT_ROLE: reserved.role,
				},
				...(input.promptPath ? { promptPath: input.promptPath } : {}),
				...(input.rolePrompt ? { rolePrompt: input.rolePrompt } : {}),
				...(input.skillPaths ? { skillPaths: input.skillPaths } : {}),
				...(input.signal ? { signal: input.signal } : {}),
				...(input.onText ? { onText: input.onText } : {}),
				...(invocationResolver ? { invocationResolver } : {}),
				onSpawn: (pid) => {
					if (pid) running = this.registry.markRunning(reserved.id, attempt.id, pid);
					input.onSpawn?.(pid);
				},
			});
			await running;
			await this.registry.recordExit(reserved.id, attempt.id, result.exitCode);
			const afterExit = await this.registry.get(reserved.id);
			if (["waiting_decision", "blocked", "paused", "interrupted", "recovery_required", "cancelled"].includes(afterExit.state)) return { agent: afterExit, result };
			if (result.exitCode === 0) {
				const reported = await this.registry.transition(reserved.id, "reported", { summary: result.text || `${input.role} completed` });
				return { agent: input.deferCompletion ? reported : await this.registry.transition(reserved.id, "completed"), result };
			}
			return { agent: await this.registry.transition(reserved.id, "failed", { error: result.stderr || result.text || `Child exited ${result.exitCode}` }), result };
		} catch (error) {
			await running?.catch(() => undefined);
			const current = await this.registry.get(reserved.id);
			if (current.state !== "failed" && current.state !== "cancelled") {
				await this.registry.transition(reserved.id, "failed", { error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
			}
			throw error;
		}
	}
}
