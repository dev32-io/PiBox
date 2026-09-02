import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parseArgs, positiveInteger, validateBenchmarkPath } from "../cli.js";
import { createDirectPromptSubjectRunner } from "../direct-runner.js";
import { providerExtensionSelection, resolveBenchmarkRoute, runBoundedProcess } from "../route.js";
import { DEFAULT_HARNESS_CONFIG } from "../../../extensions/workflow/config.js";
import { activeModelTierLists } from "../../../extensions/model-tier-list-profiles/profiles.js";
import type { ResolvedSubjectRoute } from "../types.js";

const exec = promisify(execFile);
const route: ResolvedSubjectRoute = { tier: "local", configuredRoute: "local-llm/model#low", provider: "local-llm", model: "model", effort: "low", fallbackIndex: 0, resolutionAttempts: [{ configuredRoute: "local-llm/model#low", status: "selected", supportedEfforts: ["low"], availabilityCommand: "isolated", providerExtension: { provider: "local-llm", kind: "trusted-repository-extension", path: "/trusted/local.ts" } }], providerExtension: { provider: "local-llm", kind: "trusted-repository-extension", path: "/trusted/local.ts" } };

test("CLI rejects unknown options and bounded integers", () => {
	assert.throws(() => parseArgs(["--execute", "--surprise"]), /Unknown option/);
	assert.throws(() => parseArgs(["report", "--execute", "--run", "x"]), /Unknown option/);
	assert.throws(() => positiveInteger("11", 1, "repetitions", 10), /1 to 10/);
});

test("secure output validation rejects escapes and non-ignored paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "prompt-path-"));
	try {
		await exec("git", ["init", "-q"], { cwd: root });
		await writeFile(join(root, ".gitignore"), "/.benchmark/\n");
		assert.match((await validateBenchmarkPath(root, ".benchmark/runs")).target, /\.benchmark\/runs$/);
		await assert.rejects(() => validateBenchmarkPath(root, "../escape"), /must stay inside/);
		await assert.rejects(() => validateBenchmarkPath(root, "generated"), /must stay inside/);
		await mkdir(join(root, ".benchmark")); await symlink(tmpdir(), join(root, ".benchmark", "link"));
		await assert.rejects(() => validateBenchmarkPath(root, ".benchmark/link/run"), /must not contain symlinks/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("benchmark output must be Git-ignored even inside .benchmark", async () => {
	const root = await mkdtemp(join(tmpdir(), "prompt-unignored-"));
	try { await exec("git", ["init", "-q"], { cwd: root }); await assert.rejects(() => validateBenchmarkPath(root, ".benchmark/runs"), /not Git-ignored/); }
	finally { await rm(root, { recursive: true, force: true }); }
});

test("provider selection is explicit and fails closed for arbitrary custom providers", async () => {
	assert.equal((await providerExtensionSelection(process.cwd(), "openai-codex")).kind, "builtin");
	const trusted = await providerExtensionSelection(process.cwd(), "local-llm");
	assert.equal(trusted.kind, "trusted-repository-extension");
	assert.match(trusted.path!, /extensions\/providers\/local-llm\/index\.ts$/);
	await assert.rejects(() => providerExtensionSelection(process.cwd(), "arbitrary-plugin"), /Unsupported custom provider/);
});

test("route resolution distinguishes unsupported effort from missing model", async () => {
	const config = structuredClone(DEFAULT_HARNESS_CONFIG); activeModelTierLists(config.modelTierListProfiles, config.modelTierProfile).tiers.local = ["local-llm/model#minimal"];
	const loaded = { config, digest: "x", sources: [], diagnostics: [] };
	await assert.rejects(() => resolveBenchmarkRoute(loaded, "local", process.cwd(), async () => ({ models: [{ provider: "local-llm", model: "model", thinking: true }], command: "isolated list" })), /effort_unsupported/);
});

test("subject invocation uses isolated cwd and only the selected provider extension", async () => {
	const root = await mkdtemp(join(tmpdir(), "prompt-runner-")); const prompt = join(root, "general.md"); await writeFile(prompt, "---\nname: general-purpose\n---\nGeneral subject."); let invocation: { cwd: string; args: string[] } | undefined;
	try {
		const runner = createDirectPromptSubjectRunner(root, { prompt }, { command: process.execPath, onInvocation(value) { invocation = value; } });
		await runner.run({ route, prompt: "fixture", outputDirectory: root, timeoutMs: 2_000 });
		assert.ok(invocation); assert.notEqual(invocation.cwd, root); assert.ok(invocation.args.includes("--no-approve")); assert.ok(invocation.args.includes("--no-extensions")); assert.ok(invocation.args.includes("--no-context-files")); assert.ok(invocation.args.includes("--no-skills")); assert.ok(invocation.args.includes("--no-prompt-templates")); assert.ok(invocation.args.includes("--no-themes")); assert.ok(invocation.args.includes("--no-tools"));
		assert.deepEqual(invocation.args.filter((_arg, index) => invocation!.args[index - 1] === "-e"), ["/trusted/local.ts"]);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("timeout escalates to SIGKILL and cleans a stubborn process group", { skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "prompt-timeout-")); const pidFile = join(root, "descendant.pid");
	try {
		const script = `const {spawn}=require('child_process');process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`;
		const result = await runBoundedProcess({ command: process.execPath, args: ["-e", script], cwd: root, timeoutMs: 100, graceMs: 100 });
		assert.equal(result.timedOut, true); assert.deepEqual(result.signals, ["SIGTERM", "SIGKILL"]);
		const descendant = Number(await readFile(pidFile, "utf8")); await new Promise((resolve) => setTimeout(resolve, 100));
		assert.throws(() => process.kill(descendant, 0), /ESRCH/);
	} finally { await rm(root, { recursive: true, force: true }); }
});
