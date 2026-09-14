import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
	createE2eEvaluation,
	createE2eWorkspace,
	readE2eWorkspaceHandoff,
	readE2eWorkspaceReport,
	retainE2eEvidence,
	restoreE2eWorkspace,
	setE2eRequiredCasesProvider,
	submitE2eWorkspaceReport,
} from "../workspace.js";

async function fixture(t: test.TestContext) {
	const workspace = await createE2eWorkspace({ sessionId: "session-one" });
	const attempt = await mkdtemp("/tmp/pibox-e2e-attempt-"); await chmod(attempt, 0o700);
	t.after(() => Promise.all([rm(workspace.root, { recursive: true, force: true }), rm(attempt, { recursive: true, force: true })]));
	return { workspace, evaluation: await createE2eEvaluation({ workspace }), nativeReportPath: join(attempt, "report.md") };
}

const cases = (evidence: string[] = []) => ({
	summary: "complete",
	cases: [
		{ case: "E2E-001", verdict: "passed" as const, steps: ["open"], expected: "visible", observed: "visible", evidence },
		{ case: "E2E-002", verdict: "blocked" as const, notes: "environment absent" },
	],
	findings: [{ summary: "small friction", severity: "minor" as const }],
});

test("curated evidence deduplicates and finalized snapshots read through exact handoff", async (t) => {
	const f = await fixture(t);
	const source = join(f.evaluation.outputDirectory, "witness.log");
	await writeFile(source, "targeted output\n");
	const first = await retainE2eEvidence({ evaluation: f.evaluation, sourcePath: source, reason: "Shows expected CLI output" });
	const duplicate = await retainE2eEvidence({ evaluation: f.evaluation, sourcePath: "witness.log", reason: "Same witness reused" });
	assert.equal(first.deduplicated, false); assert.equal(duplicate.deduplicated, true); assert.equal(duplicate.reference, first.reference);
	const submitted = await submitE2eWorkspaceReport({ evaluation: f.evaluation, submission: cases([first.reference]), requiredCaseIds: ["E2E-001", "E2E-002"], nativeReportPath: f.nativeReportPath });
	assert.equal(submitted.report.result, "needs_user"); assert.equal(submitted.evidence.length, 1); assert.equal(submitted.serializedJsonText, await readFile(submitted.reportPath, "utf8"));
	assert.deepEqual((await readE2eWorkspaceHandoff(f.nativeReportPath))?.reference, submitted.reference);
	assert.deepEqual((await readE2eWorkspaceReport(submitted.reference)).report, submitted.report);
	await assert.rejects(retainE2eEvidence({ evaluation: f.evaluation, sourcePath: source, reason: "late" }), /finalized/);
	await assert.rejects(submitE2eWorkspaceReport({ evaluation: f.evaluation, submission: cases() }), /already finalized/);
});

test("optional required-case provider enforces child policy without workflow imports", async (t) => {
	const f = await fixture(t); setE2eRequiredCasesProvider(async () => ["E2E-001", "E2E-002"]); t.after(() => setE2eRequiredCasesProvider(undefined));
	await assert.rejects(submitE2eWorkspaceReport({ evaluation: f.evaluation, submission: { cases: [{ case: "E2E-001", verdict: "passed" }] } }), /missing: E2E-002/);
	const result = await submitE2eWorkspaceReport({ evaluation: f.evaluation, submission: cases() });
	assert.equal(result.report.caseResults.length, 2);
});

test("invalid submissions remain correctable and later evaluation preserves prior snapshot", async (t) => {
	const f = await fixture(t);
	await assert.rejects(submitE2eWorkspaceReport({ evaluation: f.evaluation, submission: { cases: [{ case: "E2E-001", verdict: "passed" }] }, requiredCaseIds: ["E2E-001", "E2E-002"] }), /missing: E2E-002/);
	const first = await submitE2eWorkspaceReport({ evaluation: f.evaluation, submission: cases(), requiredCaseIds: ["E2E-001", "E2E-002"] });
	const prior = await readFile(first.reportPath, "utf8");
	const nextEvaluation = await createE2eEvaluation({ workspace: f.workspace });
	const second = await submitE2eWorkspaceReport({ evaluation: nextEvaluation, submission: { cases: [{ case: "E2E-001", verdict: "failed", observed: "regression" }] } });
	assert.notEqual(first.reportPath, second.reportPath); assert.equal(await readFile(first.reportPath, "utf8"), prior); assert.equal(second.report.result, "repairable");
});

test("foreign binding, missing storage, unsafe source paths, links, and unsupported files fail explicitly", async (t) => {
	const f = await fixture(t);
	await assert.rejects(restoreE2eWorkspace({ binding: { ...f.workspace.binding, sessionId: "foreign" } }), /does not match/);
	await writeFile(join(f.evaluation.outputDirectory, "unknown.bin"), "x");
	await assert.rejects(retainE2eEvidence({ evaluation: f.evaluation, sourcePath: "unknown.bin", reason: "x" }), /Unsupported/);
	await assert.rejects(retainE2eEvidence({ evaluation: f.evaluation, sourcePath: "../escape.log", reason: "x" }), /individual file/);
	const outside = join(f.workspace.root, "outside.log"); await writeFile(outside, "outside");
	await symlink(outside, join(f.evaluation.outputDirectory, "link.log"));
	await assert.rejects(retainE2eEvidence({ evaluation: f.evaluation, sourcePath: "link.log", reason: "x" }), /non-symlink/);
	assert.equal(await readE2eWorkspaceHandoff(f.nativeReportPath), undefined);
	await rm(f.workspace.root, { recursive: true });
	await assert.rejects(restoreE2eWorkspace({ binding: f.workspace.binding }), /missing or unsafe/);
});

test("evaluation directories require private mode on every operation", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.evaluation.outputDirectory, "proof.log"), "proof");
	await chmod(f.evaluation.outputDirectory, 0o755);
	await assert.rejects(retainE2eEvidence({ evaluation: f.evaluation, sourcePath: "proof.log", reason: "proof" }), /not private/);
	await chmod(f.evaluation.outputDirectory, 0o700);
	const retained = await retainE2eEvidence({ evaluation: f.evaluation, sourcePath: "proof.log", reason: "proof" });
	await chmod(f.evaluation.evidenceDirectory, 0o755);
	await assert.rejects(submitE2eWorkspaceReport({ evaluation: f.evaluation, submission: cases([retained.reference]) }), /not private/);
});

test("output replacement and unregistered hash-named evidence cannot bypass retention", async (t) => {
	const f = await fixture(t);
	const outside = await mkdtemp("/tmp/pibox-e2e-outside-"); await chmod(outside, 0o700); t.after(() => rm(outside, { recursive: true, force: true }));
	await writeFile(join(outside, "proof.log"), "outside");
	await rm(f.evaluation.outputDirectory, { recursive: true }); await symlink(outside, f.evaluation.outputDirectory);
	await assert.rejects(retainE2eEvidence({ evaluation: f.evaluation, sourcePath: "proof.log", reason: "proof" }), /missing or unsafe/);

	const next = await createE2eEvaluation({ workspace: f.workspace });
	const bytes = "injected"; const hash = createHash("sha256").update(bytes).digest("hex");
	const injected = `evidence/${hash}.log`; await writeFile(join(next.root, injected), bytes, { mode: 0o600 });
	await assert.rejects(submitE2eWorkspaceReport({ evaluation: next, submission: cases([injected]) }), /not retained/);
});

test("secret matcher rejects evidence and report narrative without echoing content", async (t) => {
	const f = await fixture(t);
	for (const [name, content] of [["result.json", "{\"password\":\"hunter2\"}"], ["request.log", "Authorization: Bearer abc.def.ghi"]] as const) {
		await writeFile(join(f.evaluation.outputDirectory, name), content);
		await assert.rejects(retainE2eEvidence({ evaluation: f.evaluation, sourcePath: name, reason: "proof" }), (error: Error) => /credential.*private material/.test(error.message) && !error.message.includes("hunter2") && !error.message.includes("abc.def.ghi"));
	}
	await assert.rejects(submitE2eWorkspaceReport({ evaluation: f.evaluation, submission: { cases: [{ case: "E2E-001", verdict: "failed", evidence: ["Authorization: Bearer abc.def.ghi"] }] } }), (error: Error) => /not retained/.test(error.message) && !error.message.includes("abc.def.ghi"));
	await assert.rejects(submitE2eWorkspaceReport({ evaluation: f.evaluation, submission: { cases: [{ case: "E2E-001", verdict: "failed", observed: "Authorization: Bearer abc.def.ghi" }] } }), (error: Error) => /obvious credential/.test(error.message) && !error.message.includes("abc.def.ghi"));
});

test("successful finalization removes only current run intermediates and unreferenced retained files", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.evaluation.outputDirectory, "keep.log"), "keep bytes");
	await writeFile(join(f.evaluation.outputDirectory, "drop.log"), "drop bytes");
	const keep = await retainE2eEvidence({ evaluation: f.evaluation, sourcePath: "keep.log", reason: "needed" });
	const drop = await retainE2eEvidence({ evaluation: f.evaluation, sourcePath: "drop.log", reason: "not selected" });
	const unfinished = await createE2eEvaluation({ workspace: f.workspace });
	await writeFile(join(unfinished.outputDirectory, "resume.log"), "resume me");
	await submitE2eWorkspaceReport({ evaluation: f.evaluation, submission: cases([keep.reference]) });
	assert.equal((await readFile(keep.absolutePath)).toString(), "keep bytes");
	await assert.rejects(access(drop.absolutePath), /ENOENT/);
	await assert.rejects(access(f.evaluation.outputDirectory), /ENOENT/);
	assert.equal(await readFile(join(unfinished.outputDirectory, "resume.log"), "utf8"), "resume me");
});

test("consumer rejects replaced evidence parent directory", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.evaluation.outputDirectory, "proof.txt"), "proof");
	const evidence = await retainE2eEvidence({ evaluation: f.evaluation, sourcePath: "proof.txt", reason: "Minimal proof" });
	const submitted = await submitE2eWorkspaceReport({ evaluation: f.evaluation, submission: cases([evidence.reference]) });
	const outside = await mkdtemp("/tmp/pibox-e2e-evidence-"); await chmod(outside, 0o700); t.after(() => rm(outside, { recursive: true, force: true }));
	await rm(f.evaluation.evidenceDirectory, { recursive: true }); await symlink(outside, f.evaluation.evidenceDirectory);
	await assert.rejects(readE2eWorkspaceReport(submitted.reference), /missing or unsafe/);
});

test("report and evidence mutation or symlink replacement are rejected", async (t) => {
	const f = await fixture(t);
	const source = join(f.evaluation.outputDirectory, "proof.txt"); await writeFile(source, "proof");
	const evidence = await retainE2eEvidence({ evaluation: f.evaluation, sourcePath: source, reason: "Minimal proof" });
	const submitted = await submitE2eWorkspaceReport({ evaluation: f.evaluation, submission: cases([evidence.reference]) });
	await writeFile(submitted.reportPath, submitted.serializedJsonText.replace("complete", "mutated!"), { mode: 0o600 });
	await assert.rejects(readE2eWorkspaceReport(submitted.reference), /content changed/);
	await rm(submitted.reportPath); await symlink(source, submitted.reportPath);
	await assert.rejects(readE2eWorkspaceReport(submitted.reference), /missing or unsafe/);
});
