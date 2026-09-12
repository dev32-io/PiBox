import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { stringify } from "yaml";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkerCapabilities } from "../worker-capabilities.js";
import { readLedgerSubmission } from "../ledger-submission.js";
import { readE2eReportSubmission } from "../e2e-report-submission.js";
import { renderDesign, renderE2e, renderSpec } from "../authored-markdown.js";
import { PIBOX_RUNTIME_ROLE_ENV, PIBOX_SUBAGENT_RUNTIME_ROLE } from "../../subagent/tool-policy.js";

const ENV_KEYS = [PIBOX_RUNTIME_ROLE_ENV, "PIBOX_WORKFLOW_STORY_ID", "PIBOX_WORKFLOW_TASK_ID", "PIBOX_WORKFLOW_ATTEMPT_TOKEN", "PIBOX_WORKFLOW_ACTION", "PIBOX_SUBAGENT_REPORT_PATH"] as const;

function host() {
	const tools = new Map<string, any>();
	const pi = { registerTool(definition: any) { tools.set(definition.name, definition); } } as unknown as ExtensionAPI;
	return { pi, tools };
}

async function withEnvironment<T>(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, run: () => T | Promise<T>): Promise<T> {
	const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	for (const key of ENV_KEYS) delete process.env[key];
	for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value;
	try { return await run(); }
	finally { for (const key of ENV_KEYS) { const value = previous[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

const managed = { [PIBOX_RUNTIME_ROLE_ENV]: PIBOX_SUBAGENT_RUNTIME_ROLE, PIBOX_WORKFLOW_STORY_ID: "story", PIBOX_WORKFLOW_ATTEMPT_TOKEN: "attempt" };
const exec = promisify(execFile);

test("registration matrix gives ledger only to eligible writers and keeps task clarification task-only", async () => {
	for (const action of ["task-launch", "task-repair"]) await withEnvironment({ ...managed, PIBOX_WORKFLOW_TASK_ID: "task", PIBOX_WORKFLOW_ACTION: action }, () => {
		const f = host(); registerWorkerCapabilities(f.pi); assert.deepEqual([...f.tools.keys()], ["task_clarify", "workflow_ledger"]);
	});
	for (const action of ["integration-repair", "verification-repair", "review-fix", "final-review-fix", "e2e-fix"]) await withEnvironment({ ...managed, PIBOX_WORKFLOW_ACTION: action }, () => {
		const f = host(); registerWorkerCapabilities(f.pi); assert.deepEqual([...f.tools.keys()], ["workflow_ledger"]);
	});
	for (const action of ["review", "final-review", "e2e", "standalone", "custom", "custom-review", "custom-e2e", "task-launch-custom"]) await withEnvironment({ ...managed, PIBOX_WORKFLOW_ACTION: action }, () => {
		const f = host(); registerWorkerCapabilities(f.pi); assert.deepEqual([...f.tools.keys()], []);
	});
	await withEnvironment({ ...managed, PIBOX_WORKFLOW_ACTION: "e2e", PIBOX_SUBAGENT_REPORT_PATH: "/tmp/private-attempt/report.md" }, () => {
		const f = host(); registerWorkerCapabilities(f.pi); assert.deepEqual([...f.tools.keys()], ["workflow_e2e_report"]);
	});
	await withEnvironment({ ...managed, PIBOX_WORKFLOW_TASK_ID: "task", PIBOX_WORKFLOW_ACTION: "review" }, () => {
		const f = host(); registerWorkerCapabilities(f.pi); assert.deepEqual([...f.tools.keys()], ["task_clarify"]);
	});
	for (const action of ["task-launch", "task-repair"]) await withEnvironment({ ...managed, PIBOX_WORKFLOW_ACTION: action }, () => {
		const f = host(); registerWorkerCapabilities(f.pi); assert.deepEqual([...f.tools.keys()], []);
	});
});

test("ledger invocation queues exact content with honest ACK", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-worker-ledger-")); await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
	const reportPath = join(root, "report.md");
	await withEnvironment({ ...managed, PIBOX_WORKFLOW_ACTION: "review-fix", PIBOX_SUBAGENT_REPORT_PATH: reportPath }, async () => {
		const f = host(); registerWorkerCapabilities(f.pi);
		const entry = `Non-obvious invariant 🧭 ${"界🙂".repeat(10_000)}`;
		const response = await f.tools.get("workflow_ledger").execute("call", { action: "append", entry, evidence: ["src/a.ts:4"] }, undefined, undefined, {});
		assert.equal(response.content[0].text, "Queued for harness persistence when this attempt settles; not yet persisted.");
		assert.deepEqual(await readLedgerSubmission(reportPath), { summary: entry, evidence: ["src/a.ts:4"] });
	});
});

test("E2E report invocation validates authoritative cases, replaces pending report, and honestly ACKs", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-worker-e2e-")); t.after(() => rm(root, { recursive: true, force: true }));
	await exec("git", ["init", "--quiet"], { cwd: root });
	await mkdir(join(root, "agent-artifacts", "story"), { recursive: true });
	await writeFile(join(root, "agent-artifacts", "story", "story.yaml"), stringify({
		schemaVersion: 1, id: "story", title: "Story", kind: "story",
		spec: renderSpec({ outcome: "Outcome.", scope: "Scope.", behavior: "Behavior.", acceptance: "Acceptance." }),
		design: renderDesign({ approach: "Approach.", boundariesAndFlow: "Flow.", failureAndVerification: "Verify." }),
		e2e: renderE2e({ scope: "Journey.", cases: [{ id: "E2E-001", title: "Case", exercise: "Act.", oracle: "See.", proof: "Capture." }] }),
	}));
	const attempt = join(root, ".attempt"); await mkdir(attempt, { mode: 0o700 }); await chmod(attempt, 0o700);
	const reportPath = join(attempt, "report.md");
	await withEnvironment({ ...managed, PIBOX_WORKFLOW_ACTION: "e2e", PIBOX_SUBAGENT_REPORT_PATH: reportPath }, async () => {
		const f = host(); registerWorkerCapabilities(f.pi); const tool = f.tools.get("workflow_e2e_report");
		await assert.rejects(tool.execute("call", { cases: [] }, undefined, undefined, { cwd: root }), /missing: E2E-001/);
		const first = await tool.execute("call", { cases: [{ case: "E2E-001", verdict: "failed", observed: "missing" }] }, undefined, undefined, { cwd: root });
		assert.equal(first.content[0].text, "Queued for harness acceptance when this E2E attempt settles; not yet accepted or published.");
		await tool.execute("call", { cases: [{ case: "E2E-001", verdict: "passed", observed: "visible" }] }, undefined, undefined, { cwd: root });
		assert.equal((await readE2eReportSubmission(reportPath, "attempt"))?.report.result, "passed");
		process.env.PIBOX_WORKFLOW_ATTEMPT_TOKEN = "continued-attempt";
		await tool.execute("call", { cases: [{ case: "E2E-001", verdict: "blocked", observed: "fresh environment" }] }, undefined, undefined, { cwd: root });
		assert.equal((await readE2eReportSubmission(reportPath, "continued-attempt"))?.report.caseResults[0]?.observations[0], "fresh environment");
		assert.equal((await readE2eReportSubmission(reportPath, "attempt"))?.report.result, "passed", "continued attempt does not overwrite prior attempt staging");
		process.env.PIBOX_WORKFLOW_ACTION = "review";
		await assert.rejects(tool.execute("call", { cases: [{ case: "E2E-001", verdict: "passed" }] }, undefined, undefined, { cwd: root }), /active managed E2E evaluator attempt/);
	});
});

test("direct forged invocation is denied and conflicting second call is explicit", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-worker-ledger-")); await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
	const reportPath = join(root, "report.md");
	await withEnvironment({ ...managed, PIBOX_WORKFLOW_ACTION: "e2e-fix", PIBOX_SUBAGENT_REPORT_PATH: reportPath }, async () => {
		const f = host(); registerWorkerCapabilities(f.pi); const tool = f.tools.get("workflow_ledger");
		process.env.PIBOX_WORKFLOW_ACTION = "e2e";
		await assert.rejects(tool.execute("call", { action: "append", entry: "forged" }, undefined, undefined, {}), /eligible managed workflow writer attempt/);
		process.env.PIBOX_WORKFLOW_ACTION = "e2e-fix";
		delete process.env[PIBOX_RUNTIME_ROLE_ENV];
		await assert.rejects(tool.execute("call", { action: "append", entry: "forged" }, undefined, undefined, {}), /managed subagent runtime identity/);
		process.env[PIBOX_RUNTIME_ROLE_ENV] = "orchestrator";
		await assert.rejects(tool.execute("call", { action: "append", entry: "forged" }, undefined, undefined, {}), /managed subagent runtime identity/);
		process.env[PIBOX_RUNTIME_ROLE_ENV] = PIBOX_SUBAGENT_RUNTIME_ROLE;
		await tool.execute("call", { action: "append", entry: "first" }, undefined, undefined, {});
		await tool.execute("call", { action: "append", entry: "first" }, undefined, undefined, {});
		await assert.rejects(tool.execute("call", { action: "append", entry: "second" }, undefined, undefined, {}), /conflicting submission/);
		await assert.rejects(tool.execute("call", { action: "replace", entry: "first" }, undefined, undefined, {}), /append/);
	});
});
