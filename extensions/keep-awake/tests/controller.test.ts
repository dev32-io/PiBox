import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import test from "node:test";
import { KeepAwakeController } from "../controller.js";

class FakeChild extends EventEmitter {
	pid: number | undefined = 123;
	signals: unknown[] = [];
	unreferenced = false;
	kill(signal: unknown) { this.signals.push(signal); return true; }
	unref() { this.unreferenced = true; }
	ref() { this.unreferenced = false; }
}
function harness(platform: NodeJS.Platform = "darwin") {
	const children: FakeChild[] = [];
	const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
	const failures: string[] = [];
	const controller = new KeepAwakeController({ platform, pid: 456, spawn(command, args, options) {
		calls.push({ command, args, options });
		const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess;
	}, onFailure: (message) => failures.push(message) });
	return { controller, children, calls, failures };
}

test("no startup process; macOS demand owns one PID-scoped assertion and releases it", async () => {
	const h = harness();
	assert.equal(h.controller.status, "idle");
	assert.equal(h.calls.length, 0);
	h.controller.setActive(true);
	h.controller.setActive(true);
	assert.equal(h.calls.length, 1);
	assert.deepEqual(h.calls[0], { command: "/usr/bin/caffeinate", args: ["-d", "-i", "-w", "456"], options: { stdio: "ignore", shell: false } });
	assert.equal(h.controller.status, "starting");
	assert.equal(h.children[0]!.unreferenced, true);
	h.children[0]!.emit("spawn");
	assert.equal(h.controller.status, "active");
	h.controller.setActive(false);
	assert.equal(h.controller.status, "stopping");
	assert.deepEqual(h.children[0]!.signals, ["SIGTERM"]);
	h.children[0]!.emit("exit", 0, null);
	assert.equal(h.controller.status, "idle");
	await h.controller.close();
});

test("non-macOS activity and commands are harmless no-ops", async () => {
	for (const platform of ["linux", "win32"] as const) {
		const h = harness(platform);
		h.controller.setActive(true); h.controller.retry(); h.controller.setActive(false);
		await h.controller.close();
		assert.equal(h.controller.status, "unsupported");
		assert.equal(h.calls.length, 0);
		assert.deepEqual(h.failures, []);
	}
});

test("off while spawning and rapid off/on serialize replacement until confirmed exit", async () => {
	const h = harness();
	h.controller.setActive(true);
	h.controller.setActive(false);
	h.controller.setActive(true);
	assert.equal(h.calls.length, 1);
	h.children[0]!.emit("spawn");
	assert.deepEqual(h.children[0]!.signals, ["SIGTERM", "SIGTERM"]);
	h.children[0]!.emit("exit", 0, null);
	assert.equal(h.calls.length, 2);
	const closing = h.controller.close();
	assert.equal(h.children[1]!.unreferenced, false, "explicit shutdown waits for exit even without other event-loop handles");
	assert.equal(h.controller.close(), closing);
	h.children[1]!.emit("exit", 0, null);
	await closing;
	h.controller.setActive(true); h.controller.retry();
	assert.equal(h.calls.length, 2);
});

test("spawn errors and unexpected exits fail once without automatic retry loops", async () => {
	const h = harness();
	h.controller.setActive(true);
	h.children[0]!.pid = undefined;
	h.children[0]!.emit("error", new Error("ENOENT"));
	assert.equal(h.controller.status, "failed");
	h.controller.setActive(false); h.controller.setActive(true);
	assert.equal(h.calls.length, 1);
	h.controller.retry();
	assert.equal(h.calls.length, 2);
	h.children[1]!.emit("spawn");
	h.children[1]!.emit("exit", 1, null);
	assert.equal(h.controller.status, "failed");
	assert.equal(h.failures.length, 1);
	await h.controller.close();
	const syncFailure = new KeepAwakeController({ platform: "darwin", spawn() { throw new Error("no spawn"); }, onFailure() { throw new Error("observer"); } });
	assert.doesNotThrow(() => syncFailure.setActive(true));
	assert.equal(syncFailure.status, "failed");
	await syncFailure.close();
});

test("shutdown escalates and bounds an unconfirmed exit without starting an overlap", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	h.controller.setActive(true);
	const closing = h.controller.close();
	t.mock.timers.tick(1_000);
	assert.deepEqual(h.children[0]!.signals, ["SIGTERM", "SIGKILL"]);
	t.mock.timers.tick(1_000);
	await closing;
	assert.equal(h.controller.status, "failed");
	h.controller.retry(); h.controller.setActive(true);
	assert.equal(h.calls.length, 1);
	h.children[0]!.emit("exit", null, "SIGKILL");
	assert.equal(h.failures.length, 1);
});
