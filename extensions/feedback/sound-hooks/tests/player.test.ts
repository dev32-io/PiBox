import assert from "node:assert/strict";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { AudioArbiter, playSound, type Playback, type SpawnProcess } from "../player.js";

test("spawns afplay detached without a shell on macOS", () => {
	let invocation: unknown[] | undefined;
	let unrefCalled = false;
	const child = new EventEmitter() as ChildProcess;
	child.unref = () => {
		unrefCalled = true;
		return child;
	};
	const spawn = ((...args: unknown[]) => {
		invocation = args;
		return child;
	}) as SpawnProcess;

	assert.equal(playSound("/tmp/ping.mp3", "darwin", spawn), true);
	assert.deepEqual(invocation, ["afplay", ["/tmp/ping.mp3"], { detached: true, stdio: "ignore" }]);
	assert.equal(unrefCalled, true);
});

test("arbitrates delayed success, response overlap, and error preemption with fake timers", () => {
	let now = 0;
	const timers = new Map<number, () => void>();
	let next = 1;
	const played: string[] = [];
	const stopped: string[] = [];
	const arbiter = new AudioArbiter((kind) => { played.push(kind); return { stop: () => stopped.push(kind) } satisfies Playback; }, {
		setTimeout(callback) { const id = next++; timers.set(id, callback); return id; },
		clearTimeout(handle) { timers.delete(handle as number); },
	}, 100);
	assert.equal(arbiter.request("success", "workflow-1"), true);
	assert.equal(arbiter.request("success", "workflow-1"), true, "another completion resets the debounce window");
	assert.equal(timers.size, 1, "the burst retains one pending sound");
	assert.equal(arbiter.request("response", "turn-1"), false, "response completion waits behind workflow success");
	assert.deepEqual(played, []);
	for (const callback of timers.values()) callback();
	assert.deepEqual(played, ["success"]);
	assert.equal(arbiter.request("error", "workflow-1"), true);
	assert.deepEqual(played, ["success", "error"]);
	assert.deepEqual(stopped, ["success"]);
});

test("does not start a player on unsupported platforms", () => {
	let called = false;
	const spawn = (() => {
		called = true;
		throw new Error("unexpected");
	}) as unknown as SpawnProcess;
	assert.equal(playSound("/tmp/ping.mp3", "linux", spawn), false);
	assert.equal(called, false);
});
