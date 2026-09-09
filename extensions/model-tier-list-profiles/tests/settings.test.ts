import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { initializeModelTierListProfilesSettings } from "../settings.js";
import { DEFAULT_MODEL_TIER_LIST_PROFILES, loadGlobalModelTierListProfiles } from "../profiles.js";

function temporaryAgentDir(): { root: string; agentDir: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "pibox-tier-settings-"));
	return { root, agentDir: join(root, "agent"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("initializes a missing official global settings file with visible editable defaults", async () => {
	const fixture = temporaryAgentDir();
	try {
		const result = await initializeModelTierListProfilesSettings({ agentDir: fixture.agentDir });
		assert.equal(result.changed, true);
		assert.equal(result.path, join(fixture.agentDir, "settings.json"));
		const settings = JSON.parse(readFileSync(result.path, "utf8"));
		assert.deepEqual(settings, { modelTierListProfiles: DEFAULT_MODEL_TIER_LIST_PROFILES });
		assert.equal("agents" in settings, false, "repository or harness policy is never copied into global settings");
	} finally { fixture.cleanup(); }
});

test("fills missing built-in defaults while preserving custom settings, routes, profiles, and idempotence", async () => {
	const fixture = temporaryAgentDir();
	try {
		const path = join(fixture.agentDir, "settings.json");
		await initializeModelTierListProfilesSettings({ agentDir: fixture.agentDir });
		const customProfile = structuredClone(DEFAULT_MODEL_TIER_LIST_PROFILES.profiles.performance!);
		customProfile.medium = ["custom/model#high"];
		writeFileSync(path, `${JSON.stringify({
			theme: "custom-theme",
			unrelated: { keep: [1, 2, 3] },
			modelTierListProfiles: {
				defaultProfile: "custom",
				profiles: {
					performance: { medium: ["user/performance#low"] },
					custom: customProfile,
				},
			},
		}, null, 2)}\n`);

		const first = await initializeModelTierListProfilesSettings({ agentDir: fixture.agentDir });
		assert.equal(first.changed, true);
		const settings = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(settings.theme, "custom-theme");
		assert.deepEqual(settings.unrelated, { keep: [1, 2, 3] });
		assert.equal(settings.modelTierListProfiles.defaultProfile, "custom");
		assert.deepEqual(settings.modelTierListProfiles.profiles.performance.medium, ["user/performance#low"]);
		assert.deepEqual(settings.modelTierListProfiles.profiles.performance.low, DEFAULT_MODEL_TIER_LIST_PROFILES.profiles.performance!.low);
		assert.deepEqual(settings.modelTierListProfiles.profiles.custom, customProfile);
		assert.ok(settings.modelTierListProfiles.profiles.nuke);

		const before = readFileSync(path, "utf8");
		const second = await initializeModelTierListProfilesSettings({ agentDir: fixture.agentDir });
		assert.equal(second.changed, false);
		assert.equal(readFileSync(path, "utf8"), before);
	} finally { fixture.cleanup(); }
});

test("rejects malformed JSON and invalid tier settings without rewriting either file", async () => {
	for (const raw of [
		'{ "theme": "dark",',
		JSON.stringify({ modelTierListProfiles: { defaultProfile: "custom", profiles: { custom: { local: ["paid/model#high"] } } } }),
	]) {
		const fixture = temporaryAgentDir();
		try {
			await initializeModelTierListProfilesSettings({ agentDir: fixture.agentDir });
			const path = join(fixture.agentDir, "settings.json");
			writeFileSync(path, raw);
			await assert.rejects(initializeModelTierListProfilesSettings({ agentDir: fixture.agentDir }), /malformed JSON|must be a non-empty array|local-llm provider/);
			assert.equal(readFileSync(path, "utf8"), raw);
		} finally { fixture.cleanup(); }
	}
});

test("production global reads are lock-coordinated, fail closed on malformed JSON, and keep missing files read-only", async () => {
	const missing = temporaryAgentDir();
	try {
		const loaded = loadGlobalModelTierListProfiles({ agentDir: missing.agentDir });
		assert.equal(loaded.present, false);
		assert.equal(existsSync(missing.agentDir), false);
	} finally { missing.cleanup(); }

	const fixture = temporaryAgentDir();
	try {
		await initializeModelTierListProfilesSettings({ agentDir: fixture.agentDir });
		const path = join(fixture.agentDir, "settings.json");
		const malformed = "{ malformed";
		writeFileSync(path, malformed);
		assert.throws(() => loadGlobalModelTierListProfiles({ agentDir: fixture.agentDir }), /settings\.json.*JSON|JSON.*settings\.json/i);
		assert.equal(readFileSync(path, "utf8"), malformed);

		writeFileSync(path, JSON.stringify({ modelTierListProfiles: DEFAULT_MODEL_TIER_LIST_PROFILES }));
		const lockPath = `${path}.lock`;
		mkdirSync(lockPath);
		assert.throws(() => loadGlobalModelTierListProfiles({ agentDir: fixture.agentDir }), /settings\.json\.lock|already being held|ELOCKED/i);
		assert.equal(existsSync(lockPath), true);
		rmdirSync(lockPath);
	} finally { fixture.cleanup(); }
});

test("honors a preheld native-compatible settings lock without rewriting or stealing it", async () => {
	const fixture = temporaryAgentDir();
	try {
		await initializeModelTierListProfilesSettings({ agentDir: fixture.agentDir });
		const path = join(fixture.agentDir, "settings.json");
		const original = JSON.stringify({ theme: "locked-writer" });
		writeFileSync(path, original);
		const lockPath = `${path}.lock`;
		mkdirSync(lockPath);
		await assert.rejects(
			initializeModelTierListProfilesSettings({ agentDir: fixture.agentDir, lockTimeoutMs: 30 }),
			/settings\.json\.lock/,
		);
		assert.equal(readFileSync(path, "utf8"), original);
		assert.equal(existsSync(lockPath), true, "a lock owned by another writer is not removed");
		rmdirSync(lockPath);
		assert.equal((await initializeModelTierListProfilesSettings({ agentDir: fixture.agentDir })).changed, true);
	} finally { fixture.cleanup(); }
});

test("releases the shared lock after validation and atomic-write failures", async () => {
	const fixture = temporaryAgentDir();
	try {
		await initializeModelTierListProfilesSettings({ agentDir: fixture.agentDir });
		const path = join(fixture.agentDir, "settings.json");
		const lockPath = `${path}.lock`;
		writeFileSync(path, "{ malformed");
		await assert.rejects(initializeModelTierListProfilesSettings({ agentDir: fixture.agentDir }), /malformed JSON/);
		assert.equal(existsSync(lockPath), false);

		writeFileSync(path, JSON.stringify({ padding: "x".repeat(5_000_000) }));
		const backup = `${path}.backup`;
		const sabotageRename = async () => {
			const deadline = Date.now() + 2_000;
			while (Date.now() < deadline) {
				const temporary = readdirSync(fixture.agentDir).find((name) => name.startsWith(".settings.json.") && name.endsWith(".tmp"));
				if (temporary) {
					renameSync(path, backup);
					mkdirSync(path);
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			throw new Error("Timed out waiting for the atomic settings temporary file");
		};
		const initialization = initializeModelTierListProfilesSettings({ agentDir: fixture.agentDir });
		try { await sabotageRename(); }
		catch (error) {
			await initialization.catch(() => {});
			throw error;
		}
		await assert.rejects(initialization);
		assert.equal(existsSync(lockPath), false);
		rmSync(path, { recursive: true, force: true });
		renameSync(backup, path);
		assert.equal((await initializeModelTierListProfilesSettings({ agentDir: fixture.agentDir })).changed, true);
	} finally { fixture.cleanup(); }
});

test("coordinates with an actually concurrent public SettingsManager writer", async () => {
	const fixture = temporaryAgentDir();
	let writer: Worker | undefined;
	try {
		await initializeModelTierListProfilesSettings({ agentDir: fixture.agentDir });
		const path = join(fixture.agentDir, "settings.json");
		writeFileSync(path, JSON.stringify({ unrelated: { preserve: true }, padding: "x".repeat(5_000_000) }));
		writer = new Worker(`
			const { parentPort, workerData } = require("node:worker_threads");
			(async () => {
				const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
				const manager = SettingsManager.create(workerData.cwd, workerData.agentDir, { projectTrusted: false });
				parentPort.postMessage({ type: "ready" });
				parentPort.once("message", async () => {
					manager.setTheme("light");
					await manager.flush();
					parentPort.postMessage({ type: "done", errors: manager.drainErrors().map(({ error }) => error.message) });
				});
			})().catch((error) => parentPort.postMessage({ type: "failed", error: error.message }));
		`, { eval: true, workerData: { cwd: join(fixture.root, "cwd"), agentDir: fixture.agentDir } });
		const message = () => new Promise<any>((resolve, reject) => {
			writer!.once("message", resolve);
			writer!.once("error", reject);
		});
		assert.deepEqual(await message(), { type: "ready" });

		const initialization = initializeModelTierListProfilesSettings({ agentDir: fixture.agentDir });
		const lockPath = `${path}.lock`;
		const deadline = Date.now() + 2_000;
		while (!existsSync(lockPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
		assert.equal(existsSync(lockPath), true, "bootstrap must hold the native lock while the native writer starts");
		const writerDone = message();
		writer.postMessage("write");
		const result = await initialization;
		assert.equal(result.changed, true);
		const writerLockDeadline = Date.now() + 2_000;
		while (!existsSync(lockPath) && Date.now() < writerLockDeadline) await new Promise((resolve) => setTimeout(resolve, 1));
		assert.equal(existsSync(lockPath), true, "native writer must hold the shared lock while the production reader starts");
		assert.deepEqual(loadGlobalModelTierListProfiles({ agentDir: fixture.agentDir }).config, DEFAULT_MODEL_TIER_LIST_PROFILES);
		assert.deepEqual(await writerDone, { type: "done", errors: [] });
		const settings = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(settings.theme, "light");
		assert.deepEqual(settings.unrelated, { preserve: true });
		assert.deepEqual(settings.modelTierListProfiles, DEFAULT_MODEL_TIER_LIST_PROFILES);
	} finally {
		await writer?.terminate();
		fixture.cleanup();
	}
});

test("serializes concurrent initialization without truncation or writer leftovers", async () => {
	const fixture = temporaryAgentDir();
	try {
		const results = await Promise.all(Array.from({ length: 6 }, () => initializeModelTierListProfilesSettings({ agentDir: fixture.agentDir })));
		assert.equal(results.filter((result) => result.changed).length, 1);
		const settings = JSON.parse(readFileSync(join(fixture.agentDir, "settings.json"), "utf8"));
		assert.deepEqual(settings.modelTierListProfiles, DEFAULT_MODEL_TIER_LIST_PROFILES);
		assert.deepEqual(readdirSync(fixture.agentDir), ["settings.json"]);
	} finally { fixture.cleanup(); }
});

test("respects PI_CODING_AGENT_DIR without touching the real home settings", async () => {
	const fixture = temporaryAgentDir();
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
		const result = await initializeModelTierListProfilesSettings();
		assert.equal(result.path, join(fixture.agentDir, "settings.json"));
		assert.equal(loadGlobalModelTierListProfiles().path, result.path);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fixture.cleanup();
	}
});
