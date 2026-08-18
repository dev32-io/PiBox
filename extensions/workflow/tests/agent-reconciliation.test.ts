import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { reconcileReportedAgents } from "../agent-reconciliation.js";
import { RepositoryMutex } from "../idempotency.js";
import { HarnessRunStore } from "../run-store.js";
import { discoverRepository } from "../repository.js";
import { WorkItemStore } from "../work-items.js";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> { return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim(); }

 test("two concurrent reconcileReportedAgents calls settle one evaluation attempt and one run.reconciled_completed event", async (t) => {
	const parent = await mkdtemp(join(tmpdir(), "pibox-reconcile-")); t.after(() => rm(parent, { recursive: true, force: true }));
	const root = join(parent, "repo"); await git(parent, "init", "--quiet", root); await git(root, "config", "user.name", "Harness Test"); await git(root, "config", "user.email", "harness@example.test");
	await writeFile(join(root, "README.md"), "fixture\n"); await writeFile(join(root, ".gitignore"), "/.pibox/\n"); await git(root, "add", "README.md", ".gitignore"); await git(root, "commit", "--quiet", "-m", "initial"); await git(root, "branch", "-M", "develop");
	const identity = await discoverRepository(root, join(parent, "home")); const store = new WorkItemStore(root);
	await store.create({ id: "review", title: "Review", kind: "change", branchKind: "feature", intent: "reconcile" });
	await store.defineEvaluation("review", { schemaVersion: 1, id: "evaluation", type: "deterministic", scope: { workItem: "review" }, status: "planned", required: true, attempt: 0, methods: ["test"] });
	assert.equal(await git(root, "status", "--porcelain"), "", "fixture must be clean before reconciliation");
	const runs = new HarnessRunStore(identity.privateRoot, "review");
	const created = await runs.create({ repositoryId: identity.id, workItemId: "review", evaluationId: "evaluation", role: "reviewer", attempt: 1, state: "running", workspace: root, baseCommit: await git(root, "rev-parse", "HEAD"), planningRevision: (await store.read("review")).planning.revision });
	await runs.writeEvaluationHandoff(created.record.id, { schemaVersion: 1, type: "evaluation_complete", runId: created.record.id, evaluationId: "evaluation", verdict: "fail", report: "finding", evidence: [], findings: [{ id: "F1", severity: "high", status: "open", summary: "finding", blocking: true }], completedAt: new Date().toISOString() });
	const agent: any = { id: "reviewer-agent", sessionId: "session", parentAgentId: "main", depth: 1, role: "code-reviewer", state: "reported", provider: "test", model: "test", effort: "low", operationId: "review-op", assignmentDigest: "digest", assignmentPath: "assignment", attempts: [], workItemId: "review", evaluationId: "evaluation", runId: created.record.id, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
	const registry: any = { async list() { return [agent]; }, async transition() {} };
	const input = { identity, registry, workItems: store, mutex: new RepositoryMutex(identity.commonDir ?? identity.root) };
	const [first, second] = await Promise.all([reconcileReportedAgents(input), reconcileReportedAgents(input)]);
	assert.deepEqual([...first.errors, ...second.errors], [], JSON.stringify({ first, second }));
	assert.equal((await store.readEvaluation("review", "evaluation")).attempt, 1);
	assert.equal((await runs.read(created.record.id)).state, "completed");
	const events = (await readFile(join(runs.runRoot(created.record.id), "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(events.filter((event) => event.type === "run.reconciled_completed").length, 1);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

