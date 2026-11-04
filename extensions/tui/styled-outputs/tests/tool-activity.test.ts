import assert from "node:assert/strict";
import test from "node:test";
import {
	TOOL_RUNNING_FRAMES,
	ToolActivityTracker,
	formatToolDuration,
	formatToolElapsed,
	markToolTiming,
	runningStatus,
	toolRunningFrame,
	type ToolTiming,
} from "../components/tool-activity.js";

test("running frames twinkle through eight stars on the shared 90ms clock", () => {
	assert.deepEqual([...TOOL_RUNNING_FRAMES], ["·", "✢", "✶", "✻", "✽", "✻", "✶", "✢"]);
	assert.ok(!TOOL_RUNNING_FRAMES.includes("✳" as any));
	for (let tick = 0; tick < 16; tick++) {
		assert.equal(toolRunningFrame(tick * 90), TOOL_RUNNING_FRAMES[tick % 8]);
		assert.equal(toolRunningFrame(tick * 90 + 89), TOOL_RUNNING_FRAMES[tick % 8], "frames hold for the whole interval");
	}
});

test("durations format by magnitude and elapsed time uses whole seconds", () => {
	assert.equal(formatToolDuration(30), "0.1s");
	assert.equal(formatToolDuration(400), "0.4s");
	assert.equal(formatToolDuration(2_100), "2.1s");
	assert.equal(formatToolDuration(9_940), "9.9s");
	assert.equal(formatToolDuration(9_960), "10s");
	assert.equal(formatToolDuration(12_300), "12s");
	assert.equal(formatToolDuration(65_000), "1m 05s");
	assert.equal(formatToolElapsed(999), undefined);
	assert.equal(formatToolElapsed(12_900), "12s");
	assert.equal(formatToolElapsed(125_000), "2m 05s");
	assert.equal(runningStatus(undefined, 5_000), "Running…");
	assert.equal(runningStatus({ startedAt: 1_000 }, 13_500), "Running… 12s");
});

test("timing starts with execution, ends at the first final render, and prefers host durations", () => {
	const state: Record<string, any> = {};
	markToolTiming(state, { executionStarted: false, isPartial: true }, 100);
	assert.equal(state.piboxTiming.startedAt, undefined, "streaming arguments do not start the clock");
	markToolTiming(state, { executionStarted: true, isPartial: true }, 1_000);
	markToolTiming(state, { executionStarted: true, isPartial: true }, 2_000);
	assert.equal(state.piboxTiming.startedAt, 1_000);
	markToolTiming(state, { executionStarted: true, isPartial: false }, 3_100);
	markToolTiming(state, { executionStarted: true, isPartial: false }, 9_000);
	assert.equal(state.piboxTiming.durationMs, 2_100, "later re-renders keep the first end time");

	const hosted: Record<string, any> = {};
	markToolTiming(hosted, { executionStarted: true, isPartial: true }, 1_000);
	markToolTiming(hosted, { executionStarted: true, isPartial: false, durationMs: 1_234 }, 9_000);
	assert.equal(hosted.piboxTiming.durationMs, 1_234);

	const restored: Record<string, any> = {};
	markToolTiming(restored, { executionStarted: false, isPartial: true }, 1_000);
	markToolTiming(restored, { executionStarted: false, isPartial: false }, 9_000);
	assert.equal(restored.piboxTiming.durationMs, undefined, "restored rows never invent a duration");
	assert.equal(markToolTiming(undefined, { isPartial: false, durationMs: 5 }), undefined);
});

function fakeClock() {
	const timers = new Set<() => void>();
	let scheduled = 0;
	return {
		get active() { return timers.size; },
		get scheduled() { return scheduled; },
		tick() { for (const callback of [...timers]) callback(); },
		schedule: (callback: () => void, ms: number) => {
			assert.equal(ms, 90);
			scheduled++;
			timers.add(callback);
			return { callback, unref() {} };
		},
		cancel: (timer: any) => { timers.delete(timer.callback); },
	};
}

test("one shared timer runs only while a fullscreen tool row is running", () => {
	const clock = fakeClock();
	const tracker = new ToolActivityTracker(clock.schedule, clock.cancel);
	let renders = 0;
	const host = { mode: "fullscreen", requestRender() { renders++; } };
	tracker.update("a", true, host);
	tracker.update("b", true, host);
	assert.equal(clock.scheduled, 1, "rows share one timer");
	assert.ok(tracker.animating);
	clock.tick();
	assert.equal(renders, 1, "each tick requests one render");
	tracker.update("a", false);
	assert.ok(tracker.animating, "still running while any row runs");
	tracker.update("b", false);
	assert.equal(clock.active, 0, "last finished row stops the timer");
	assert.ok(!tracker.animating);

	tracker.update("c", true, host);
	tracker.settle("c");
	assert.equal(clock.active, 0, "tool end stops the timer");
	tracker.update("c", true, host);
	assert.equal(clock.active, 0, "a settled call cannot restart the timer from a stale render");

	tracker.update("d", true, host);
	tracker.update("e", true, host);
	tracker.settle();
	assert.equal(clock.active, 0, "agent end (abort) settles every running row");

	tracker.update("f", true, host);
	tracker.clear();
	assert.equal(clock.active, 0, "session switch/shutdown clears everything");
	tracker.update("c", true, host);
	assert.ok(tracker.animating, "a new session forgets settled ids");
	tracker.clear();
});

test("regular mode keeps static glyphs and never starts the timer", () => {
	const clock = fakeClock();
	const tracker = new ToolActivityTracker(clock.schedule, clock.cancel);
	const host = { mode: "regular", requestRender() { assert.fail("regular mode must not be redrawn by the timer"); } };
	tracker.update("a", true, host);
	tracker.update("b", true, {});
	assert.equal(clock.scheduled, 0);
	assert.ok(!tracker.animating);
	assert.equal(tracker.runningCount, 2);

	const switching = { mode: "fullscreen", requestRender() {} };
	tracker.update("c", true, switching);
	assert.ok(tracker.animating);
	(switching as any).mode = "regular";
	clock.tick();
	assert.ok(!tracker.animating, "switching to regular mode stops animation on the next tick");
});

test("rows still running at agent end stop counting elapsed time", () => {
	const tracker = new ToolActivityTracker(() => ({}), () => {});
	const timing: ToolTiming = { startedAt: 1_000 };
	tracker.update("a", true, { mode: "regular" }, timing);
	assert.equal(runningStatus(timing, 13_500), "Running… 12s");
	tracker.settle(undefined, 6_200);
	assert.equal(runningStatus(timing, 60_000), "Running… 5s", "later redraws keep the frozen elapsed time");
	assert.equal(runningStatus(timing, 6_300), "Running… 5s");
	const done: ToolTiming = { startedAt: 1_000, durationMs: 300 };
	tracker.update("b", true, { mode: "regular" }, done);
	tracker.settle(undefined, 9_000);
	assert.equal(done.frozenAt, undefined, "finished timing is untouched");
});
