import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_TOOLS_SUBAGENT_ENV, PIBOX_RUNTIME_ROLE_ENV, PIBOX_SUBAGENT_RUNTIME_ROLE, SUBAGENT_CONTROL_TOOLS, usesAllTools } from "./tool-policy.js";

export interface SubagentInvocationRequest {
	readonly agentId: string;
	readonly attemptId: string;
	readonly agent: string;
	readonly cwd: string;
	readonly stableSystemContext: string;
	readonly attemptUserPrompt: string;
	readonly transcriptPath: string;
	readonly continuation: boolean;
	readonly provider: string;
	readonly model: string;
	readonly effort: string;
	readonly tools: readonly string[];
	readonly extensionPaths: readonly string[];
	readonly skillPaths: readonly string[];
	readonly fast: boolean;
	readonly env?: Readonly<Record<string, string>>;
	readonly workflowCredentials?: Readonly<Record<string, string>>;
	readonly workflowMetadata?: Readonly<Record<string, string>>;
	readonly attemptMetadata?: Readonly<Record<string, string>>;
}

export interface SubagentInvocation {
	readonly command: string;
	readonly args: readonly string[];
	readonly env?: Readonly<Record<string, string | undefined>>;
}

export type SubagentInvocationResolver = (request: SubagentInvocationRequest) => SubagentInvocation | Promise<SubagentInvocation>;

export interface PiInvocationResolverOptions {
	/** Raw Pi command override, primarily for packaged launchers. */
	readonly piInvocation?: SubagentInvocation;
	readonly lifetimeTermGraceMs?: number;
}

export const LIFETIME_WRAPPER_PATH = fileURLToPath(new URL("./lifetime-wrapper.mjs", import.meta.url));
/** Consumed by the standalone fast-mode extension when explicitly loaded. */
export const SUBAGENT_FAST_ENV = "PIBOX_FAST_CHILD_ENABLED";

/** Wrap an invocation in the stdin liveness-lease helper. */
export function createLifetimeWrappedInvocation(invocation: SubagentInvocation, termGraceMs = 1_000): SubagentInvocation {
	if (!Number.isFinite(termGraceMs) || termGraceMs < 0) throw new Error("termGraceMs must be a non-negative number");
	return {
		command: process.execPath,
		args: [LIFETIME_WRAPPER_PATH, "--", invocation.command, ...invocation.args],
		env: {
			...invocation.env,
			PIBOX_LIFETIME_TERM_GRACE_MS: String(Math.floor(termGraceMs)),
		},
	};
}

/** Production resolver for one bounded Pi JSON turn against a private transcript. */
export function createPiInvocationResolver(options: PiInvocationResolverOptions = {}): SubagentInvocationResolver {
	return (request) => {
		const pi = options.piInvocation ?? currentPiInvocation();
		const allTools = usesAllTools(request.tools);
		const toolArgs = allTools
			? ["--exclude-tools", SUBAGENT_CONTROL_TOOLS.join(",")]
			: request.tools.length > 0 ? ["--tools", request.tools.join(",")] : ["--no-tools"];
		const args = [
			...pi.args,
			...request.extensionPaths.flatMap((path) => ["--extension", path]),
			"--mode", "json", "-p",
			"--session", request.transcriptPath,
			"--name", request.agent,
			"--provider", request.provider,
			"--model", request.model,
			"--thinking", request.effort,
			...toolArgs,
			...(request.stableSystemContext ? ["--append-system-prompt", request.stableSystemContext] : []),
			...request.skillPaths.flatMap((path) => ["--skill", path]),
			"--", request.attemptUserPrompt,
		];
		const env = {
			...pi.env,
			...request.env,
			...request.attemptMetadata,
			...request.workflowMetadata,
			...request.workflowCredentials,
			...(allTools ? { [ALL_TOOLS_SUBAGENT_ENV]: "1" } : {}),
			[PIBOX_RUNTIME_ROLE_ENV]: PIBOX_SUBAGENT_RUNTIME_ROLE,
			[SUBAGENT_FAST_ENV]: request.fast ? "1" : "0",
		};
		return createLifetimeWrappedInvocation({ command: pi.command, args, env }, options.lifetimeTermGraceMs);
	};
}

function currentPiInvocation(): SubagentInvocation {
	const current = process.argv[1];
	if (current && !current.startsWith("/$bunfs/root/")) return { command: process.execPath, args: [current] };
	const executable = basename(process.execPath).toLowerCase();
	return /^(node|bun)(\.exe)?$/.test(executable)
		? { command: "pi", args: [] }
		: { command: process.execPath, args: [] };
}
