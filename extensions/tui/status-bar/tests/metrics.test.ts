import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectSessionMetrics } from "../metrics.js";

function assistant(input: number, output: number, cacheRead: number, cost: number) {
	return {
		role: "assistant",
		content: [],
		usage: {
			input,
			output,
			cacheRead,
			cacheWrite: 0,
			totalTokens: input + output + cacheRead,
			cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		},
		stopReason: "stop",
		api: "test",
		provider: "test",
		model: "test",
		timestamp: 1,
	};
}

test("collects cumulative usage independently of active context", () => {
	const ctx = {
		sessionManager: {
			getBranch: () => [
				{ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: assistant(100, 20, 300, 0.01) },
				{ type: "message", timestamp: "2026-01-01T00:01:00.000Z", message: assistant(50, 10, 50, 0.02) },
			],
		},
	} as unknown as ExtensionContext;
	const now = Date.parse("2026-01-01T00:10:00.000Z");
	const metrics = collectSessionMetrics(ctx, now);
	assert.equal(metrics.input, 150);
	assert.equal(metrics.output, 30);
	assert.equal(metrics.cacheRead, 350);
	assert.equal(metrics.cost, 0.03);
	assert.equal(metrics.cacheHitPercent, 70);
	assert.equal(metrics.durationMs, 600_000);
});
