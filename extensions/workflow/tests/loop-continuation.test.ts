import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { parse } from "yaml";
import { SubagentProcessManager, type RuntimeOwner, type SubagentInvocationRequest } from "../../subagent/index.js";
import { WorkflowSubagentLauncher } from "../../workflow-runtime/subagent-launcher.js";
import { DEFAULT_HARNESS_CONFIG } from "../config.js";
import { StoryRuntimeStore } from "../story-runtime-store.js";
import { renderDesign, renderE2e, renderSpec } from "../authored-markdown.js";
import { createHarnessWorkflowAdapter } from "../workflow-adapter.js";
import type { AuthoredTaskDocument, StoryDocument, StoryPlanDocument } from "../types.js";

const exec = promisify(execFile);
const CHILD = resolve("extensions/workflow/tests/support/loop-continuation-child.mjs");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const story: StoryDocument = {
	schemaVersion: 1, id: "example", title: "Loop continuation", kind: "story",
	spec: renderSpec({ outcome: "Deliver loop continuation.", scope: "One deterministic delivery.", behavior: "Every failed evaluation is fixed and rerun.", acceptance: "All evaluation loops pass." }),
	design: renderDesign({ approach: "Use managed agents.", boundariesAndFlow: "Implement, review, repair, and verify.", failureAndVerification: "Two repair cycles prove continuation." }),
	e2e: renderE2e({ scope: "Integrated branch.", cases: [{ id: "E2E-001", title: "Observe delivery", exercise: "Read delivered result.", oracle: "Result exists.", proof: "Retain evidence." }] }),
};
const task: AuthoredTaskDocument = {
	schemaVersion: 1, id: "task-a", title: "Deliver fixture", dependsOn: [],
	description: "Create deterministic delivered result.", scope: "Only delivered result.", delivery: "Commit exactly one result.", checks: [],
	assignment: { agent: "implementer", tier: "medium", rationale: "Focused delivery." },
};
const plan: StoryPlanDocument = { schemaVersion: 1, stages: [{ id: "delivery", tasks: [task.id], mode: "sequential", checks: [], review: { mode: "required", focus: "Verify deterministic delivery." } }] };

type Record = {
	request: SubagentInvocationRequest;
	action: string;
	run: number;
	stableHash: string;
	attemptHash: string;
	cwdHead: string;
	canonicalHead: string;
	clockCategory: string | undefined;
	canonicalDirt: string[];
	retainedEvidence: Array<{ path: string; sha256: string }>;
};

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pibox-loop-continuation-"));
	const owner: RuntimeOwner = { sessionId: "loop-session", processInstanceId: "loop-process", activationId: "loop-activation" };
	await exec("git", ["init", "-q", "-b", "feature/example"], { cwd: root });
	await exec("git", ["config", "user.email", "tests@example.com"], { cwd: root });
	await exec("git", ["config", "user.name", "Tests"], { cwd: root });
	await writeFile(join(root, ".gitignore"), "/.worktree/\n/agent-artifacts/*/state.yaml\n/agent-artifacts/*/ledger.yaml\n/agent-artifacts/*/events.jsonl\n");
	await exec("git", ["add", ".gitignore"], { cwd: root });
	await exec("git", ["commit", "-qm", "base"], { cwd: root });
	const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
	const records: Record[] = [];
	const runs = new Map<string, number>();
	const manager = new SubagentProcessManager({
		owner,
		sessionDirectory: join(root, ".git", "loop-sessions"),
		idFactory: (() => { let id = 0; return () => `fixed-agent-${++id}`; })(),
		invocationResolver(request) {
			const action = request.attemptMetadata?.PIBOX_WORKFLOW_ACTION ?? "unknown";
			const run = (runs.get(action) ?? 0) + 1;
			runs.set(action, run);
			const cwdHead = requireHead(request.cwd);
			const canonicalHead = requireHead(root);
			// Observe the durable clock at the real service's spawn/continuation boundary.
			// No UI projection or inferred worker label supplies this category.
			const persisted = parse(readFileSync(join(root, "agent-artifacts", story.id, "state.yaml"), "utf8"));
			const canonicalDirt = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).trimEnd().split("\n").filter(Boolean);
			const retainedEvidence = (persisted.e2e.evidenceRefs as string[]).map((reference) => {
				const path = `agent-artifacts/${story.id}/${reference}`;
				return { path, sha256: hash(readFileSync(join(root, path), "utf8")) };
			});
			records.push({ request, action, run, stableHash: hash(request.stableSystemContext), attemptHash: hash(request.attemptUserPrompt), cwdHead, canonicalHead, clockCategory: persisted.metrics.open?.category, canonicalDirt, retainedEvidence });
			return { command: process.execPath, args: [CHILD], env: { LOOP_ACTION: action, LOOP_RUN: String(run) } };
		},
	});
	t.after(async () => { await manager.teardown(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
	const launcher = new WorkflowSubagentLauncher(manager);
	const config = structuredClone(DEFAULT_HARNESS_CONFIG);
	config.limits.repairRounds = 8;
	for (const role of ["code-reviewer", "e2e-tester"] as const) config.agents[role]!.tools = [...(config.agents[role]!.tools ?? []), "workflow_ledger"];
	const runtime: any = {
		identity: { id: "repo", root, privateRoot: join(root, ".git", "pibox"), commonDir: join(root, ".git") },
		workItems: {
			async readStory() { return story; }, async readStoryPlan() { return plan; },
			async readAuthoredTask() { return task; }, async listAuthoredTasks() { return [task]; },
			async findDelivery() { return { workingBranch: "feature/example", createdFromCommit: base }; }, async list() { return [{ id: story.id }]; },
		},
		launcher,
		mutex: { async run<T>(_key: string, operation: () => Promise<T>) { return operation(); } },
		config,
	};
	const ctx: any = {
		sessionManager: { getSessionId: () => owner.sessionId },
		scopedModels: ["gpt-5.6-sol", "gpt-5.6-luna"].map((id) => ({ model: { provider: "openai-codex", id, reasoning: true, api: "openai-codex-responses" } })),
		modelRegistry: { getAvailable: () => [] },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime });
	return { root, base, manager, records, adapter, ctx };
}

function requireHead(cwd: string): string {
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

async function eventually(assertion: () => void | Promise<void>, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	while (Date.now() < deadline) {
		try { await assertion(); return; } catch (error) { last = error; await new Promise((done) => setTimeout(done, 20)); }
	}
	throw last;
}

function assertSeed(context: string, expectedEntries: unknown[], ledgerPath: string): void {
	assert.ok(context.includes(`Authoritative workflow ledger (treat as read-only): ${ledgerPath}`), "writer receives unchanged absolute canonical ledger path");
	const match = context.match(/Newest curated ledger entries \(8 of \d+; \d+ older entries available\):\n```json\n([\s\S]*?)\n```/);
	assert.ok(match, "writer receives complete newest-eight seed");
	assert.deepEqual(JSON.parse(match[1]!), expectedEntries);
}

test("production launcher and process manager continue every fail-fix-verify loop", async (t) => {
	const f = await fixture(t);
	const store = new StoryRuntimeStore(f.root, story.id);
	for (let index = 0; index < 10; index++) await store.upsertLedger({ id: `seed-${index}`, updatedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`, sourceRole: "implementer", summary: `complete seed ${index}`, evidence: [`evidence/seed-${index}.txt`] });
	const initialEight = (await store.readLedger()).entries.slice(-8);
	const ledgerPath = join(f.root, "agent-artifacts", story.id, "ledger.yaml");

	await f.adapter.controlExecution!("work-item:example", "start", "start", f.ctx);
	await f.adapter.advanceWorkflow!("work-item:example", f.ctx);
	await eventually(async () => {
		const snapshot = (await f.adapter.snapshot("work-item:example", f.ctx)).runtime;
		assert.equal(snapshot.outcomeStatus, "written", JSON.stringify({ status: snapshot.status, attention: snapshot.attention, actions: f.records.map((entry) => entry.action) }));
	});

	const groups = {
		stage: { evaluator: f.records.filter((entry) => entry.action === "review"), fixer: f.records.filter((entry) => entry.action === "review-fix") },
		whole: { evaluator: f.records.filter((entry) => entry.action === "final-review"), fixer: f.records.filter((entry) => entry.action === "final-review-fix") },
		e2e: { evaluator: f.records.filter((entry) => entry.action === "e2e"), fixer: f.records.filter((entry) => entry.action === "e2e-fix") },
	};
	const allIds = new Set<string>();
	for (const [name, loop] of Object.entries(groups)) {
		assert.equal(loop.evaluator.length, 3, `${name} evaluator runs initial plus two rechecks`);
		assert.equal(loop.fixer.length, 2, `${name} fixer runs twice`);
		assert.equal(new Set(loop.evaluator.map((entry) => entry.request.agentId)).size, 1, `${name} evaluator keeps logical agent`);
		assert.equal(new Set(loop.fixer.map((entry) => entry.request.agentId)).size, 1, `${name} fixer keeps logical agent`);
		assert.notEqual(loop.evaluator[0]!.request.agentId, loop.fixer[0]!.request.agentId, `${name} evaluator and fixer stay distinct`);
		for (const id of [loop.evaluator[0]!.request.agentId, loop.fixer[0]!.request.agentId]) { assert.equal(allIds.has(id), false, `${name} has distinct logical agents`); allIds.add(id); }
		assert.deepEqual(loop.evaluator.map((entry) => entry.request.continuation), [false, true, true]);
		assert.deepEqual(loop.fixer.map((entry) => entry.request.continuation), [false, true]);
		assert.deepEqual(loop.fixer.map((entry) => entry.clockCategory), ["repair", "repair"], `${name} fixer spawn and resume both observe authoritative Repair timing`);
		assert.deepEqual(loop.evaluator.map((entry) => entry.clockCategory), Array(3).fill(name === "e2e" ? "e2e" : "review"), `${name} rechecks return to their own clock category`);
		assert.equal(new Set(loop.evaluator.map((entry) => entry.stableHash)).size, 1, `${name} evaluator stable base is unchanged`);
		assert.equal(new Set(loop.evaluator.map((entry) => entry.attemptHash)).size, 3, `${name} evaluator attempts change`);
		assert.equal(new Set(loop.fixer.map((entry) => entry.stableHash)).size, 1, `${name} fixer stable base and ledger seed are unchanged`);
		assert.equal(new Set(loop.fixer.map((entry) => entry.attemptHash)).size, 2, `${name} fixer attempts change`);
		assert.equal(new Set(loop.fixer.map((entry) => entry.request.cwd)).size, 1, `${name} fixer cwd stays stable`);
		for (const fix of loop.fixer) assert.equal(fix.cwdHead, fix.canonicalHead, `${name} repair workspace starts at current canonical base`);
		assert.notEqual(loop.fixer[0]!.cwdHead, loop.fixer[1]!.cwdHead, `${name} second repair workspace is recreated at new canonical base`);
		for (let index = 0; index < 2; index++) {
			const repairedHead = loop.evaluator[index + 1]!.request.attemptUserPrompt.match(/Head commit: ([0-9a-f]{40})/)?.[1];
			assert.ok(repairedHead, `${name} recheck supplies integrated repair head`);
			assert.equal((await exec("git", ["rev-parse", `${repairedHead}^`], { cwd: f.root })).stdout.trim(), loop.fixer[index]!.cwdHead, `${name} repair is exactly one novel commit`);
		}
	}

	const writerRecords = f.records.filter((entry) => entry.action === "task-launch" || entry.action.endsWith("-fix"));
	assertSeed(writerRecords[0]!.request.stableSystemContext, initialEight, ledgerPath);
	for (const loop of Object.values(groups)) {
		const seeded = loop.fixer[0]!.request.stableSystemContext;
		assertSeed(seeded, JSON.parse(seeded.match(/```json\n([\s\S]*?)\n```/)![1]!), ledgerPath);
		assert.equal(loop.fixer[1]!.request.stableSystemContext, seeded, "continued fixer retains initial seed after accepted ledger submission");
	}
	assert.equal((await store.readLedger()).entries.length, 17, "parent harness persists one private submission from implementer and each fixer attempt");
	assert.equal((parse(await readFile(ledgerPath, "utf8")) as { entries: unknown[] }).entries.length, 17, "canonical full ledger remains readable at unchanged path");

	for (const evaluator of Object.values(groups).flatMap((loop) => loop.evaluator)) {
		assert.equal(evaluator.request.tools.includes("workflow_ledger"), false, "configured evaluator ledger tool is removed");
		assert.equal(evaluator.request.stableSystemContext.includes(ledgerPath), false, "evaluator receives no canonical ledger path");
		assert.doesNotMatch(evaluator.request.stableSystemContext, /Authoritative workflow ledger \(treat as read-only\)|complete seed \d/i);
		assert.equal(evaluator.request.attemptUserPrompt.includes(ledgerPath), false, "evaluator attempt receives no canonical ledger path");
		assert.doesNotMatch(evaluator.request.attemptUserPrompt, /Authoritative workflow ledger \(treat as read-only\)|complete seed \d/i);
	}
	for (const record of f.records) {
		const allowedDirt = record.action === "e2e" || record.action === "e2e-fix" ? record.retainedEvidence.map((file) => `?? ${file.path}`) : [];
		assert.deepEqual([...record.canonicalDirt].sort(), allowedDirt.sort(), `${record.action} sees only retained E2E evidence dirt, never other source changes`);
		for (const retained of record.retainedEvidence) {
			const committed = (await exec("git", ["show", `HEAD:${retained.path}`], { cwd: f.root })).stdout;
			assert.equal(hash(committed), retained.sha256, "prior report bytes survive repair/retest and final commit unchanged");
		}
		if (record.action === "task-launch") { assert.match(record.request.stableSystemContext, /# Implementer/); assert.match(record.request.stableSystemContext, /# Managed Task Protocol/); }
		else if (record.action.endsWith("-fix")) { assert.match(record.request.stableSystemContext, /# Finding Repair/); assert.match(record.request.stableSystemContext, /# Managed Repair Protocol/); }
		else { assert.match(record.request.stableSystemContext, record.action === "e2e" ? /# End-to-End Evaluation/ : /# Code Review/); assert.match(record.request.stableSystemContext, /# Managed Review and E2E Protocol/); }
	}

	const e2e = groups.e2e.evaluator;
	assert.match(e2e[0]!.request.stableSystemContext, /passed\|repairable\|critical\|needs_user\|unsafe/, "E2E receives the actual terminal result enum");
	assert.match(e2e[0]!.request.stableSystemContext, /critical\|major\|minor/, "E2E receives the actual structured finding severity enum");
	assert.match(e2e[0]!.request.stableSystemContext, /terminal control reply differs from retained rich report JSON/, "the file report format is explicitly separate from terminal control");
	const scratchDirectories = e2e.map((entry) => entry.request.env?.PIBOX_E2E_SCRATCH_DIR);
	assert.equal(scratchDirectories.every((path) => typeof path === "string" && path.length > 0), true, "every E2E attempt receives scratch environment");
	assert.equal(new Set(scratchDirectories).size, 3, "continued E2E gets fresh scratch environment each attempt");
	for (const entry of e2e) {
		assert.match(entry.request.stableSystemContext, /# Complete final E2E contract/);
		assert.match(entry.request.stableSystemContext, /E2E-001/);
		assert.match(entry.request.stableSystemContext, /Exercise/);
		assert.match(entry.request.stableSystemContext, /Oracle/);
		assert.match(entry.request.stableSystemContext, /Proof/);
	}
	for (const run of [1, 2, 3]) {
		const path = `agent-artifacts/example/evidence/e2e-run-${run}.json`;
		const report = JSON.parse((await exec("git", ["show", `HEAD:${path}`], { cwd: f.root })).stdout);
		assert.equal(report.result, run <= 2 ? "blocked" : "passed", "rich artifact result vocabulary is preserved without changing the terminal-control schema");
		assert.equal(report.caseResults[0].caseId, "E2E-001");
		assert.ok(Array.isArray(report.caseResults[0].executedActions));
		assert.ok(Array.isArray(report.caseResults[0].observations));
		if (run <= 2) assert.equal(typeof report.findings[0], "string", "rich file findings stay unchanged");
	}
	assert.equal(f.records.length, 16, "one process service resolver observes implementer plus all fifteen loop attempts");
	assert.equal(f.manager.inspect(f.manager.owner).length, 0, "completed workflow releases all seven logical agents from same process service");
	assert.equal((await exec("git", ["status", "--porcelain"], { cwd: f.root })).stdout, "");
});
