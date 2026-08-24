import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import profileExtension from "../index.js";
import { activeProfile, registerProfile, resetActiveProfile } from "../registry.js";

test("profile registry is shared across isolated extension module graphs", async () => {
	const first = await import(new URL("../registry.ts?graph=profile", import.meta.url).href);
	const second = await import(new URL("../registry.ts?graph=designer", import.meta.url).href);
	first.registerProfile("isolated-designer");
	assert.ok(second.availableProfiles().includes("isolated-designer"));
	first.setActiveProfile("isolated-designer");
	assert.equal(second.activeProfile(), "isolated-designer");
	first.resetActiveProfile();
});

test("profile extension leaves default sessions unchanged and accepts registered startup profiles", () => {
	let flag: any;
	let selected: unknown;
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const pi = {
		registerFlag(name: string, definition: unknown) { flag = { name, definition }; },
		getFlag() { return selected; },
		on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); },
	} as unknown as ExtensionAPI;
	profileExtension(pi);
	registerProfile("designer");
	assert.equal(flag.name, "profile");
	assert.equal((flag.definition as any).type, "string");
	const ctx = { hasUI: false } as any;
	assert.doesNotThrow(() => handlers.get("session_start")?.({}, ctx));
	assert.equal(activeProfile(), "default");
	selected = "designer";
	assert.doesNotThrow(() => handlers.get("session_start")?.({}, ctx));
	assert.equal(activeProfile(), "designer");
	selected = "missing";
	assert.throws(() => handlers.get("session_start")?.({}, ctx), /Unknown PiBox profile/);
	handlers.get("session_shutdown")?.({}, ctx);
	assert.equal(activeProfile(), "default");
	resetActiveProfile();
});
