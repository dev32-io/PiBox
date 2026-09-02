import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_HARNESS_CONFIG, validateHarnessConfig } from "../config.js";

test("validates optional verification profiles in .pi/harness policy shape", () => {
	const config = validateHarnessConfig({ ...structuredClone(DEFAULT_HARNESS_CONFIG), verification: { defaultProfile: "project", profiles: { project: { shell: "/bin/bash", bootstrap: "export PROFILE_MARKER=ready", requiredEnvironment: ["PROFILE_MARKER"] } } } });
	assert.deepEqual(config.verification, { defaultProfile: "project", profiles: { project: { shell: "/bin/bash", bootstrap: "export PROFILE_MARKER=ready", requiredEnvironment: ["PROFILE_MARKER"] } } });
});

test("rejects invalid verification profile fields instead of silently ignoring them", () => {
	assert.throws(() => validateHarnessConfig({ ...structuredClone(DEFAULT_HARNESS_CONFIG), verification: { profiles: { project: { shell: "bash", requiredEnvironment: [] } } } }), /shell must be absolute/);
	assert.throws(() => validateHarnessConfig({ ...structuredClone(DEFAULT_HARNESS_CONFIG), verification: { profiles: { project: { shell: "/bin/sh", requiredEnvironment: [], reportPath: "old" } } } }), /unknown configuration field/i);
	assert.throws(() => validateHarnessConfig({ ...structuredClone(DEFAULT_HARNESS_CONFIG), verification: { defaultProfile: "missing", profiles: { project: { shell: "/bin/sh", requiredEnvironment: [] } } } }), /defaultProfile/);
});
