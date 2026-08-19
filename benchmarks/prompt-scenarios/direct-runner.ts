import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../extensions/workflow/types.js";
import { runBoundedProcess } from "./route.js";
import type { PromptSubjectRunner } from "./types.js";

const BENCHMARK_BOUNDARY = `# Prompt benchmark subject boundary

You are a benchmark subject, not an implementation worker. Answer only the supplied fictional prompt scenario. Do not inspect or modify any repository, run commands, call tools, delegate, create workflow state, or make network requests other than the selected model request. Produce only the requested benchmark output. Recursive delegation is unavailable.`;

function extractText(event: unknown): string {
	const value = event as { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
	if (value.type !== "message_end" || value.message?.role !== "assistant") return "";
	return value.message.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "";
}

export interface DirectRunnerOptions { command?: string; graceMs?: number; onInvocation?: (invocation: { cwd: string; args: string[] }) => void }

export function createDirectPromptSubjectRunner(_repositoryRoot: string, agent: AgentConfig, options: DirectRunnerOptions = {}): PromptSubjectRunner {
	if (!agent.prompt) throw new Error("The configured general-purpose agent has no prompt definition.");
	return { async run(request) {
		const isolatedCwd = await mkdtemp(join(request.outputDirectory, "subject-cwd-")); await chmod(isolatedCwd, 0o700);
		try {
			const definition = await readFile(agent.prompt!, "utf8");
			const systemPrompt = `${parseFrontmatter<Record<string, unknown>>(definition).body.trim()}\n\n${BENCHMARK_BOUNDARY}\n`;
			const promptPath = join(isolatedCwd, "system.md"); await writeFile(promptPath, systemPrompt, { mode: 0o600 });
			const args = [
				"--no-approve", "--no-extensions",
				...(request.route.providerExtension.path ? ["-e", request.route.providerExtension.path] : []),
				"--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-tools",
				"--mode", "json", "-p", "--no-session", "--model", `${request.route.provider}/${request.route.model}`,
				"--thinking", request.route.effort, "--append-system-prompt", promptPath, request.prompt,
			];
			options.onInvocation?.({ cwd: isolatedCwd, args: [...args] });
			const processResult = await runBoundedProcess({ command: options.command ?? "pi", args, cwd: isolatedCwd, env: { ...process.env, PIBOX_PROMPT_BENCHMARK_SUBJECT: "1", PIBOX_PERMISSION_MODE: "enforced" }, timeoutMs: request.timeoutMs, ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}) });
			const events: unknown[] = []; const malformed: string[] = [];
			for (const line of processResult.stdout.split("\n")) {
				if (!line.trim()) continue;
				try { events.push(JSON.parse(line)); } catch { malformed.push(line); }
			}
			await writeFile(join(request.outputDirectory, "stdout.jsonl"), processResult.stdout, { mode: 0o600 });
			let text = ""; for (let index = events.length - 1; index >= 0; index--) { text = extractText(events[index]); if (text) break; }
			const timeout = processResult.timedOut ? `Benchmark subject timed out after ${request.timeoutMs}ms (signals: ${processResult.signals.join(" -> ")}).` : "";
			const parseErrors = malformed.length ? `Unparsed child output:\n${malformed.join("\n")}\n` : "";
			return { exitCode: processResult.timedOut ? 1 : processResult.exitCode, provider: request.route.provider, model: request.route.model, effort: request.route.effort, text, stderr: `${processResult.stderr}${parseErrors}${timeout}`, events };
		} finally { await rm(isolatedCwd, { recursive: true, force: true }); }
	} };
}
