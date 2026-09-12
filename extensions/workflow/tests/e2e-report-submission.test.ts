import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { renderE2e } from "../authored-markdown.js";
import {
	canonicalE2eReportRef,
	e2eReportPublishSources,
	readE2eReportSubmission,
	submitE2eReport,
} from "../e2e-report-submission.js";

const exec = promisify(execFile);

const storyE2e = renderE2e({
	scope: "Integrated journey.",
	cases: [
		{ id: "E2E-001", title: "First", exercise: "Act.", oracle: "Observe.", proof: "Capture." },
		{ id: "E2E-002", title: "Second", exercise: "Act again.", oracle: "Observe again.", proof: "Capture again." },
	],
});

async function fixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pibox-e2e-submission-"));
	const attempt = join(root, "attempt");
	const repository = join(root, "repository");
	await mkdir(attempt, { recursive: true, mode: 0o700 });
	await chmod(attempt, 0o700);
	await mkdir(repository, { mode: 0o700 });
	t.after(() => rm(root, { recursive: true, force: true }));
	return { root, attempt, repository, reportPath: join(attempt, "report.md"), attemptToken: "attempt-123" };
}

test("submission maps full canonical report and derives publish sources", async (t) => {
	const f = await fixture(t);
	const repositoryEvidence = join(f.repository, "result.json");
	const temporaryEvidence = join(f.root, "画面.png");
	await writeFile(repositoryEvidence, JSON.stringify({ ok: true }), { mode: 0o600 });
	await writeFile(temporaryEvidence, Buffer.from([0x89, 0x50, 0x4e, 0x47]), { mode: 0o600 });
	const long = `観察🙂 ${"界".repeat(80_000)}`;
	await submitE2eReport({
		reportPath: f.reportPath, repositoryRoot: f.repository, attemptToken: f.attemptToken, storyE2e,
		submission: {
			summary: "完全 summary",
			cases: [
				{ case: "E2E-001", verdict: "passed", steps: ["open", "確認"], expected: "visible", observed: long, evidence: [repositoryEvidence], notes: "exact note" },
				{ case: "E2E-002", verdict: "blocked", evidence: [temporaryEvidence] },
				{ case: "EXTRA-diagnostic", verdict: "passed", observed: "retained extra" },
			],
			findings: [{ summary: "minor detail", severity: "minor" }],
		},
	});
	const queued = await readE2eReportSubmission(f.reportPath, f.attemptToken);
	assert.ok(queued);
	assert.equal(queued.reportRef, "evidence/e2e-attempt-123/report.json");
	assert.equal(queued.report.result, "needs_user");
	assert.deepEqual(queued.report.caseResults[0], {
		caseId: "E2E-001", status: "passed", executedActions: ["open", "確認"], observations: [long],
		evidenceRefs: [queued.publishSources[1]!.storyRelativePath], expected: "visible", notes: "exact note",
	});
	assert.equal(queued.report.caseResults[2]?.caseId, "EXTRA-diagnostic");
	assert.equal(queued.publishSources[0]!.storyRelativePath, "evidence/e2e-attempt-123/report.json");
	assert.match(queued.publishSources[1]!.storyRelativePath, /^evidence\/e2e-attempt-123\/evidence-[0-9a-f-]{36}-001\.json$/);
	assert.match(queued.publishSources[2]!.storyRelativePath, /^evidence\/e2e-attempt-123\/evidence-[0-9a-f-]{36}-002\.png$/);
	assert.deepEqual(await e2eReportPublishSources(f.reportPath, f.attemptToken), queued.publishSources);
	assert.equal((await stat(queued.publishSources[0]!.sourcePath)).mode & 0o777, 0o600);
	assert.deepEqual(await readFile(queued.publishSources[2]!.sourcePath), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

test("invalid or failed replacements preserve last report and later valid replacement completes", async (t) => {
	const f = await fixture(t);
	await assert.rejects(submitE2eReport({ reportPath: f.reportPath, repositoryRoot: f.repository, attemptToken: f.attemptToken, storyE2e, submission: { cases: [{ case: "E2E-001", verdict: "passed" }] } }), /missing: E2E-002/);
	assert.equal(await readE2eReportSubmission(f.reportPath, f.attemptToken), undefined);
	const firstEvidence = join(f.repository, "first.txt");
	await writeFile(firstEvidence, "first bytes", { mode: 0o600 });
	const first = { cases: [{ case: "E2E-001", verdict: "failed" as const, evidence: [firstEvidence] }, { case: "E2E-002", verdict: "passed" as const }], summary: "first" };
	await submitE2eReport({ reportPath: f.reportPath, repositoryRoot: f.repository, attemptToken: f.attemptToken, storyE2e, submission: first });
	const prior = await readE2eReportSubmission(f.reportPath, f.attemptToken); assert.ok(prior);
	const priorReportPath = prior.publishSources[0]!.sourcePath;
	const priorEvidencePath = prior.publishSources[1]!.sourcePath;
	await assert.rejects(submitE2eReport({ reportPath: f.reportPath, repositoryRoot: f.repository, attemptToken: f.attemptToken, storyE2e, submission: { cases: [{ case: "E2E-001", verdict: "passed" }] } }), /missing: E2E-002/);
	assert.equal((await readE2eReportSubmission(f.reportPath, f.attemptToken))?.report.summary, "first");

	const validCandidate = join(f.repository, "candidate.txt");
	const fifo = join(f.repository, "blocked.fifo");
	await writeFile(validCandidate, "candidate bytes", { mode: 0o600 });
	await exec("mkfifo", [fifo]);
	await assert.rejects(Promise.race([
		submitE2eReport({ reportPath: f.reportPath, repositoryRoot: f.repository, attemptToken: f.attemptToken, storyE2e, submission: { cases: [{ case: "E2E-001", verdict: "passed", evidence: [validCandidate, fifo] }, { case: "E2E-002", verdict: "passed" }], summary: "must not publish" } }),
		new Promise((_, reject) => setTimeout(() => reject(new Error("FIFO read hung")), 1_000)),
	]), /regular file/);
	assert.equal((await readE2eReportSubmission(f.reportPath, f.attemptToken))?.report.summary, "first");
	assert.equal((await readFile(priorReportPath, "utf8")).includes('"summary":"first"'), true);
	assert.equal(await readFile(priorEvidencePath, "utf8"), "first bytes");

	const latestEvidence = join(f.repository, "latest.txt");
	await writeFile(latestEvidence, "latest bytes", { mode: 0o600 });
	await submitE2eReport({ reportPath: f.reportPath, repositoryRoot: f.repository, attemptToken: f.attemptToken, storyE2e, submission: { cases: [{ case: "E2E-001", verdict: "passed", evidence: [latestEvidence] }, { case: "E2E-002", verdict: "passed" }], summary: "latest" } });
	const latest = await readE2eReportSubmission(f.reportPath, f.attemptToken); assert.ok(latest);
	assert.equal(latest.report.summary, "latest");
	assert.equal(latest.report.result, "passed");
	assert.notEqual(latest.publishSources[1]!.sourcePath, priorEvidencePath);
	assert.equal(await readFile(latest.publishSources[1]!.sourcePath, "utf8"), "latest bytes");
	assert.equal(latest.publishSources.some((source) => source.sourcePath === priorEvidencePath), false, "reader derives sources only from current report");
	assert.equal(await readFile(priorEvidencePath, "utf8"), "first bytes", "old attachment remains until replacement publication succeeds");
});

test("unsafe evidence opening rejects promptly without following links", async (t) => {
	const f = await fixture(t);
	const target = join(f.repository, "target.txt");
	const linked = join(f.repository, "linked.txt");
	await writeFile(target, "must not follow", { mode: 0o600 });
	await symlink(target, linked);
	const submission = (evidence: string) => submitE2eReport({
		reportPath: f.reportPath, repositoryRoot: f.repository, attemptToken: f.attemptToken, storyE2e,
		submission: { cases: [{ case: "E2E-001", verdict: "passed", evidence: [evidence] }, { case: "E2E-002", verdict: "passed" }] },
	});
	await assert.rejects(submission(linked), /existing regular file/);
	await assert.rejects(submission(join(f.repository, "unknown.txt")), /Evidence file does not exist/);
	assert.equal(await readE2eReportSubmission(f.reportPath, f.attemptToken), undefined);
});

test("critical precedence, private staging, and path boundaries are enforced", async (t) => {
	const f = await fixture(t);
	await submitE2eReport({ reportPath: f.reportPath, repositoryRoot: f.repository, attemptToken: f.attemptToken, storyE2e, submission: { cases: [{ case: "E2E-001", verdict: "failed" }, { case: "E2E-002", verdict: "blocked" }], findings: [{ summary: "unsafe", severity: "critical" }] } });
	assert.equal((await readE2eReportSubmission(f.reportPath, f.attemptToken))?.report.result, "critical");
	assert.throws(() => canonicalE2eReportRef("../escape"), /attempt token is invalid/);
	await assert.rejects(readE2eReportSubmission(join(f.attempt, "other.md"), f.attemptToken), /report\.md/);

	const submission = await readE2eReportSubmission(f.reportPath, f.attemptToken); assert.ok(submission);
	const reportSource = submission.publishSources[0]!.sourcePath;
	const target = join(f.root, "target.json"); await writeFile(target, "{}", { mode: 0o600 });
	await rm(reportSource); await symlink(target, reportSource);
	await assert.rejects(readE2eReportSubmission(f.reportPath, f.attemptToken), /symbolic link/);
	await rm(reportSource); await writeFile(reportSource, "{}", { mode: 0o600 }); await link(reportSource, join(f.root, "other-link"));
	await assert.rejects(readE2eReportSubmission(f.reportPath, f.attemptToken), /one filesystem link/);
});

test("report narrative uses existing content safety checks before accepting a replacement", async (t) => {
	const f = await fixture(t);
	const options = { reportPath: f.reportPath, repositoryRoot: f.repository, attemptToken: f.attemptToken, storyE2e };
	const cases = [{ case: "E2E-001", verdict: "passed" as const }, { case: "E2E-002", verdict: "passed" as const }];
	await submitE2eReport({ ...options, submission: { cases, summary: "prior safe report" } });
	const prior = await readE2eReportSubmission(f.reportPath, f.attemptToken); assert.ok(prior);
	const bytes = await readFile(prior.publishSources[0]!.sourcePath);
	await assert.rejects(submitE2eReport({ ...options, submission: {
		cases: [{ ...cases[0]!, observed: "password=fixture-sensitive-value" }, cases[1]!],
	} }), /obvious credential or private material/);
	assert.deepEqual(await readFile(prior.publishSources[0]!.sourcePath), bytes, "unsafe replacement does not alter the last valid report");
	await submitE2eReport({ ...options, submission: { cases, summary: "Credentials omitted; safe corrected report" } });
	assert.equal((await readE2eReportSubmission(f.reportPath, f.attemptToken))!.report.summary, "Credentials omitted; safe corrected report");
});
