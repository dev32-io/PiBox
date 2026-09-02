import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

type Compare = (...args: any[]) => Promise<any>;
type VisualDiffModule = {
	parseArguments(argv: string[]): Record<string, any>;
	runVisualDiff(argv: string[], dependencies?: { compare?: Compare; stdout?: (line: string) => void; stderr?: (line: string) => void }): Promise<number>;
};

const moduleUrl = pathToFileURL(resolve("examples/visual-diff/visual-diff.mjs")).href;
const visualDiff = await import(moduleUrl) as VisualDiffModule;

test("visual diff example keeps comparison pairwise and report-first", async () => {
	const output: string[] = [];
	let options: Record<string, unknown> | undefined;
	const exitCode = await visualDiff.runVisualDiff(["reference.png", "actual.png"], {
		compare: async (_reference, _actual, _diff, receivedOptions) => {
			options = receivedOptions;
			return {
				match: false,
				reason: "pixel-diff",
				diffCount: 24,
				diffPercentage: 1.25,
				diffLines: [2, 3, 8],
				diffCols: [4, 9],
			};
		},
		stdout: (line) => output.push(line),
	});

	assert.equal(exitCode, 0, "differences guide the agent unless a project opts into a gate");
	assert.deepEqual(options, {
		threshold: 0.1,
		antialiasing: true,
		failOnLayoutDiff: true,
		noFailOnFsErrors: true,
		diffOverlay: true,
		captureDiffLines: true,
		captureDiffCols: true,
	});
	const report = JSON.parse(output[0] ?? "{}");
	assert.equal(report.reason, "pixel-diff");
	assert.equal(report.diffPercentage, 1.25);
	assert.deepEqual(report.bounds, { left: 4, top: 2, right: 9, bottom: 8 });
	assert.match(report.diffPath, /actual\.visual-diff\.png$/);
});

test("visual diff example lets a project opt into a percentage gate", async () => {
	const output: string[] = [];
	const exitCode = await visualDiff.runVisualDiff([
		"reference.png",
		"actual.png",
		"--threshold", "0.2",
		"--max-diff-percentage", "1",
	], {
		compare: async () => ({ match: false, reason: "pixel-diff", diffCount: 24, diffPercentage: 1.25 }),
		stdout: (line) => output.push(line),
	});

	assert.equal(exitCode, 1);
	const report = JSON.parse(output[0] ?? "{}");
	assert.equal(report.threshold, 0.2);
	assert.equal(report.maxDiffPercentage, 1);
	assert.equal(report.withinLimit, false);
});
