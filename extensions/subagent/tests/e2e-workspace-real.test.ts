import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { readE2eWorkspaceHandoff, readE2eWorkspaceReport, type E2eWorkspaceReportResult } from "../../e2e-workspace/workspace.js";
import { resolveToolSelectors } from "../../workflow/tool-groups.js";
import { DEFAULT_SUBAGENT_CATALOG_CONFIG } from "../catalog.js";
import { STANDALONE_CHILD_EXTENSION_PATHS } from "../child-extensions.js";
import { createPiInvocationResolver, type SubagentInvocationRequest } from "../invocation.js";
import { SubagentProcessManager } from "../process-manager.js";

const PROVIDER = resolve("extensions/workflow/tests/support/e2e-report-provider.ts");

test("real standalone E2E restores its session workspace, isolates fresh actors, and reports lost temporary continuity", { timeout: 90_000, skip: process.platform === "win32" }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-standalone-e2e-"));
	const input = join(root, "input.json");
	const marker = join(root, "workspace-tools.jsonl");
	const owner = { sessionId: "standalone-e2e-parent", activationId: "standalone-e2e-activation", processInstanceId: "standalone-e2e-process" };
	const invocations: SubagentInvocationRequest[] = [];
	const snapshots: E2eWorkspaceReportResult[] = [];
	const nativePaths: string[] = [];
	const resolver = createPiInvocationResolver({ piInvocation: {
		command: resolve("node_modules/.bin/pi"), args: ["--offline", "--no-context-files", "--no-skills"],
		env: { PI_OFFLINE: "1", PIBOX_REPORT_FIXTURE_INPUT: input, PIBOX_REPORT_FIXTURE_MARKER: marker },
	}, lifetimeTermGraceMs: 50 });
	const manager = new SubagentProcessManager({ owner, sessionDirectory: join(root, "sessions"), terminationGraceMs: 200,
		invocationResolver(request) { invocations.push(request); return resolver(request); },
	});
	t.after(async () => {
		await manager.teardown();
		for (const path of new Set(snapshots.map((entry) => entry.workspaceRoot))) await rm(path, { recursive: true, force: true });
		for (const path of nativePaths) await rm(dirname(path), { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	});
	const definition = DEFAULT_SUBAGENT_CATALOG_CONFIG.agents["e2e-tester"]!;
	const stableSystemContext = (await readFile(definition.prompt!, "utf8")).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
	const launch = () => manager.launch({ owner, agent: "e2e-tester", cwd: root, stableSystemContext,
		attemptUserPrompt: "Evaluate the assigned case using your generic workspace.", provider: "pibox-e2e-report-test", model: "fixture-model", effort: "off",
		tools: resolveToolSelectors(definition.tools!), extensionPaths: [...STANDALONE_CHILD_EXTENSION_PATHS, PROVIDER], skillPaths: [], fast: false,
	});
	const record = async (started: Awaited<ReturnType<typeof launch>>) => {
		const terminal = await started.result;
		assert.equal(terminal.status, "completed", terminal.stderr);
		assert.ok(terminal.reportPath, "native transport report remains available separately");
		nativePaths.push(terminal.reportPath);
		const snapshot = await readE2eWorkspaceHandoff(terminal.reportPath);
		assert.ok(snapshot, "current attempt has a validated machine-readable workspace handoff");
		snapshots.push(snapshot);
		assert.equal(terminal.progress?.toolCalls, 5, "real agent called init, evidence, duplicate evidence, invalid report, valid report");
		assert.equal(snapshot.evidence.length, 1);
		assert.equal(await readFile(snapshot.evidence[0]!.absolutePath, "utf8"), "Selected standalone witness π🙂\n");
		assert.notEqual(snapshot.reportPath, terminal.reportPath);
		assert.ok(!snapshot.reportPath.startsWith(root));
		return terminal;
	};
	const writeInput = (number: number) => writeFile(input, JSON.stringify({ cases: [{ case: "STANDALONE-001", verdict: "passed", steps: ["Exercise standalone fixture"], expected: "Standalone capability records real tool calls", observed: `Evaluation ${number} π🙂` }] }));
	await writeInput(1);
	const first = await record(await launch());
	const originalReport = snapshots[0]!.serializedJsonText;
	await writeInput(2);
	const second = await record(await manager.continue({ owner, handle: first.handle, attemptUserPrompt: "Retest with a new evaluation; preserve earlier proof." }));
	assert.equal(snapshots[1]!.reference.workspaceId, snapshots[0]!.reference.workspaceId);
	assert.equal(snapshots[1]!.reference.sessionId, snapshots[0]!.reference.sessionId);
	assert.notEqual(snapshots[1]!.reference.runId, snapshots[0]!.reference.runId);
	assert.equal((await readE2eWorkspaceReport(snapshots[0]!.reference)).serializedJsonText, originalReport);
	assert.equal(invocations[1]!.transcriptPath, invocations[0]!.transcriptPath);
	assert.equal(invocations[1]!.stableSystemContext, invocations[0]!.stableSystemContext);
	assert.equal(invocations[1]!.cwd, invocations[0]!.cwd);
	assert.ok(!stableSystemContext.includes(snapshots[0]!.workspaceRoot));

	await writeInput(3);
	await record(await launch());
	assert.notEqual(snapshots[2]!.reference.workspaceId, snapshots[0]!.reference.workspaceId, "fresh logical actor cannot adopt another workspace");
	assert.notEqual(snapshots[2]!.reference.sessionId, snapshots[0]!.reference.sessionId);
	assert.notEqual(invocations[2]!.transcriptPath, invocations[0]!.transcriptPath);

	// Simulate OS /tmp loss only in this disposable fixture, then continue the same native session.
	await rm(snapshots[0]!.workspaceRoot, { recursive: true });
	await assert.rejects(readE2eWorkspaceReport(snapshots[1]!.reference), /missing|unsafe|unavailable/i);
	await writeInput(4);
	await record(await manager.continue({ owner, handle: second.handle, attemptUserPrompt: "Continue after temporary storage loss; report that loss explicitly before fresh evaluation." }));
	assert.equal(snapshots[3]!.reference.sessionId, snapshots[0]!.reference.sessionId);
	assert.notEqual(snapshots[3]!.reference.workspaceId, snapshots[0]!.reference.workspaceId);
	const receipts = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(receipts.length, 4);
	assert.ok(receipts.every((entry) => entry.rejectedInvalid && entry.deduplicated && entry.submitted));
	assert.match(receipts[3].initText, /lost|unavailable|missing|not restored/i, "init must expose lost continuity, not silently claim restoration");
	await manager.teardown();
	assert.equal((await readE2eWorkspaceReport(snapshots[2]!.reference)).serializedJsonText, snapshots[2]!.serializedJsonText, "submitted bytes survive child teardown");
	assert.equal((await readE2eWorkspaceReport(snapshots[3]!.reference)).serializedJsonText, snapshots[3]!.serializedJsonText);
});
