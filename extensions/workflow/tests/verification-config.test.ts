import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadVerificationConfig, resolveVerificationProfile } from "../verification-config.js";

async function fixture(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pibox-verification-config-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, ".pibox"), { recursive: true });
	return root;
}

test("loads strict named verification profiles and resolves the default", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, ".pibox", "verification.yaml"), `schemaVersion: 1\ndefaultProfile: project\nprofiles:\n  project:\n    shell: /bin/bash\n    bootstrap: source scripts/env.sh\n    requiredEnvironment: [JAVA_HOME]\n`);
	const config = await loadVerificationConfig(root);
	assert.equal(config?.defaultProfile, "project");
	assert.deepEqual(config?.profiles.project?.requiredEnvironment, ["JAVA_HOME"]);
	const resolved = await resolveVerificationProfile(root, { id: "check-1", command: "true" });
	assert.equal(resolved.name, "project");
	assert.equal(resolved.legacy, false);
	assert.match(resolved.digest, /^[a-f0-9]{64}$/);
});

test("absent config preserves the legacy shell and explicit profiles fail closed", async (t) => {
	const root = await fixture(t);
	assert.equal((await resolveVerificationProfile(root, { id: "check-1", command: "true" })).legacy, true);
	await assert.rejects(resolveVerificationProfile(root, { id: "check-1", command: "true", profile: "ios" }), /does not exist/);
});

test("rejects unknown fields, missing profiles, and non-executable shells", async (t) => {
	const root = await fixture(t);
	const path = join(root, ".pibox", "verification.yaml");
	await writeFile(path, `schemaVersion: 1\nprofiles:\n  project:\n    shell: /bin/bash\n    surprise: true\n`);
	await assert.rejects(loadVerificationConfig(root), /unknown fields: surprise/);
	await writeFile(path, `schemaVersion: 1\ndefaultProfile: missing\nprofiles:\n  project:\n    shell: /bin/bash\n`);
	await assert.rejects(loadVerificationConfig(root), /defaultProfile does not exist/);
	const shell = join(root, "not-executable"); await writeFile(shell, "#!/bin/sh\n"); await chmod(shell, 0o600);
	await writeFile(path, `schemaVersion: 1\nprofiles:\n  project:\n    shell: ${shell}\n`);
	await assert.rejects(loadVerificationConfig(root), /shell is not executable/);
});
