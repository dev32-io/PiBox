import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeStatusBarConfig } from "../config.js";
import { GitPoller } from "../git.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("coalesces an event refresh behind an in-flight Git command", async () => {
	const resolvers: Array<(value: { stdout: string; stderr: string; code: number; killed: boolean }) => void> = [];
	let calls = 0;
	const pi = {
		exec: () => {
			calls++;
			return new Promise((resolve) => resolvers.push(resolve));
		},
	} as unknown as ExtensionAPI;
	const config = normalizeStatusBarConfig({ git: { refreshMode: "manual" } as never }).git;
	const poller = new GitPoller(pi, process.cwd(), config, () => {});

	poller.start();
	assert.equal(calls, 1);
	poller.requestRefresh();
	assert.equal(calls, 1);
	resolvers.shift()?.({ stdout: "# branch.head main\n# branch.oid abcdef1234\n", stderr: "", code: 0, killed: false });
	await tick();
	assert.equal(calls, 2);
	resolvers.shift()?.({ stdout: "# branch.head main\n# branch.oid abcdef1234\n", stderr: "", code: 0, killed: false });
	await tick();
	poller.stop();
});
