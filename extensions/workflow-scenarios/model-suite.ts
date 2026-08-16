import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { discoverRepository } from "../workflow/repository.js";
import { HarnessRunStore } from "../workflow/run-store.js";
import type { EvaluationManifest, TaskManifest } from "../workflow/types.js";
import { WorkItemStore } from "../workflow/work-items.js";
import { WorktreeManager } from "../workflow/worktrees.js";
import type { ModelRunObservation } from "./types.js";

const exec = promisify(execFile);
const MODEL = "gpt-5.6-luna";
const PROVIDER = "openai-codex";
const EFFORT = "medium";

async function run(cwd: string, command: string, args: string[], timeout = 180_000): Promise<{ stdout: string; stderr: string }> {
	return exec(command, args, { cwd, timeout, maxBuffer: 10 * 1024 * 1024, encoding: "utf8" });
}
async function git(cwd: string, ...args: string[]): Promise<string> { return (await run(cwd, "git", args)).stdout.trim(); }

export interface RoutineModelFixture {
	root: string;
	workItemId: string;
	taskId: string;
	evaluationId: string;
	scenarioId: string;
	expectedClarifications: number;
	expectedClarificationRef?: string;
	expectedInterventions: number;
	expectedUserEscalations: number;
	sessionDir: string;
	sessionId: string;
}

export async function createRoutineModelFixture(root: string): Promise<RoutineModelFixture> {
	await mkdir(root, { recursive: true });
	await git(root, "init", "--quiet"); await git(root, "config", "user.name", "Workflow Model Bench"); await git(root, "config", "user.email", "bench@example.test"); await git(root, "checkout", "-b", "develop");
	await mkdir(join(root, ".pi"), { recursive: true }); await mkdir(join(root, "src"), { recursive: true }); await mkdir(join(root, "test"), { recursive: true });
	await writeFile(join(root, ".gitignore"), ".pibox/\n.worktree/\n.bench-sessions/\nnode_modules/\n");
	await writeFile(join(root, ".pi", "harness.yaml"), stringify({
		schemaVersion: 2,
		modelTiers: { low: [`${PROVIDER}/${MODEL}#${EFFORT}`], medium: [`${PROVIDER}/${MODEL}#${EFFORT}`], high: [`${PROVIDER}/${MODEL}#${EFFORT}`], max: [`${PROVIDER}/${MODEL}#${EFFORT}`] },
		agents: {
			implementer: { workspace: "repository", canDelegate: false, tools: ["read", "grep", "find", "bash", "edit", "write"], completionSchema: "implementer-v1", tier: "medium" },
			"e2e-tester": { workspace: "repository", canDelegate: false, tools: ["read", "grep", "find", "bash"], tier: "medium" },
			"code-reviewer": { workspace: "repository", canDelegate: false, tools: ["read", "grep", "find", "bash"], tier: "medium" },
			"repair-implementer": { workspace: "repository", canDelegate: false, tools: ["read", "grep", "find", "bash", "edit", "write"], tier: "medium" },
		},
		limits: { maxConcurrency: 2, maxActiveSubagentsPerSession: 8, maxSubagentDepth: 1, protocolNudges: 1, repairRounds: 1 },
	}));
	await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "workflow-model-bench", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
	await writeFile(join(root, "src", "slugify.js"), "export function slugify(value) {\n  return value;\n}\n");
	await writeFile(join(root, "test", "slugify.test.js"), "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { slugify } from '../src/slugify.js';\ntest('normalizes display text into a stable slug', () => { assert.equal(slugify('  Hello, Workflow World!  '), 'hello-workflow-world'); });\ntest('collapses separators and trims edges', () => { assert.equal(slugify('One___two---'), 'one-two'); });\n");
	await writeFile(join(root, "README.md"), "# Workflow model benchmark fixture\n\nImplement the reviewed slug behavior through the managed workflow.\n");
	await git(root, "add", "."); await git(root, "commit", "--quiet", "-m", "model benchmark fixture");
	const store = new WorkItemStore(root); const workItemId = "routine-slugify";
	await store.create({ id: workItemId, title: "Stable slug formatting", kind: "change", branchKind: "feature", intent: "Normalize display text into stable lowercase URL-safe slugs." });
	await store.putArtifact({ workItemId, id: "slugify-e2e-matrix", type: "e2e-matrix", narrativeSchemaVersion: 2, title: "Slugify E2E matrix", sections: { scope: ["Touched slug normalization behavior"], cases: [{ id: "E2E-001", classification: "golden-path", journey: "Normalize representative display text", setup: ["Use the repository fixture"], actions: ["Run npm test"], expectedOutcomes: ["Representative text and repeated separators normalize exactly as specified"], evidence: ["Node test output and inspected exported behavior"], safety: ["Use only fixture input"] }] }, operation: "create" });
	const manifest: TaskManifest = {
		schemaVersion: 1, id: "implement-slugify", title: "Implement stable slug formatting", status: "draft", dependsOn: [],
		execution: { resourceClaims: ["src/slugify.js", "test/slugify.test.js"], assignment: { agent: "implementer", tier: "medium", rationale: "Small behavioral contribution" } },
		assembly: { stageId: "slugify", intermediateState: "complete" },
		verification: { timing: "task", methods: ["Focused Node tests"], taskChecks: ["npm test"], rationale: "Behavior is fully covered by the fixture tests" },
	};
	await store.defineTask({ workItemId, manifest, brief: "Implement `slugify(value)` in `src/slugify.js`. Convert input to lowercase, replace each run of non-alphanumeric ASCII characters with one hyphen, and remove leading or trailing hyphens. Keep the existing exported function and do not add dependencies or modify canonical workflow artifacts.", acceptance: "`slugify('  Hello, Workflow World!  ')` returns `hello-workflow-world`; repeated underscores and hyphens collapse to one separator; leading and trailing separators are removed; `npm test` passes; the implementation is committed with a clean worktree." });
	const evaluation: EvaluationManifest = { schemaVersion: 1, id: "slugify-e2e", type: "e2e", scope: { workItem: workItemId }, status: "planned", required: true, attempt: 0, methods: ["Run npm test", "Inspect the committed implementation against the task acceptance"], checkpoint: "final-e2e", loop: { state: "planned", iteration: 0, maxIterations: 1 } };
	await store.defineEvaluation(workItemId, evaluation);
	const sessionDir = join(root, ".bench-sessions"); await mkdir(sessionDir, { recursive: true });
	return { root, workItemId, taskId: "implement-slugify", evaluationId: "slugify-e2e", scenarioId: "routine-managed-workflow", expectedClarifications: 0, expectedInterventions: 0, expectedUserEscalations: 0, sessionDir, sessionId: `workflow-model-${Date.now()}` };
}

async function piTurn(fixture: RoutineModelFixture, prompt: string): Promise<void> {
	const args = ["-p", "--approve", "--session-dir", fixture.sessionDir, "--session-id", fixture.sessionId, "--provider", PROVIDER, "--model", MODEL, "--thinking", EFFORT, prompt];
	await new Promise<void>((resolve, reject) => {
		const child = spawn("pi", args, { cwd: fixture.root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PIBOX_PERMISSION_MODE: "bypass" } });
		let stdout = ""; let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
		const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`Pi turn timed out.\nstdout:\n${stdout}\nstderr:\n${stderr}`)); }, 600_000); timer.unref();
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
		child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`Pi turn exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`)); });
	});
}

export async function runRoutineModelScenario(fixture: RoutineModelFixture): Promise<ModelRunObservation> {
	await piTurn(fixture, `Start the reviewed workflow work-item:${fixture.workItemId}. Let the runtime advance routine work; do not manually implement or sequence tasks.`);
	const identity = await discoverRepository(fixture.root);
	const store = new WorkItemStore(fixture.root);
	const runs = new HarnessRunStore(identity.privateRoot, fixture.workItemId);
	const deadline = Date.now() + 8 * 60_000;
	let supervisionTurns = 0;
	while (Date.now() < deadline) {
		const item = await store.read(fixture.workItemId);
		if (item.phase === "complete") break;
		const records = await runs.list();
		const active = records.some((record) => ["launching", "running", "waiting_capacity", "waiting_model"].includes(record.state));
		if (active) { await new Promise((resolve) => setTimeout(resolve, 2_000)); continue; }
		if (supervisionTurns >= 16) break;
		supervisionTurns++;
		const evaluations = await Promise.all(item.evaluations.map((entry) => store.readEvaluation(fixture.workItemId, entry.id)));
		const gatesSettled = evaluations.length > 0 && evaluations.every((evaluation) => ["passed", "not_applicable"].includes(evaluation.status));
		await piTurn(fixture, gatesSettled
			? `All required gates for work-item:${fixture.workItemId} appear settled. Reconcile durable state, apply the completion gate, and produce the outcome briefing if completion is valid.`
			: `Continue supervising work-item:${fixture.workItemId} from durable workflow state. Advance routine settled work automatically. If an actionable checkpoint or critical decision exists, report it instead of bypassing it.`);
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	return observeRoutineModelScenario(fixture);
}

export async function observeRoutineModelScenario(fixture: RoutineModelFixture): Promise<ModelRunObservation> {
	const identity = await discoverRepository(fixture.root);
	const store = new WorkItemStore(fixture.root);
	const runs = new HarnessRunStore(identity.privateRoot, fixture.workItemId);
	const item = await store.read(fixture.workItemId);
	const task = await store.readTask(fixture.workItemId, fixture.taskId);
	const evaluation = await store.readEvaluation(fixture.workItemId, fixture.evaluationId);
	const records = await runs.list();
	let toolCalls = 0; let relevantClarifications = 0; let irrelevantClarifications = 0; const transcriptProtocolViolations: string[] = [];
	for (const record of records) {
		const transcriptPath = join(runs.runRoot(record.id), "transcript.jsonl");
		const content = await readFile(transcriptPath, "utf8").catch(() => "");
		for (const line of content.split("\n").filter(Boolean)) {
			let event: any; try { event = JSON.parse(line); } catch { continue; }
			if (event.type === "tool_execution_end" && event.isError && ["task_complete", "evaluation_complete", "task_request_change", "task_blocked"].includes(event.toolName)) {
				transcriptProtocolViolations.push(`${event.toolName} failed: ${String(event.result?.content?.[0]?.text ?? "tool error")}`);
			}
			for (const part of event.type === "message_end" ? event.message?.content ?? [] : []) {
				if (part?.type !== "toolCall") continue;
				toolCalls++;
				if (part.name !== "task_clarify") continue;
				const ref = part.arguments?.ref;
				if (fixture.expectedClarificationRef && ref === fixture.expectedClarificationRef) relevantClarifications++;
				else irrelevantClarifications++;
			}
		}
	}
	let orchestratorInterventions = 0; let userEscalations = 0;
	for (const name of await readdir(fixture.sessionDir).catch(() => [])) {
		if (!name.endsWith(".jsonl")) continue;
		const content = await readFile(join(fixture.sessionDir, name), "utf8").catch(() => "");
		for (const line of content.split("\n").filter(Boolean)) {
			let event: any; try { event = JSON.parse(line); } catch { continue; }
			for (const part of event.message?.content ?? []) {
				if (part?.type === "toolCall" && ["workflow_checkpoint", "workflow_apply_change", "subagent_respond"].includes(part.name)) orchestratorInterventions++;
				if (part?.type === "text" && /please choose|awaits clarification|need(?:s)? your decision/i.test(part.text ?? "")) userEscalations = 1;
			}
		}
	}
	const status = await git(fixture.root, "status", "--porcelain");
	const managed = await new WorktreeManager(identity).listManaged();
	const safetyViolations = [...(status ? [`Canonical repository is dirty: ${status}`] : []), ...managed.filter((entry) => entry.status === "modified").map((entry) => `Retained worktree is dirty: ${entry.name}`)];
	const protocolViolations = [...transcriptProtocolViolations, ...(!["merged", "integrated"].includes(task.status) ? [`Task status is ${task.status}`] : [])];
	const evidenceRoot = join(store.workItemRoot(fixture.workItemId), "evidence");
	const evidenceEntries = await readdir(evidenceRoot).catch(() => []);
	return {
		scenarioId: fixture.scenarioId, model: `${PROVIDER}/${MODEL}`, effort: EFFORT,
		completed: item.phase === "complete", requiredGatesPassed: ["passed", "not_applicable"].includes(evaluation.status),
		protocolViolations, safetyViolations, expectedClarifications: fixture.expectedClarifications, relevantClarifications, irrelevantClarifications,
		orchestratorInterventions, expectedInterventions: fixture.expectedInterventions, userEscalations, expectedUserEscalations: fixture.expectedUserEscalations, recoveryRequired: false, recovered: false,
		verificationPassed: evaluation.status === "passed", evidenceComplete: evidenceEntries.length > 0,
		toolCalls, processAttempts: records.length,
	};
}
