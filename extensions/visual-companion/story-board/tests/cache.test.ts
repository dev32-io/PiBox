import assert from "node:assert/strict";
import test from "node:test";
import { StoryBoardCache } from "../index.js";

test("identical reads share work and rejected reads retry", async () => {
	const cache = new StoryBoardCache(); let calls = 0; let release!: (value: number) => void;
	const load = () => { calls += 1; return new Promise<number>((resolve) => { release = resolve; }); };
	const first = cache.read("catalog", load); const second = cache.read("catalog", load);
	assert.equal(first, second); assert.equal(calls, 0);
	await Promise.resolve(); assert.equal(calls, 1); release(7); assert.equal(await first, 7);
	assert.equal(await cache.read("catalog", load), 7); assert.equal(calls, 1);

	let failures = 0;
	await assert.rejects(cache.read("failed", async () => { failures += 1; throw new Error("nope"); }));
	assert.equal(await cache.read("failed", async () => { failures += 1; return 9; }), 9);
	assert.equal(failures, 2);
});

test("invalidation prevents stale in-flight work from repopulating cache", async () => {
	const cache = new StoryBoardCache(); let oldRelease!: (value: string) => void;
	const old = cache.read("catalog", () => new Promise<string>((resolve) => { oldRelease = resolve; }));
	await Promise.resolve(); cache.invalidate();
	assert.equal(await cache.read("catalog", async () => "replacement"), "replacement");
	oldRelease("stale"); assert.equal(await old, "stale");
	assert.equal(await cache.read("catalog", async () => "wrong"), "replacement");
	cache.close(); await assert.rejects(cache.read("catalog", async () => "closed"), /closed/);
});
