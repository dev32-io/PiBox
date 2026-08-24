import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createVisualCompanionBackend } from "../backend.mjs";
import visualCompanion from "../index.js";
import { getService } from "../../service-adapter/registry.js";

async function fixture(root: string, id: string) {
	const assetsDir = join(root, id);
	const artifactPath = join(root, `${id}.json`);
	await mkdir(assetsDir, { recursive: true });
	await writeFile(join(assetsDir, "index.html"), `<h1>${id}</h1>`);
	await writeFile(artifactPath, JSON.stringify({ id }));
	return {
		artifactPath,
		viewer: {
			id,
			assetsDir,
			loadDocument(path: string) {
				return { ok: true, document: { id, path }, errors: [] };
			},
		},
	};
}

test("one random-port backend serves multiple registered visualizers", async () => {
	const root = await mkdtemp(join(tmpdir(), "visual-companion-"));
	const first = await fixture(root, "architecture");
	const second = await fixture(root, "sequence");
	const backend = await createVisualCompanionBackend({ viewers: [first.viewer, second.viewer] });
	try {
		const architecture = backend.show({ viewerId: "architecture", artifactPath: first.artifactPath });
		const sequence = backend.show({ viewerId: "sequence", artifactPath: second.artifactPath });
		assert.equal(new URL(architecture.url).port, String(backend.port));
		assert.equal(new URL(sequence.url).port, String(backend.port));
		assert.notEqual(architecture.url, sequence.url);
		assert.equal((await fetch(`${architecture.viewerUrl}api/document`).then((response) => response.json()) as any).document.id, "architecture");
		assert.equal((await fetch(`${sequence.viewerUrl}api/document`).then((response) => response.json()) as any).document.id, "sequence");
		assert.equal((await fetch(architecture.url)).status, 200);
		assert.equal((await fetch(`${backend.url}/package.json`)).status, 404);
	} finally {
		await backend.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("backend and artifact watcher cannot pin the owning Pi process after quit", async () => {
	const root = await mkdtemp(join(tmpdir(), "visual-companion-exit-"));
	const visualizer = await fixture(root, "exit-check");
	const backendModule = pathToFileURL(resolve("extensions/visual-companion/backend.mjs")).href;
	const script = `
		import { createVisualCompanionBackend } from ${JSON.stringify(backendModule)};
		const backend = await createVisualCompanionBackend({ viewers: [{
			id: "exit-check",
			assetsDir: ${JSON.stringify(visualizer.viewer.assetsDir)},
			loadDocument: (path) => ({ ok: true, document: { path }, errors: [] }),
		}] });
		backend.show({ viewerId: "exit-check", artifactPath: ${JSON.stringify(visualizer.artifactPath)} });
	`;
	try {
		await new Promise<void>((done, reject) => {
			const child = spawn(process.execPath, ["--input-type=module", "--eval", script], { stdio: "ignore" });
			const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("visual companion backend kept its owner process alive")); }, 3_000);
			child.once("error", (error) => { clearTimeout(timer); reject(error); });
			child.once("exit", (code) => { clearTimeout(timer); code === 0 ? done() : reject(new Error(`child exited ${code}`)); });
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("extension registers one session-scoped start/stop tool", async () => {
	let definition: any;
	const events = new Map<string, (...args: any[]) => unknown>();
	const pi = {
		registerTool(value: unknown) { definition = value; },
		on(name: string, handler: (...args: any[]) => unknown) { events.set(name, handler); },
	} as unknown as ExtensionAPI;
	visualCompanion(pi);
	assert.equal(definition.name, "visual_companion");
	assert.match(definition.description, /single.*session/i);
	assert.deepEqual([...events.keys()], ["session_start", "session_shutdown"]);
	const ctx = { hasUI: false, cwd: process.cwd() } as any;
	const service = getService("visual-companion");
	assert.ok(service?.controller.start);
	const first = await service.controller.start({ ctx });
	const second = await service.controller.start({ ctx });
	assert.equal(first.state, "running");
	assert.equal(second.detail, first.detail);
	assert.equal((await fetch(first.detail!)).status, 200);
	assert.equal((await service.controller.health({ ctx })).state, "running");
	assert.equal((await service.controller.stop!({ ctx })).state, "stopped");
	assert.equal((await service.controller.stop!({ ctx })).state, "stopped");
	const result = await definition.execute("stop", { action: "stop" }, undefined, undefined, ctx);
	assert.match(result.content[0].text, /already stopped/);
	await events.get("session_shutdown")?.({ reason: "quit" }, ctx);
});
