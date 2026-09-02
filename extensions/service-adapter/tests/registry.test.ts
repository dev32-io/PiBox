import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { summarizeServices } from "../index.js";
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

test("a stale unregister callback cannot remove a newer registration", () => {
	resetServiceRegistryForTests();
	const removeOld = registerService({ id: "mem0", name: "Mem0", order: 10, internal: true, stayAlive: true, singleton: true, perSession: false }, { health: async () => ({ state: "stopped" }) });
	removeOld();
	const removeCurrent = registerService({ id: "mem0", name: "Mem0", order: 10, internal: true, stayAlive: true, singleton: true, perSession: false }, { health: async () => ({ state: "running" }) });
	try {
		removeOld();
		assert.equal(listServices().length, 1);
		assert.equal(listServices()[0]?.descriptor.id, "mem0");
	} finally {
		removeCurrent();
	}
});

test("a declared service can be replaced by its loaded extension without stale cleanup", async () => {
	resetServiceRegistryForTests();
	const descriptor = { id: "visual-companion", name: "Visual companion", order: 30, internal: true, stayAlive: false, singleton: true, perSession: true };
	const removePlaceholder = registerService(descriptor, {
		health: async () => ({ state: "stopped", detail: "extension not loaded" }),
	});
	const removeLoaded = registerService(descriptor, {
		health: async () => ({ state: "stopped" }),
		start: async () => ({ state: "running", detail: "127.0.0.1:1234" }),
	}, { replace: true });
	try {
		removePlaceholder();
		assert.deepEqual(listServices().map(({ descriptor: service }) => service.id), ["visual-companion"]);
		assert.equal((await operateService("visual-companion", "start", { ctx })).state, "running");
	} finally {
		removeLoaded();
	}
});

test("shares services across separately loaded extension module instances", async () => {
	const first = await import(new URL("../registry.ts?extension=service-adapter", import.meta.url).href);
	const second = await import(new URL("../registry.ts?extension=visual-companion", import.meta.url).href);
	first.resetServiceRegistryForTests();
	const descriptor = { id: "visual-companion", name: "Visual companion", order: 30, internal: true, stayAlive: false, singleton: true, perSession: true };
	const removePlaceholder = first.registerService(descriptor, {
		health: async () => ({ state: "stopped", detail: "extension not loaded" }),
	});
	const removeLoaded = second.registerService(descriptor, {
		health: async () => ({ state: "stopped" }),
		start: async () => ({ state: "running", detail: "127.0.0.1:1234" }),
	}, { replace: true });
	try {
		assert.equal((await first.operateService("visual-companion", "start", { ctx })).state, "running");
		assert.equal(second.getService("visual-companion")?.snapshot.detail, "127.0.0.1:1234");
	} finally {
		removePlaceholder();
		removeLoaded();
	}
});

test("status summary lists running and stopped service ids with a start hint", async () => {
	resetServiceRegistryForTests();
	const removeMem0 = registerService({ id: "mem0", name: "Mem0", order: 10, internal: true, stayAlive: true, singleton: true, perSession: false }, { health: async () => ({ state: "running", detail: "127.0.0.1:6001" }) });
	const removeVisual = registerService({ id: "visual-companion", name: "Visual companion", order: 30, internal: true, stayAlive: false, singleton: true, perSession: true }, { health: async () => ({ state: "stopped" }) });
	try {
		await operateService("mem0", "health", { ctx });
		assert.equal(summarizeServices(), [
			"Available services:",
			"- mem0 — running · 127.0.0.1:6001",
			"- visual-companion — stopped",
			"Use /services start <service-id> to start one.",
		].join("\n"));
	} finally {
		removeMem0();
		removeVisual();
	}
});

test("unknown service errors list available ids", async () => {
	resetServiceRegistryForTests();
	const remove = registerService({ id: "visual-companion", name: "Visual companion", order: 30, internal: true, stayAlive: false, singleton: true, perSession: true }, { health: async () => ({ state: "stopped" }) });
	try {
		await assert.rejects(operateService("visual-story-board", "start", { ctx }), /Unknown service: visual-story-board\. Available services: visual-companion\./);
	} finally {
		remove();
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
