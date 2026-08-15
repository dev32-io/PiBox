import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import permissions from "../index.js";
import { confirmWorkflowBypass, currentPermissionMode } from "../runtime.js";

async function harness(t: test.TestContext) {
	const cwd = await mkdtemp(join(tmpdir(), "pibox-permission-extension-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(join(cwd, ".pi", "permissions.yaml"), `version: 1\ndefault: ask\npermissions:\n  allow:\n    - Read(./**)\n  deny:\n    - Bash(sudo *)\n`);
	const handlers = new Map<string, (...args: any[]) => any>();
	const shortcuts = new Map<string, any>();
	const commands = new Map<string, any>();
	const entries: any[] = [];
	const statuses = new Map<string, string>();
	const notifications: string[] = [];
	let confirmResult = true;
	const pi = {
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		registerShortcut(key: string, definition: any) { shortcuts.set(key, definition); },
		registerCommand(name: string, definition: any) { commands.set(name, definition); },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
	} as unknown as ExtensionAPI;
	permissions(pi);
	const ctx: any = {
		cwd,
		mode: "tui",
		hasUI: true,
		sessionManager: { getEntries: () => entries, getBranch: () => entries },
		ui: {
			setStatus(key: string, value: string | undefined) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
			notify(message: string) { notifications.push(message); },
			confirm: async () => confirmResult,
		},
	};
	return { handlers, shortcuts, commands, entries, statuses, notifications, ctx, setConfirm: (value: boolean) => { confirmResult = value; } };
}

test("shift+tab toggles a persisted permission mode and updates the footer status", async (t) => {
	const h = await harness(t);
	await h.handlers.get("session_start")?.({}, h.ctx);
	assert.equal(h.statuses.get("permission-mode"), "enforce");
	await h.shortcuts.get("shift+tab").handler(h.ctx);
	assert.equal(currentPermissionMode(), "bypass");
	assert.equal(h.statuses.get("permission-mode"), "bypass");
	assert.equal(h.entries.at(-1)?.data.mode, "bypass");
	await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("enforced mode allows, asks, and denies repository policy decisions", async (t) => {
	const h = await harness(t);
	await h.handlers.get("session_start")?.({}, h.ctx);
	assert.equal(await h.handlers.get("tool_call")?.({ toolName: "read", input: { path: "README.md" } }, h.ctx), undefined);
	h.setConfirm(false);
	assert.match((await h.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "npm test" } }, h.ctx)).reason, /not granted/i);
	assert.match((await h.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "sudo reboot" } }, h.ctx)).reason, /denied/i);
	await h.shortcuts.get("shift+tab").handler(h.ctx);
	assert.equal(await h.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "sudo reboot" } }, h.ctx), undefined);
	await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("workflow confirmation is extension-owned and does not change mode by itself", async (t) => {
	const h = await harness(t);
	await h.handlers.get("session_start")?.({}, h.ctx);
	h.setConfirm(true);
	assert.equal(await confirmWorkflowBypass(h.ctx, "work-item:checkout"), true);
	assert.equal(currentPermissionMode(), "enforce");
	h.setConfirm(false);
	assert.equal(await confirmWorkflowBypass(h.ctx, "work-item:checkout"), false);
	await h.handlers.get("session_shutdown")?.({}, h.ctx);
});

test("headless spawned sessions inherit the parent process permission mode", async (t) => {
	const previous = process.env.PIBOX_PERMISSION_MODE;
	process.env.PIBOX_PERMISSION_MODE = "bypass";
	t.after(() => { if (previous === undefined) delete process.env.PIBOX_PERMISSION_MODE; else process.env.PIBOX_PERMISSION_MODE = previous; });
	const h = await harness(t);
	h.ctx.mode = "json";
	h.ctx.hasUI = false;
	await h.handlers.get("session_start")?.({}, h.ctx);
	assert.equal(currentPermissionMode(), "bypass");
	assert.equal(await h.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "sudo reboot" } }, h.ctx), undefined);
	await h.handlers.get("session_shutdown")?.({}, h.ctx);
});
