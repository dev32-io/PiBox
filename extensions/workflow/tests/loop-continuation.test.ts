import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { parse, stringify } from "yaml";
import { SubagentProcessManager, createPiInvocationResolver, type RuntimeOwner, type SubagentInvocationRequest } from "../../subagent/index.js";
import { WorkflowSubagentLauncher } from "../../workflow-runtime/subagent-launcher.js";
import { DEFAULT_HARNESS_CONFIG } from "../config.js";
import { StoryRuntimeStore } from "../story-runtime-store.js";
import { renderDesign, renderE2e, renderSpec } from "../authored-markdown.js";
import { createHarnessWorkflowAdapter } from "../workflow-adapter.js";
import type { AuthoredTaskDocument, StoryDocument, StoryPlanDocument } from "../types.js";

const exec = promisify(execFile);
const CHILD = resolve("extensions/workflow/tests/support/loop-continuation-child.mjs");
const PROVIDER = resolve("extensions/workflow/tests/support/e2e-report-provider.ts");
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
	reportRef?: string;
};

async function pauseGate(t: TestContext): Promise<{ port: number; connected: Promise<Socket> }> {
	let connected!: (socket: Socket) => void;
	const connection = new Promise<Socket>((resolve) => { connected = resolve; });
	const sockets = new Set<Socket>();
	const server = createServer((socket) => { sockets.add(socket); socket.on("error", () => {}); connected(socket); });
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); });
	const address = server.address(); assert.ok(address && typeof address !== "string");
	return { port: address.port, connected: connection };
}

async function fixture(t: TestContext, options: { e2eFailures?: number; repairRounds?: number; pausePort?: number; reviewFailures?: number; omitFirstE2eReport?: boolean } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pibox-loop-continuation-"));
	const owner: RuntimeOwner = { sessionId: "loop-session", processInstanceId: "loop-process", activationId: "loop-activation" };
	await exec("git", ["init", "-q", "-b", "feature/example"], { cwd: root });
	await exec("git", ["config", "user.email", "tests@example.com"], { cwd: root });
	await exec("git", ["config", "user.name", "Tests"], { cwd: root });
	await writeFile(join(root, ".gitignore"), "/.worktree/\n/agent-artifacts/*/state.yaml\n/agent-artifacts/*/ledger.yaml\n/agent-artifacts/*/events.jsonl\n");
	await mkdir(join(root, "agent-artifacts/example/tasks"), { recursive: true });
	await writeFile(join(root, "agent-artifacts/example/story.yaml"), stringify(story));
	await writeFile(join(root, "agent-artifacts/example/plan.yaml"), stringify(plan));
	await writeFile(join(root, "agent-artifacts/example/tasks/task-a.yaml"), stringify(task));
	await exec("git", ["add", ".gitignore", "agent-artifacts"], { cwd: root });
	await exec("git", ["commit", "-qm", "base"], { cwd: root });
	const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
	const records: Record[] = [];
	const runs = new Map<string, number>();
	const marker = join(root, ".git", "native-e2e-tool.jsonl");
	const realPi = createPiInvocationResolver({ piInvocation: { command: resolve("node_modules/.bin/pi"), args: ["--offline", "--no-context-files", "--no-skills"], env: { PI_OFFLINE: "1" } } });
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
			const reportRef = action === "e2e" ? `evidence/e2e-${request.attemptMetadata!.PIBOX_WORKFLOW_ATTEMPT_TOKEN}/report.json` : persisted.e2e.currentReportRef;
			records.push({ ...(reportRef ? { reportRef } : {}), request, action, run, stableHash: hash(request.stableSystemContext), attemptHash: hash(request.attemptUserPrompt), cwdHead, canonicalHead, clockCategory: persisted.metrics.open?.category, canonicalDirt, retainedEvidence });
			const inputPath = join(root, ".git", `loop-input-${action}-${run}.txt`);
			writeFileSync(inputPath, request.attemptUserPrompt, { mode: 0o600 });
			if (action === "e2e") {
				const blocked = Boolean(options.pausePort && run === 3);
				const failed = run <= (options.e2eFailures ?? 2);
				const scratch = request.env!.PIBOX_E2E_SCRATCH_DIR!;
				const attachment = join(scratch, `witness-${run}.txt`);
				writeFileSync(attachment, `Retained attachment ${run} π🙂\n`);
				const payloadPath = join(root, ".git", `tool-input-${run}.json`);
				writeFileSync(payloadPath, JSON.stringify({ summary: `Current E2E report ${run}`,
					cases: [{ case: "E2E-001", verdict: blocked ? "blocked" : failed ? "failed" : "passed",
						steps: ["Exercise delivered feature."], expected: "Feature works.",
						observed: `${"complete observation π🙂 ".repeat(1_400)}FULL_E2E_DIAGNOSTIC_END_${run} REPORT_WITNESS_${run}_${randomUUID()}`,
						evidence: [attachment], notes: "Preserve complete report and attachment." }],
					findings: failed ? [{ summary: `CURRENT_E2E_FINDING_${run}`, severity: blocked ? "minor" : "major" }] : [],
				}));
				return realPi({ ...request, provider: "pibox-e2e-report-test", model: "fixture-model", effort: "off",
					extensionPaths: [...request.extensionPaths, PROVIDER],
					env: { ...request.env, PIBOX_REPORT_FIXTURE_INPUT: payloadPath, PIBOX_REPORT_FIXTURE_MARKER: marker, PIBOX_REPORT_FIXTURE_OMIT_REPORT: options.omitFirstE2eReport && run === 1 ? "1" : "",
						...(blocked ? { PIBOX_REPORT_FIXTURE_PAUSE_PORT: String(options.pausePort) } : {}) } });
			}
			return { command: process.execPath, args: [CHILD], env: { LOOP_ACTION: action, LOOP_RUN: String(run), LOOP_REVIEW_FAILURES: String(options.reviewFailures ?? 2), LOOP_INPUT_PATH: inputPath, LOOP_E2E_FAILURES: String(options.e2eFailures ?? 2), ...(options.pausePort ? { LOOP_PAUSE_PORT: String(options.pausePort), LOOP_E2E_NEEDS_USER_RUN: "3" } : {}) } };
		},
	});
	t.after(async () => { await manager.teardown(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
	const launcher = new WorkflowSubagentLauncher(manager);
	const config = structuredClone(DEFAULT_HARNESS_CONFIG);
	config.limits.repairRounds = options.repairRounds ?? 8;
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
	return { root, base, manager, records, adapter, ctx, marker };
}

function requireHead(cwd: string): string {
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

function assertSeed(context: string, expectedEntries: unknown[], ledgerPath: string): void {
	assert.ok(context.includes(`Authoritative workflow ledger (treat as read-only): ${ledgerPath}`), "writer receives unchanged absolute canonical ledger path");
	const match = context.match(/Newest curated ledger entries \(8 of \d+; \d+ older entries available\):\n```json\n([\s\S]*?)\n```/);
	assert.ok(match, "writer receives complete newest-eight seed");
	assert.deepEqual(JSON.parse(match[1]!), expectedEntries);
}

test("production launcher and process manager continue every fail-fix-verify loop", { timeout: 90_000 }, async (t) => {
	const f = await fixture(t);
	const store = new StoryRuntimeStore(f.root, story.id);
	for (let index = 0; index < 10; index++) await store.upsertLedger({ id: `seed-${index}`, updatedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`, sourceRole: "implementer", summary: `complete seed ${index}`, evidence: [`evidence/seed-${index}.txt`] });
	const initialEight = (await store.readLedger()).entries.slice(-8);
	const ledgerPath = join(f.root, "agent-artifacts", story.id, "ledger.yaml");

	let resolveCompletion!: () => void; let rejectCompletion!: (error: unknown) => void;
	const completion = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
	let observations = Promise.resolve();
	const unsubscribe = await f.adapter.subscribeLifecycle!("work-item:example", f.ctx, () => {
		observations = observations.then(async () => {
			const state = await store.readState();
			if (state?.outcomeStatus === "written") resolveCompletion();
			else if (state?.status === "attention") rejectCompletion(new Error(JSON.stringify({ attention: state.attention, actions: f.records.map((entry) => entry.action) })));
		}).catch(rejectCompletion);
	});
	try {
		await f.adapter.controlExecution!("work-item:example", "start", "start", f.ctx);
		await f.adapter.advanceWorkflow!("work-item:example", f.ctx);
		await completion;
	} finally { if (typeof unsubscribe === "function") unsubscribe(); }

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
	assert.ok(e2e.every((entry) => entry.request.tools.includes("workflow_e2e_report")), "managed E2E advertises the report tool on every attempt");
	assert.doesNotMatch(e2e[0]!.request.stableSystemContext, /terminal control reply differs from retained rich report JSON/);
	const submissions = (await readFile(f.marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(submissions.length, 3, "real Pi executed the report tool once successfully per evaluator attempt");
	assert.ok(submissions.every((entry) => entry.rejectedInvalid && entry.submitted), "invalid arguments were corrected inside each evaluator attempt");
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
		const path = `agent-artifacts/example/${e2e[run - 1]!.reportRef!}`;
		const reportText = await readFile(join(f.root, path), "utf8");
		const report = JSON.parse(reportText);
		assert.equal(report.result, run <= 2 ? "repairable" : "passed");
		assert.equal(report.caseResults[0].caseId, "E2E-001");
		assert.equal(report.caseResults[0].expected, "Feature works.");
		assert.equal(report.caseResults[0].notes, "Preserve complete report and attachment.");
		assert.equal(await readFile(join(f.root, "agent-artifacts/example", report.caseResults[0].evidenceRefs[0]), "utf8"), `Retained attachment ${run} π🙂\n`);
		assert.equal((await exec("git", ["show", `HEAD:${path}`], { cwd: f.root })).stdout, reportText);
		if (run <= 2) {
			const fixer = groups.e2e.fixer[run - 1]!;
			assert.ok(fixer.request.attemptUserPrompt.includes(reportText), "fresh/continued fixer receives exact full canonical report text");
			assert.ok(fixer.request.attemptUserPrompt.includes(`CURRENT_E2E_FINDING_${run}`));
			assert.ok(fixer.request.attemptUserPrompt.includes(join(f.root, path)), "fixer receives canonical report path");
			const witness = report.caseResults[0].observations[0].match(/REPORT_WITNESS_\d+_[a-f0-9-]+/)[0];
			assert.ok((await readFile(join(f.root, `repair-e2e-fix-${run}.txt`), "utf8")).includes(witness));
			if (run === 2) assert.ok(!fixer.request.attemptUserPrompt.includes("FULL_E2E_DIAGNOSTIC_END_1"));
		}
	}
	assert.equal((await store.readState())!.e2e.repairCount, 2, "tool argument correction does not consume product repair rounds");
	assert.equal(f.records.length, 16, "one process service resolver observes implementer plus all fifteen loop attempts");
	assert.equal(f.manager.inspect(f.manager.owner).length, 0, "completed workflow releases all seven logical agents from same process service");
	assert.equal((await exec("git", ["status", "--porcelain"], { cwd: f.root })).stdout, "");
});

for (const pausedPrerequisite of [false, true]) test(pausedPrerequisite
	? "paused active E2E settles exhausted needs_user and recovers through bounded prerequisite correction"
	: "request_changes reaches the same real E2E fixer entrance with retained report plus guidance", { timeout: 90_000 }, async (t) => {
	const gate = pausedPrerequisite ? await pauseGate(t) : undefined;
	const f = await fixture(t, { e2eFailures: 3, repairRounds: 2, ...(gate ? { pausePort: gate.port } : {}) });
	const store = new StoryRuntimeStore(f.root, story.id);
	let resolveAttention!: () => void; let rejectAttention!: (error: unknown) => void;
	let resolveCompletion!: () => void; let rejectCompletion!: (error: unknown) => void;
	const attention = new Promise<void>((resolve, reject) => { resolveAttention = resolve; rejectAttention = reject; });
	const completion = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
	void completion.catch(() => {});
	let corrected = false; let observations = Promise.resolve();
	const unsubscribe = await f.adapter.subscribeLifecycle!("work-item:example", f.ctx, () => {
		observations = observations.then(async () => {
			const state = await store.readState();
			if (state?.outcomeStatus === "written") resolveCompletion();
			else if (state?.status === "attention") {
				if (!corrected && state.e2e.status === "attention") resolveAttention();
				else throw new Error(JSON.stringify({ attention: state.attention, actions: f.records.map((entry) => entry.action) }));
			}
		}).catch((error) => { rejectAttention(error); rejectCompletion(error); });
	});
	try {
		await f.adapter.controlExecution!("work-item:example", "start", "start", f.ctx);
		await f.adapter.advanceWorkflow!("work-item:example", f.ctx);
		if (gate) {
			const socket = await gate.connected;
			const active = (await store.readState())!;
			assert.equal(active.e2e.status, "testing"); assert.ok(active.e2e.attempt);
			await f.adapter.controlExecution!("work-item:example", "pause", "pause-active-e2e", f.ctx);
			const paused = (await store.readState())!;
			assert.equal(paused.status, "paused");
			assert.deepEqual(paused.e2e.attempt, active.e2e.attempt, "pause preserves the running evaluator's settlement authority");
			socket.end("settle after pause");
		}
		await attention;
		const prior = (await store.readState())!;
		assert.equal(prior.e2e.failure?.code, pausedPrerequisite ? "needs_user" : "repair_exhausted");
		assert.equal(prior.e2e.repairCount, 2);
		assert.equal(prior.e2e.currentReportRef, f.records.filter((entry) => entry.action === "e2e")[2]!.reportRef);
		const guidance = pausedPrerequisite
			? "MAIN_SESSION_DIAGNOSTIC_GUIDANCE: user approves isolated disposable fixtures and fixture-only teardown; reproduce the current witness before a surgical repair."
			: "MAIN_SESSION_DIAGNOSTIC_GUIDANCE: reproduce the current witness before a surgical repair.";
		const decision = { action: "request_changes" as const, prompt: guidance, correction: { attentionEpoch: prior.attentionEpoch!, target: { kind: "e2e" as const } } };
		await f.adapter.resolveAttention!("work-item:example", decision, f.ctx, { dryRun: true });
		await f.adapter.resolveAttention!("work-item:example", decision, f.ctx);
		const updated = (await store.readState())!;
		assert.deepEqual(updated.e2e.currentFindings, prior.e2e.currentFindings);
		assert.equal(updated.e2e.currentReportRef, prior.e2e.currentReportRef);
		corrected = true;
		await f.adapter.controlExecution!("work-item:example", "resume", "guided-e2e-repair", f.ctx);
		await f.adapter.advanceWorkflow!("work-item:example", f.ctx);
		await completion;
		const fixes = f.records.filter((entry) => entry.action === "e2e-fix");
		assert.equal(fixes.length, 3, "two automatic entrances followed by one explicitly corrected entrance");
		assert.equal(new Set(fixes.map((entry) => entry.request.agentId)).size, 1, "same compatible fixer continues across the main-session correction");
		assert.equal(new Set(fixes.map((entry) => entry.stableHash)).size, 1);
		assert.deepEqual(fixes.map((entry) => entry.request.continuation), [false, true, true]);
		for (const [index, fix] of fixes.entries()) {
			const run = index + 1;
			assert.ok(fix.request.attemptUserPrompt.includes(`FULL_E2E_DIAGNOSTIC_END_${run}`));
			assert.ok(fix.request.attemptUserPrompt.includes(`CURRENT_E2E_FINDING_${run}`));
			assert.equal(fix.request.attemptUserPrompt.includes(guidance), run === 3, "guidance augments only the corrected entrance");
			if (run > 1) assert.ok(!fix.request.attemptUserPrompt.includes(`FULL_E2E_DIAGNOSTIC_END_${run - 1}`));
			const reportText = await readFile(join(f.root, "agent-artifacts/example", fix.reportRef!), "utf8");
			const report = JSON.parse(reportText);
			assert.ok(fix.request.attemptUserPrompt.includes(reportText), "automatic and requested entrances receive the entire original report");
			const witness = report.caseResults[0].observations[0].match(/REPORT_WITNESS_\d+_[a-f0-9-]+/)[0];
			assert.ok((await readFile(join(f.root, `repair-e2e-fix-${run}.txt`), "utf8")).includes(witness));
		}
		assert.equal((await store.readState())!.e2e.repairCount, 3, "correction preserves retry history instead of resetting it");
		assert.equal((await exec("git", ["status", "--porcelain"], { cwd: f.root })).stdout, "");
	} finally { if (typeof unsubscribe === "function") unsubscribe(); }
});

test("missing native report pauses and plain resume reruns only E2E with zero repair budget", { timeout: 90_000 }, async (t) => {
	const f = await fixture(t, { e2eFailures: 0, reviewFailures: 0, repairRounds: 0, omitFirstE2eReport: true });
	const store = new StoryRuntimeStore(f.root, story.id);
	let resolvePaused!: () => void; let rejectPaused!: (error: unknown) => void;
	let resolveCompletion!: () => void; let rejectCompletion!: (error: unknown) => void;
	const paused = new Promise<void>((resolve, reject) => { resolvePaused = resolve; rejectPaused = reject; });
	const complete = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
	void complete.catch(() => {});
	let observations = Promise.resolve();
	const unsubscribe = await f.adapter.subscribeLifecycle!("work-item:example", f.ctx, () => {
		observations = observations.then(async () => {
			const state = await store.readState();
			if (state?.outcomeStatus === "written") resolveCompletion();
			else if (state?.status === "paused" && state.e2e.status === "interrupted") resolvePaused();
			else if (state?.status === "attention") throw new Error(JSON.stringify(state.attention));
		}).catch((error) => { rejectPaused(error); rejectCompletion(error); });
	});
	try {
		await f.adapter.controlExecution!("work-item:example", "start", "start", f.ctx);
		await f.adapter.advanceWorkflow!("work-item:example", f.ctx);
		await paused;
		const before = (await store.readState())!;
		assert.equal(before.e2e.repairCount, 0);
		assert.equal(before.e2e.currentReportRef, undefined);
		assert.equal(before.outcomeStatus, "pending");
		assert.equal((await exec("git", ["status", "--porcelain"], { cwd: f.root })).stdout, "");
		await f.adapter.controlExecution!("work-item:example", "resume", "retry-report", f.ctx);
		await f.adapter.advanceWorkflow!("work-item:example", f.ctx);
		await complete;
		const evaluators = f.records.filter((entry) => entry.action === "e2e");
		assert.equal(evaluators.length, 2);
		assert.deepEqual(evaluators.map((entry) => entry.request.continuation), [false, true]);
		assert.equal(evaluators[0]!.request.agentId, evaluators[1]!.request.agentId);
		assert.equal(f.records.some((entry) => entry.action.endsWith("-fix")), false, "report omission never launches a product fixer");
		assert.equal((await store.readState())!.e2e.repairCount, 0);
		assert.equal((await store.readState())!.e2e.currentReportRef, evaluators[1]!.reportRef);
		assert.equal((await exec("git", ["status", "--porcelain"], { cwd: f.root })).stdout, "");
	} finally { if (typeof unsubscribe === "function") unsubscribe(); }
});
