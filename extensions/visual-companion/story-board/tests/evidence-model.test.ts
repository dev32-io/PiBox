import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { readCurrentE2EReport, readEvidenceMetadata, resolveEvidenceMember, sanitizeCurrentEvidenceText } from "../index.js";

const execFileAsync = promisify(execFile);

async function fixture(t: test.TestContext): Promise<string> { const root = await mkdtemp(join(tmpdir(), "story-evidence-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function put(root: string, path: string, content: string): Promise<void> { const target = join(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); }

test("evidence projects manifest membership without reading or serving bytes", async (t) => {
	const root = await fixture(t); const base = "agent-artifacts/story/evidence/review";
	await put(root, "agent-artifacts/story/evaluations/review/evaluation.yaml", "id: review\n");
	await put(root, `${base}/files/screenshot.png`, "not-real-image");
	await put(root, `${base}/files/archive.zip`, "archive");
	await put(root, `${base}/manifest.yaml`, stringify({ schemaVersion: 1, evaluation: "review", entries: [
		{ description: "inline result", result: "passed" },
		{ path: "files/screenshot.png", checksum: "sha256:test" },
		{ path: "files/missing.txt" },
		{ path: "files/archive.zip" },
		{ path: "../../outside.txt" },
	] }));
	const metadata = await readEvidenceMetadata(root, "story", "review");
	assert.equal(metadata.length, 5);
	assert.equal(metadata[0]?.available, true);
	assert.deepEqual({ member: metadata[1]?.manifestMember, available: metadata[1]?.available, supported: metadata[1]?.supported, media: metadata[1]?.mediaType }, { member: true, available: true, supported: true, media: "image/png" });
	assert.equal(metadata[2]?.available, false);
	assert.equal(metadata[3]?.supported, false);
	assert.equal(metadata[4]?.manifestMember, false);
	assert.equal(await resolveEvidenceMember(root, "story", "review", "files/screenshot.png"), join(root, base, "files/screenshot.png"));
	assert.equal(await resolveEvidenceMember(root, "story", "review", "../../outside.txt"), undefined);
});

test("current evidence sanitization preserves authorization narrative and redacts only credential values", () => {
	const narrative = "Authorization dialog appeared\nUser denied access\nauthorization status remained denied\nThe authorization flow completed";
	assert.equal(sanitizeCurrentEvidenceText(narrative), narrative);

	const credentials = [
		"Before",
		"Authorization: Bearer top.secret-123\u2028continued\u2029tail",
		"Authorization: Basic dXNlcjpwYXNz",
		"Authorization: Custom custom-header-secret",
		"Between",
		"authorization = Basic assignment-secret; observation retained",
		`{"Authorization":"Custom json-secret-value","status":"denied","authorization status":"visible"}`,
		"After",
	].join("\n");
	const sanitized = sanitizeCurrentEvidenceText(credentials);
	assert.equal(sanitized, [
		"Before",
		"Authorization: [REDACTED AUTHORIZATION]",
		"Authorization: [REDACTED AUTHORIZATION]",
		"Authorization: [REDACTED AUTHORIZATION]",
		"Between",
		"authorization = [REDACTED AUTHORIZATION]; observation retained",
		`{"Authorization":"[REDACTED AUTHORIZATION]","status":"denied","authorization status":"visible"}`,
		"After",
	].join("\n"));
	for (const secret of ["top.secret-123", "continued", "tail", "dXNlcjpwYXNz", "custom-header-secret", "assignment-secret", "json-secret-value"]) assert.doesNotMatch(sanitized, new RegExp(secret));
	assert.equal(sanitizeCurrentEvidenceText("left\r\nAuthorization: Basic crlf-secret\r\nright"), "left\r\nAuthorization: [REDACTED AUTHORIZATION]\r\nright");
	assert.equal(sanitizeCurrentEvidenceText("access_token=othersecret /Users/private/key"), "access_token=[REDACTED] [private path]");
});

test("current E2E JSON reader rejects symlink and FIFO candidates without blocking", async (t) => {
	const root = await fixture(t); const base = "agent-artifacts/story/evidence";
	await put(root, "agent-artifacts/story/story.yaml", "id: story\n");
	await put(root, "outside.json", JSON.stringify({ result: "passed", summary: "outside", findings: [], caseResults: [] }));
	await mkdir(join(root, base), { recursive: true });
	await symlink(join(root, "outside.json"), join(root, base, "linked.json"));
	await execFileAsync("mkfifo", [join(root, base, "pipe.json")]);
	const metadata = (path: string) => ({ id: path, path: `agent-artifacts/story/${path}`, memberPath: path, manifestMember: true, available: true, supported: true, mediaType: "application/json", diagnostics: [] });
	const result = await Promise.race([
		readCurrentE2EReport(root, "story", ["evidence/linked.json", "evidence/pipe.json"], [metadata("evidence/linked.json"), metadata("evidence/pipe.json")]),
		new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("FIFO read blocked")), 1000)),
	]);
	assert.equal(result?.result, "Unavailable"); assert.equal(result?.diagnostics.length, 2);
});

test("evidence rejects symlinks, directories, absent manifests, and malformed contracts", async (t) => {
	const root = await fixture(t); const base = join(root, "agent-artifacts/story/evidence/review");
	await put(root, "agent-artifacts/story/evaluations/review/evaluation.yaml", "id: review\n");
	await mkdir(join(base, "files/directory"), { recursive: true });
	await put(root, "outside.txt", "outside");
	await symlink(join(root, "outside.txt"), join(base, "files/link.txt"));
	await put(root, "agent-artifacts/story/evidence/review/files/inside.txt", "inside");
	await symlink(join(base, "files"), join(base, "alias"));
	await put(root, "agent-artifacts/story/evidence/review/manifest.yaml", stringify({ schemaVersion: 1, evaluation: "review", entries: [{ path: "files/link.txt" }, { path: "files/directory" }, { path: "alias/inside.txt" }] }));
	const metadata = await readEvidenceMetadata(root, "story", "review");
	assert.ok(metadata.every((item) => !item.available && !item.manifestMember));
	assert.deepEqual(await readEvidenceMetadata(root, "story", "absent"), []);
	await put(root, "agent-artifacts/story/evaluations/broken/evaluation.yaml", "id: broken\n");
	await put(root, "agent-artifacts/story/evidence/broken/manifest.yaml", "entries: nope\n");
	const broken = await readEvidenceMetadata(root, "story", "broken");
	assert.equal(broken[0]?.manifestMember, false);
	assert.ok(broken[0]?.diagnostics.every((item) => !item.path.startsWith("/") && !item.message.includes(root)));
});
