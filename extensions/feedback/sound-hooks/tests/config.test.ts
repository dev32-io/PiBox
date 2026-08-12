import assert from "node:assert/strict";
import test from "node:test";
import { parseSoundTheme, resolveSoundFile, soundHooksConfig } from "../config.js";
import { isSuccessfulAssistantStop } from "../index.js";

test("parses the supported response-complete mapping", () => {
	assert.deepEqual(
		parseSoundTheme({
			schemaVersion: 1,
			id: "eve-online",
			label: "EVE Online",
			sounds: { "response-complete": "ping.mp3" },
		}),
		{
			schemaVersion: 1,
			id: "eve-online",
			label: "EVE Online",
			sounds: { "response-complete": "ping.mp3" },
		},
	);
});

test("rejects malformed manifests", () => {
	assert.equal(parseSoundTheme({ schemaVersion: 2, id: "bad", label: "Bad", sounds: {} }), undefined);
	assert.equal(
		parseSoundTheme({ schemaVersion: 1, id: "bad", label: "Bad", sounds: { "response-complete": 42 } }),
		undefined,
	);
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
