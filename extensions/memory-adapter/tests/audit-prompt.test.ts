import assert from "node:assert/strict";
import test from "node:test";
import { renderBuiltInPrompt } from "../../workflow/prompt-loader.js";

test("memory audit prompt delegates read-only source verification and remains advisory", () => {
	const prompt = renderBuiltInPrompt("memory-audit", {
		checked: 2,
		boundedNotice: "; candidates were capped at 50",
		repository: JSON.stringify({ root: "/repo", repoId: "repo-id" }),
		findings: JSON.stringify([{ id: "memory-id", reasons: ["evidence changed"] }]),
	});

	assert.match(prompt, /at least one read-only `explorer` subagent/);
	assert.match(prompt, /Repository authority outranks memory and subagent conclusions/);
	assert.match(prompt, /do not call memory mutation actions unless the user explicitly approves/);
	assert.match(prompt, /Checked 2 records; candidates were capped at 50/);
	assert.match(prompt, /memory-id/);
	assert.doesNotMatch(prompt, /\{\{[a-zA-Z0-9_]+\}\}/);
});
