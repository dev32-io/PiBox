import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_EXTENSION_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");
const ROLE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "roles");

export interface DirectAgentOptions {
	role: string;
	task: string;
	cwd: string;
	provider: string;
	model: string;
	effort: string;
	tools: string[];
	signal?: AbortSignal;
	onText?: (text: string) => void;
	onSpawn?: (pid: number | undefined) => void;
	promptPath?: string;
	env?: Record<string, string>;
}

export interface DirectAgentResult {
	exitCode: number;
	role: string;
	provider: string;
	model: string;
	effort: string;
	text: string;
	stderr: string;
	events: unknown[];
}

function invocation(args: string[]): { command: string; args: string[] } {
	const current = process.argv[1];
	if (current && !current.startsWith("/$bunfs/root/")) return { command: process.execPath, args: [current, ...args] };
	const executable = basename(process.execPath).toLowerCase();
	return /^(node|bun)(\.exe)?$/.test(executable) ? { command: "pi", args } : { command: process.execPath, args };
}

function extractText(event: unknown): string {
	const value = event as { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
	if (value.type !== "message_end" || value.message?.role !== "assistant") return "";
	return value.message.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "";
}

export async function runDirectAgent(options: DirectAgentOptions): Promise<DirectAgentResult> {
	const directory = await mkdtemp(join(tmpdir(), "pibox-role-"));
	const promptFile = join(directory, `${options.role}.md`);
	let rolePrompt: string;
	try {
		rolePrompt = await readFile(options.promptPath ?? join(ROLE_ROOT, `${options.role}.md`), "utf8");
	} catch {
		rolePrompt = `You are the PiBox ${options.role} specialist. Return a concise, evidence-grounded report to the main orchestrator. Do not claim authority over user intent or workflow decisions.`;
	}
	await writeFile(promptFile, rolePrompt, { encoding: "utf8", mode: 0o600 });
	const args = [
		"-e", HARNESS_EXTENSION_PATH,
		"--mode", "json", "-p", "--no-session",
		"--model", `${options.provider}/${options.model}`,
		"--thinking", options.effort,
		"--tools", options.tools.join(","),
		"--append-system-prompt", promptFile,
		options.task,
	];
	const selected = invocation(args);
	const events: unknown[] = [];
	let stderr = "";
	let buffer = "";
	try {
		const exitCode = await new Promise<number>((resolveExit) => {
			const child = spawn(selected.command, selected.args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, ...options.env },
			});
			options.onSpawn?.(child.pid);
			const processLine = (line: string) => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line) as unknown;
					events.push(event);
					const text = extractText(event);
					if (text) options.onText?.(text);
				} catch {
					stderr += `Unparsed child output: ${line}\n`;
				}
			};
			child.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			child.stderr.on("data", (data) => (stderr += data.toString()));
			child.on("error", (error) => {
				stderr += error.message;
				resolveExit(1);
			});
			child.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolveExit(code ?? 1);
			});
			if (options.signal) {
				const abort = () => child.kill("SIGTERM");
				if (options.signal.aborted) abort();
				else options.signal.addEventListener("abort", abort, { once: true });
			}
		});
		let text = "";
		for (let index = events.length - 1; index >= 0; index--) {
			text = extractText(events[index]);
			if (text) break;
		}
		return { exitCode, role: options.role, provider: options.provider, model: options.model, effort: options.effort, text, stderr, events };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
