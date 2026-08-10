import assert from "node:assert/strict";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { playSound, type SpawnProcess } from "../player.js";

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

test("does not start a player on unsupported platforms", () => {
	let called = false;
	const spawn = (() => {
		called = true;
		throw new Error("unexpected");
	}) as unknown as SpawnProcess;
	assert.equal(playSound("/tmp/ping.mp3", "linux", spawn), false);
	assert.equal(called, false);
});
