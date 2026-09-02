import assert from "node:assert/strict";
import test from "node:test";
import { FAST_MODE_CHILD_ENV } from "../policy.js";
import { fastModeChildEnvironment, getActiveFastModePolicy, resetActiveFastModePolicy, setActiveFastModePolicy } from "../runtime.js";

test("projects only the effective per-launch child decision", (t) => {
	t.after(resetActiveFastModePolicy);
	setActiveFastModePolicy({ main: true, subagents: "medium" });
	const codex = { provider: "openai-codex", model: "gpt-5.6-luna" };
	assert.deepEqual(fastModeChildEnvironment("low", codex), { [FAST_MODE_CHILD_ENV]: "1" });
	assert.deepEqual(fastModeChildEnvironment("medium", codex), { [FAST_MODE_CHILD_ENV]: "1" });
	assert.deepEqual(fastModeChildEnvironment("high", codex), { [FAST_MODE_CHILD_ENV]: "0" });
	assert.deepEqual(fastModeChildEnvironment("local", codex), { [FAST_MODE_CHILD_ENV]: "0" });
	assert.deepEqual(fastModeChildEnvironment("low", { provider: "ollama-cloud", model: "gpt-5.6-luna" }), { [FAST_MODE_CHILD_ENV]: "0" });
	assert.deepEqual(fastModeChildEnvironment(undefined, codex), { [FAST_MODE_CHILD_ENV]: "0" });
	assert.deepEqual(getActiveFastModePolicy(), { main: true, subagents: "medium" });
});

test("reset prevents a later session from inheriting policy", () => {
	setActiveFastModePolicy({ main: true, subagents: "max" });
	resetActiveFastModePolicy();
	assert.deepEqual(getActiveFastModePolicy(), { main: false, subagents: "off" });
});
