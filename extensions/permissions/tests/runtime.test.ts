import assert from "node:assert/strict";
import test from "node:test";
import type { PermissionRuntimeController } from "../runtime.js";

test("shares the permission controller across separately loaded extension module instances", async () => {
	const first = await import(new URL("../runtime.ts?extension=permissions", import.meta.url).href);
	const second = await import(new URL("../runtime.ts?extension=workflow", import.meta.url).href);
	const controller: PermissionRuntimeController = {
		getMode: () => "enforce",
		setMode() {},
		confirmWorkflowStart: async () => true,
	};
	const uninstall = first.installPermissionRuntime(controller);
	try {
		assert.equal(second.currentPermissionMode(), "enforce");
		assert.equal(await second.confirmWorkflowBypass({} as any, "work-item:test"), true);
	} finally {
		uninstall();
	}
	assert.equal(second.currentPermissionMode(), undefined);
});
