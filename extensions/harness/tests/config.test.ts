import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_HARNESS_CONFIG, loadHarnessConfig, mergeConfigValues, validateHarnessConfig } from "../config.js";
import { HarnessError } from "../errors.js";

test("merges maps recursively and replaces arrays", () => {
	assert.deepEqual(
		mergeConfigValues(
			{ nested: { keep: true, list: [1, 2] }, scalar: "old" },
			{ nested: { list: [3] }, scalar: "new" },
		),
		{ nested: { keep: true, list: [3] }, scalar: "new" },
	);
});

test("loads user then repository configuration and records a stable digest", () => {
	const files: Record<string, string> = {
		"/home/.pi/agent/harness/config.yaml": "limits:\n  maxConcurrency: 2\nroles:\n  implementer:\n    models:\n      - model: terra\n        effort: medium\n",
		"/repo/.pi/harness.yaml": "limits:\n  maxConcurrency: 6\n",
	};
	const loaded = loadHarnessConfig("/repo", {
		home: "/home",
		exists: (path) => path in files,
		readFile: (path) => files[path] ?? "",
	});
	assert.equal(loaded.config.limits.maxConcurrency, 6);
	assert.deepEqual(loaded.config.roles.implementer?.models, [{ model: "terra", effort: "medium" }]);
	assert.equal(loaded.sources.length, 3);
	assert.match(loaded.digest, /^sha256:[a-f0-9]{64}$/);
});

test("fails closed on unknown top-level configuration", () => {
	assert.throws(
		() => validateHarnessConfig({ ...structuredClone(DEFAULT_HARNESS_CONFIG), unsafeOverride: true }),
		(error: unknown) => error instanceof HarnessError && error.code === "CONFIG_INVALID",
	);
});
