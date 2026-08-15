import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatServiceStatus, listServiceDetails, listServices, operateService, registerService, resetServiceRegistryForTests } from "../registry.js";

const ctx = {
	hasUI: true,
	ui: {
		theme: { fg: (_token: string, value: string) => value },
		setStatus() {},
	},
} as unknown as ExtensionContext;

test("orders services and renders intentionally stopped as a neutral hollow dot", () => {
	resetServiceRegistryForTests();
	const removeVisual = registerService({ id: "visual", name: "Visual companion", order: 30, internal: true, stayAlive: false, singleton: true, perSession: true }, { health: async () => ({ state: "stopped" }) });
	const removeMem0 = registerService({ id: "mem0", name: "Mem0", order: 10, internal: true, stayAlive: true, singleton: true, perSession: false }, { health: async () => ({ state: "running" }) });
	try {
		assert.deepEqual(listServices().map(({ descriptor }) => descriptor.id), ["mem0", "visual"]);
		assert.equal(formatServiceStatus(ctx, listServices()[1]!), "○ Visual companion");
	} finally {
		removeMem0();
		removeVisual();
	}
});

test("service details exclude non-cloneable controller functions", () => {
	resetServiceRegistryForTests();
	const remove = registerService({ id: "test", name: "Test", order: 1, internal: true, stayAlive: true, singleton: true, perSession: false }, {
		health: async () => ({ state: "running" }),
	});
	try {
		const details = listServiceDetails();
		assert.doesNotThrow(() => structuredClone(details));
		assert.deepEqual(details, [{
			descriptor: { id: "test", name: "Test", order: 1, internal: true, stayAlive: true, singleton: true, perSession: false },
			snapshot: { state: "stopped" },
		}]);
	} finally {
		remove();
	}
});

test("operations publish their terminal service state", async () => {
	resetServiceRegistryForTests();
	const statuses: Array<string | undefined> = [];
	const operationCtx = {
		...ctx,
		ui: { ...ctx.ui, setStatus: (_key: string, value?: string) => statuses.push(value) },
	} as ExtensionContext;
	const remove = registerService({ id: "test", name: "Test", order: 1, internal: true, stayAlive: true, singleton: true, perSession: false }, {
		health: async () => ({ state: "stopped" }),
		start: async () => ({ state: "running", detail: "localhost:1" }),
	});
	try {
		const snapshot = await operateService("test", "start", { ctx: operationCtx });
		assert.equal(snapshot.state, "running");
		assert.deepEqual(statuses, ["◌ Test", "● Test"]);
	} finally {
		remove();
	}
});
