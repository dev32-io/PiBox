import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { LoadedHarnessConfig, ModelTier } from "../../extensions/workflow/types.js";
import { LOCAL_LLM_THINKING_LEVEL_MAP } from "../../extensions/providers/local-llm/index.js";
import { OLLAMA_CLOUD_MODEL_METADATA } from "../../extensions/providers/ollama-cloud/model-metadata.js";
import type { ProviderExtensionSelection, ResolvedSubjectRoute } from "./types.js";

export interface AvailableModelIdentity { provider: string; model: string; thinking: boolean }
export interface BoundedProcessResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean; signals: Array<"SIGTERM" | "SIGKILL"> }

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
	if (!pid) return;
	try { process.kill(process.platform === "win32" ? pid : -pid, signal); }
	catch { try { process.kill(pid, signal); } catch { /* already settled */ } }
}

/** A process-group timeout that always settles, including when descendants or the
 * direct child ignore SIGTERM. Exported so the escalation boundary is testable. */
export async function runBoundedProcess(options: { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; graceMs?: number }): Promise<BoundedProcessResult> {
	const graceMs = options.graceMs ?? 1_000;
	return new Promise((resolveResult) => {
		let stdout = ""; let stderr = ""; let settled = false; let timedOut = false;
		const signals: Array<"SIGTERM" | "SIGKILL"> = [];
		const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env ?? process.env, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		const finish = (exitCode: number) => { if (settled) return; settled = true; clearTimeout(termTimer); if (killTimer) clearTimeout(killTimer); if (settlementTimer) clearTimeout(settlementTimer); resolveResult({ exitCode, stdout, stderr, timedOut, signals }); };
		child.on("error", (error) => { stderr += `${error.message}\n`; finish(1); });
		child.on("close", (code, signal) => finish(code ?? (signal ? 1 : 0)));
		let killTimer: NodeJS.Timeout | undefined;
		let settlementTimer: NodeJS.Timeout | undefined;
		const termTimer = setTimeout(() => {
			timedOut = true; signals.push("SIGTERM"); signalGroup(child.pid, "SIGTERM");
			killTimer = setTimeout(() => {
				signals.push("SIGKILL"); signalGroup(child.pid, "SIGKILL");
				settlementTimer = setTimeout(() => finish(1), Math.max(250, graceMs));
				settlementTimer.unref();
			}, graceMs); killTimer.unref();
		}, options.timeoutMs); termTimer.unref();
	});
}

export function parseAvailableModels(output: string): AvailableModelIdentity[] {
	const identities: AvailableModelIdentity[] = [];
	for (const line of output.split("\n").slice(1)) {
		const columns = line.trim().split(/\s+/);
		if (columns.length >= 6) identities.push({ provider: columns[0]!, model: columns[1]!, thinking: columns[4] === "yes" });
	}
	return identities;
}

function parseConfiguredRoute(route: string): { provider: string; model: string; effort: string } {
	const providerSeparator = route.indexOf("/"); const effortSeparator = route.lastIndexOf("#");
	if (providerSeparator <= 0 || effortSeparator <= providerSeparator + 1 || effortSeparator === route.length - 1) throw new Error(`Invalid configured route: ${route}`);
	return { provider: route.slice(0, providerSeparator), model: route.slice(providerSeparator + 1, effortSeparator), effort: route.slice(effortSeparator + 1) };
}

let builtinRuntime: Promise<ModelRuntime> | undefined;
const runtime = () => builtinRuntime ??= ModelRuntime.create({ allowModelNetwork: false });

export async function providerExtensionSelection(repositoryRoot: string, provider: string): Promise<ProviderExtensionSelection> {
	const builtIn = (await runtime()).getModels(provider).length > 0;
	if (builtIn) return { provider, kind: "builtin" };
	const trusted: Record<string, string> = {
		"local-llm": "extensions/providers/local-llm/index.ts",
		"ollama-cloud": "extensions/providers/ollama-cloud/index.ts",
	};
	const relative = trusted[provider];
	if (!relative) throw new Error(`Unsupported custom provider '${provider}'. Prompt benchmarks load only built-in providers or the trusted repository providers: ${Object.keys(trusted).join(", ")}.`);
	return { provider, kind: "trusted-repository-extension", path: resolve(repositoryRoot, relative) };
}

export async function listAvailableModels(repositoryRoot: string, selection: ProviderExtensionSelection): Promise<{ models: AvailableModelIdentity[]; command: string }> {
	const cwd = await mkdtemp(resolve(tmpdir(), "pibox-prompt-models-")); await chmod(cwd, 0o700);
	const args = ["--no-approve", "--no-extensions", ...(selection.path ? ["-e", selection.path] : []), "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--list-models"];
	try {
		const result = await runBoundedProcess({ command: "pi", args, cwd, timeoutMs: 60_000, graceMs: 1_000 });
		if (result.exitCode !== 0 || result.timedOut) throw new Error(`isolated pi --list-models failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
		return { models: parseAvailableModels(result.stdout), command: `cd <isolated-cwd> && pi ${args.join(" ")}` };
	} finally { await rm(cwd, { recursive: true, force: true }); }
}

async function supportedEfforts(identity: AvailableModelIdentity): Promise<string[]> {
	const builtIn = (await runtime()).getModel(identity.provider, identity.model);
	if (builtIn) return getSupportedThinkingLevels(builtIn);
	if (identity.provider === "local-llm") return getSupportedThinkingLevels({ reasoning: true, thinkingLevelMap: LOCAL_LLM_THINKING_LEVEL_MAP } as Model<Api>);
	if (identity.provider === "ollama-cloud") {
		const metadata = OLLAMA_CLOUD_MODEL_METADATA[identity.model];
		return getSupportedThinkingLevels({ reasoning: metadata?.reasoning ?? identity.thinking, ...(metadata?.thinkingLevelMap ? { thinkingLevelMap: metadata.thinkingLevelMap } : {}) } as Model<Api>);
	}
	return identity.thinking ? ["off", "minimal", "low", "medium", "high"] : ["off"];
}

export type ModelLister = (root: string, selection: ProviderExtensionSelection) => Promise<{ models: AvailableModelIdentity[]; command: string }>;
export class BenchmarkRouteResolutionError extends Error {
	constructor(message: string, readonly attempts: ResolvedSubjectRoute["resolutionAttempts"]) { super(message); this.name = "BenchmarkRouteResolutionError"; }
}
export async function resolveBenchmarkRoute(loaded: LoadedHarnessConfig, tier: ModelTier, repositoryRoot: string, list: ModelLister = listAvailableModels): Promise<ResolvedSubjectRoute> {
	const configured = loaded.config.modelTiers[tier]; if (!configured?.length) throw new Error(`Harness tier '${tier}' has no configured routes.`);
	const attempts: ResolvedSubjectRoute["resolutionAttempts"] = [];
	for (let index = 0; index < configured.length; index++) {
		const configuredRoute = configured[index]!; const route = parseConfiguredRoute(configuredRoute);
		const extension = await providerExtensionSelection(repositoryRoot, route.provider);
		const available = await list(repositoryRoot, extension);
		const identity = available.models.find((entry) => entry.provider === route.provider && entry.model === route.model);
		if (!identity) { attempts.push({ configuredRoute, status: "model_missing", availabilityCommand: available.command, providerExtension: extension }); continue; }
		const efforts = await supportedEfforts(identity);
		if (!efforts.includes(route.effort)) { attempts.push({ configuredRoute, status: "effort_unsupported", supportedEfforts: efforts, availabilityCommand: available.command, providerExtension: extension }); continue; }
		attempts.push({ configuredRoute, status: "selected", supportedEfforts: efforts, availabilityCommand: available.command, providerExtension: extension });
		return { tier, configuredRoute, ...route, fallbackIndex: index, resolutionAttempts: attempts, providerExtension: extension };
	}
	throw new BenchmarkRouteResolutionError(`No usable model route for configured tier '${tier}'. ${attempts.map((attempt) => `${attempt.configuredRoute}: ${attempt.status}`).join("; ")}`, attempts);
}
