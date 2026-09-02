import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { readEvidenceMetadata, resolveEvidenceMember } from "../index.js";

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
