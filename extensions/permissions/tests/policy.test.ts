import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateToolCall, loadPermissionPolicy } from "../policy.js";

async function fixture(t: test.TestContext, yaml?: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pibox-permissions-"));
	t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
	if (yaml !== undefined) {
		await mkdir(join(root, ".pi"), { recursive: true });
		await writeFile(join(root, ".pi", "permissions.yaml"), yaml);
	}
	return root;
}

test("missing repository policy preserves Pi's permissive default", async (t) => {
	const root = await fixture(t);
	const policy = loadPermissionPolicy(root);
	assert.equal(policy.defaultDecision, "allow");
	assert.equal(evaluateToolCall(policy, "bash", { command: "npm test" }, root).decision, "allow");
});

test("loads Claude-style allow ask and deny rules with restrictive precedence", async (t) => {
	const root = await fixture(t, `version: 1\ndefault: ask\npermissions:\n  allow:\n    - Read(./**)\n    - Bash(git status*)\n  ask:\n    - Bash(git *)\n  deny:\n    - Read(./secrets/**)\n    - Bash(git push*)\n`);
	const policy = loadPermissionPolicy(root);
	assert.deepEqual(policy.issues, []);
	assert.equal(evaluateToolCall(policy, "read", { path: "src/index.ts" }, root).decision, "allow");
	assert.equal(evaluateToolCall(policy, "read", { path: "secrets/token" }, root).decision, "deny");
	assert.equal(evaluateToolCall(policy, "bash", { command: "git status" }, root).decision, "ask", "ask is stricter than an overlapping allow");
	assert.equal(evaluateToolCall(policy, "bash", { command: "git push origin main" }, root).decision, "deny");
});

test("evaluates every simple compound shell segment", async (t) => {
	const root = await fixture(t, `version: 1\ndefault: ask\npermissions:\n  allow:\n    - Bash(git status*)\n  deny:\n    - Bash(rm -rf /)\n`);
	const policy = loadPermissionPolicy(root);
	const evaluation = evaluateToolCall(policy, "bash", { command: "git status && rm -rf /" }, root);
	assert.equal(evaluation.decision, "deny");
	assert.match(evaluation.summary, /rm -rf/);
});

test("protects the repository permission file while enforcement is active", async (t) => {
	const root = await fixture(t, `version: 1\ndefault: allow\n`);
	const policy = loadPermissionPolicy(root);
	assert.equal(evaluateToolCall(policy, "write", { path: ".pi/permissions.yaml" }, root).decision, "deny");
	assert.equal(evaluateToolCall(policy, "bash", { command: "printf x > .pi/permissions.yaml" }, root).decision, "deny");
});

test("non-object policy fails closed", async (t) => {
	const root = await fixture(t, `null\n`);
	const policy = loadPermissionPolicy(root);
	assert.equal(policy.defaultDecision, "deny");
	assert.deepEqual(policy.issues, ["policy root must be an object"]);
});

test("invalid policy fails closed", async (t) => {
	const root = await fixture(t, `version: 2\ndefault: magic\npermissions:\n  allow: nope\n`);
	const policy = loadPermissionPolicy(root);
	assert.equal(policy.defaultDecision, "deny");
	assert.ok(policy.issues.length >= 2);
	assert.equal(evaluateToolCall(policy, "read", { path: "README.md" }, root).decision, "deny");
});
