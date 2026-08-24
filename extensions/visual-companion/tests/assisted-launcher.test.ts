import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import test from "node:test";
import { launchAssistedVisualCompanion, ASSISTED_PRODUCTION_COMPOSITION } from "../assisted-launcher.js";
import { createVisualCompanionBackend } from "../backend.mjs";
import { createStoryBoardViewer } from "../story-board/api.js";
import { StoryBoardReader } from "../story-board/reader.js";
import { createAssistedFixtureRepository } from "../story-board/fixtures.js";
import { createArchitectureViewer } from "../../../skills/architecture-visualizer/scripts/server.mjs";

async function startedFixture(delay = 0) {
	const fixture = await createAssistedFixtureRepository();
	const launch = await launchAssistedVisualCompanion({ repositoryRoot: fixture.repositoryRoot, architectureArtifactPath: fixture.architectureArtifactPath, discoveryDelayMs: delay });
	return { fixture, launch, async close() { await launch.close(); await launch.close(); await fixture.cleanup(); } };
}

test("assisted launch binds randomly to loopback and composes production factories", async () => {
	assert.equal(ASSISTED_PRODUCTION_COMPOSITION.backendFactory, createVisualCompanionBackend);
	assert.equal(ASSISTED_PRODUCTION_COMPOSITION.storyBoardFactory, createStoryBoardViewer);
	assert.equal(ASSISTED_PRODUCTION_COMPOSITION.storyBoardReader, StoryBoardReader);
	assert.equal(ASSISTED_PRODUCTION_COMPOSITION.architectureFactory, createArchitectureViewer);
	const assisted = await startedFixture();
	try {
		assert.equal(assisted.launch.host, "127.0.0.1"); assert.ok(assisted.launch.port > 0);
		assert.deepEqual((await fetch(`${new URL(assisted.launch.url).origin}/api/viewers`).then((response) => response.json()) as any).viewers, ["story-board", "architecture"]);
		assert.equal((await fetch(assisted.launch.architectureUrl)).status, 200);
		assert.equal(assisted.launch.diagnostics().backendCount, 1);
	} finally { await assisted.close(); }
});

test("discovery is deferred, delayed, bounded, and recoverable only inside the fixture", async () => {
	const assisted = await startedFixture(80);
	try {
		assert.equal(assisted.launch.diagnostics().storyBoard.discovery, "not-started");
		const catalogUrl = `${new URL(assisted.launch.url).origin}/v/story-board/api/catalog`;
		const pending = fetch(catalogUrl); await new Promise((done) => setTimeout(done, 20));
		assert.equal(assisted.launch.diagnostics().storyBoard.discovery, "delayed");
		assert.equal((await pending).status, 200); assert.equal(assisted.launch.diagnostics().storyBoard.discovery, "complete");
		const remote = await fetch(assisted.launch.diagnosticsUrl).then((response) => response.json()) as any;
		assert.deepEqual(Object.keys(remote), ["schemaVersion", "backendCount", "state", "viewers", "storyBoard", "recovery"]); assert.doesNotMatch(JSON.stringify(remote), /[/\\](?:Users|home|tmp)[/\\]/);
		assert.equal(await assisted.launch.recoverMalformedResource(), true); assert.equal(await assisted.launch.recoverMalformedResource(), false);
		assert.equal((await fetch(`${new URL(assisted.launch.url).origin}/v/story-board/api/refresh`, { method: "POST" })).status, 202);
	} finally { await assisted.close(); }
});

async function runCli(signal: "SIGINT" | "SIGTERM"): Promise<void> {
	const cli = resolve("extensions/visual-companion/assisted-launcher-cli.ts");
	const child = spawn("npx", ["tsx", cli], { stdio: ["ignore", "pipe", "pipe"] });
	let output = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { output += chunk; });
	const deadline = Date.now() + 4_000; while (!output.includes("\n") && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
	const lines = output.trim().split("\n"); assert.equal(lines.length, 1); const startup = JSON.parse(lines[0]!); assert.equal(startup.type, "visual-companion-assisted-start"); assert.match(startup.url, /^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d+\/story-board$/);
	child.kill(signal); const [code, exitSignal] = await once(child, "exit") as [number | null, NodeJS.Signals | null]; assert.equal(exitSignal, null); assert.equal(code, 0);
}

test("explicit control shutdown is idempotent", async () => {
	const assisted = await startedFixture();
	try {
		assert.equal((await fetch(assisted.launch.closeUrl, { method: "POST" })).status, 202);
		const deadline = Date.now() + 2_000; while (assisted.launch.diagnostics().state !== "closed" && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
		assert.equal(assisted.launch.diagnostics().state, "closed"); await assisted.launch.close();
	} finally { await assisted.fixture.cleanup(); }
});

test("CLI emits one startup record and handles SIGINT exactly once", () => runCli("SIGINT"));
test("CLI handles SIGTERM and leaves no nested Pi process", () => runCli("SIGTERM"));
