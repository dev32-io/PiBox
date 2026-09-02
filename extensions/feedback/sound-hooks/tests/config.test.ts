import assert from "node:assert/strict";
import test from "node:test";
import { parseSoundTheme, resolveSoundFile, soundHooksConfig } from "../config.js";
import soundHooks, { feedbackEventForWorkflow, isSuccessfulAssistantStop } from "../index.js";
import { WORKFLOW_LIFECYCLE_EVENT } from "../../../workflow-runtime/api.js";

test("parses response and workflow feedback mappings", () => {
	const sounds = { "response-complete": "ping.mp3", "workflow-stage-completed": "complete.mp3", "workflow-error": "warning.mp3" };
	assert.deepEqual(
		parseSoundTheme({ schemaVersion: 1, id: "eve-online", label: "EVE Online", sounds }),
		{ schemaVersion: 1, id: "eve-online", label: "EVE Online", sounds },
	);
});

test("rejects malformed manifests", () => {
	assert.equal(parseSoundTheme({ schemaVersion: 2, id: "bad", label: "Bad", sounds: {} }), undefined);
	for (const event of ["response-complete", "workflow-stage-completed", "workflow-task-completed", "workflow-error"]) {
		assert.equal(parseSoundTheme({ schemaVersion: 1, id: "bad", label: "Bad", sounds: { [event]: 42 } }), undefined);
	}
});

test("keeps sound files inside the selected theme directory", () => {
	const theme = parseSoundTheme({
		schemaVersion: 1,
		id: "eve-online",
		label: "EVE Online",
		sounds: { "response-complete": "ping.mp3" },
	});
	assert.ok(theme);
	assert.equal(resolveSoundFile("/sounds", theme, "response-complete"), "/sounds/eve-online/ping.mp3");

	const escapingTheme = { ...theme, sounds: { "response-complete": "../../secret.mp3" } };
	assert.equal(resolveSoundFile("/sounds", escapingTheme, "response-complete"), undefined);
});

test("registers on the workflow lifecycle event", () => {
	const events: string[] = [];
	soundHooks({ on() {}, events: { on(name: string) { events.push(name); } } } as any);
	assert.deepEqual(events, [WORKFLOW_LIFECYCLE_EVENT]);
});

test("maps workflow lifecycle feedback to theme events", () => {
	assert.equal(feedbackEventForWorkflow({ type: "stage-completed", workflowRef: "work-item:test", stageId: "delivery", title: "Stage 1" }), "workflow-stage-completed");
	assert.equal(feedbackEventForWorkflow({ type: "error", workflowRef: "work-item:test", title: "Attention" }), "workflow-error");
});

test("migrates the legacy task-completion sound to the stage-completion event", () => {
	assert.deepEqual(
		parseSoundTheme({ schemaVersion: 1, id: "legacy", label: "Legacy", sounds: { "workflow-task-completed": "complete.mp3" } }),
		{ schemaVersion: 1, id: "legacy", label: "Legacy", sounds: { "workflow-stage-completed": "complete.mp3" } },
	);
});

test("does not treat an escaped or failed turn as response completion", () => {
	assert.equal(isSuccessfulAssistantStop("aborted"), false);
	assert.equal(isSuccessfulAssistantStop("error"), false);
	assert.equal(isSuccessfulAssistantStop("stop"), true);
});

test("reads environment overrides and disable switches", () => {
	assert.deepEqual(soundHooksConfig({ PIBOX_SOUND_ENABLED: "false", PIBOX_SOUND_THEME: "custom", PIBOX_SOUND_ROOT: "/audio" }), {
		enabled: false,
		theme: "custom",
		soundRoot: "/audio",
	});
});
