import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createVisualCompanionBackend } from "../backend.mjs";
import visualCompanion, { resolveArtifact } from "../index.js";
import { getService } from "../../service-adapter/registry.js";
import { createSessionScratchWorkspace } from "../../session-scratch/workspace.js";
import { SESSION_SCRATCH_ENTRY_TYPE } from "../../session-scratch/binding.js";

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
		const architecture = await backend.show({ viewerId: "architecture", artifactPath: first.artifactPath });
		const sequence = await backend.show({ viewerId: "sequence", artifactPath: second.artifactPath });
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
		await backend.show({ viewerId: "exit-check", artifactPath: ${JSON.stringify(visualizer.artifactPath)} });
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

test("repository-relative artifacts resolve from a nested working directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "visual-companion-root-"));
	const nested = join(root, "apps", "web");
	const prototype = join(root, "design", "prototypes", "demo");
	await mkdir(join(root, ".git"));
	await mkdir(nested, { recursive: true });
	await mkdir(prototype, { recursive: true });
	await writeFile(join(prototype, "index.html"), "<h1>Demo</h1>");
	try {
		assert.equal(resolveArtifact(nested, "design/prototypes/demo"), await realpath(prototype));
		assert.throws(() => resolveArtifact(nested, "../outside"), /not found|inside the current repository/);
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
	assert.deepEqual([...events.keys()], ["session_start", "session_tree", "session_shutdown"]);
	let branch: any[] = [];
	const ctx = { hasUI: false, cwd: process.cwd(), sessionManager: { getBranch: () => branch, getSessionId: () => "companion-session" } } as any;
	const service = getService("visual-companion");
	assert.ok(service?.controller.start);
	const first = await service.controller.start({ ctx });
	const second = await service.controller.start({ ctx });
	assert.equal(first.state, "running");
	assert.equal(second.detail, first.detail);
	assert.equal((await fetch(first.detail!)).status, 200);
	assert.deepEqual((await (await fetch(`${first.detail}/api/viewers`)).json()).viewers, ["story-board", "scratch"]);
	assert.equal((await (await fetch(`${first.detail}/v/scratch/api/tree?path=`)).json()).kind, "unavailable");
	const scratch = await createSessionScratchWorkspace("companion-session");
	try {
		branch = [{ type: "custom", customType: SESSION_SCRATCH_ENTRY_TYPE, data: { schemaVersion: 1, binding: scratch.binding } }];
		assert.deepEqual((await (await fetch(`${first.detail}/api/viewers`)).json()).viewers, ["story-board", "scratch"]);
		assert.equal((await fetch(`${first.detail}/v/scratch/api/notes`)).status, 200);
		const stream = await fetch(`${first.detail}/v/scratch/events`, { signal: AbortSignal.timeout(5_000) });
		const reader = stream.body!.getReader();
		assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
		branch = [];
		await events.get("session_tree")?.({}, ctx);
		assert.match(new TextDecoder().decode((await reader.read()).value), /event: unavailable/);
		assert.equal((await reader.read()).done, true, "tree changes close the old scratch stream immediately");
		assert.equal((await fetch(`${first.detail}/v/scratch/api/notes`)).status, 404);
	} finally { await rm(scratch.paths.root, { recursive: true, force: true }); }
	assert.equal((await service.controller.health({ ctx })).state, "running");
	assert.equal((await service.controller.stop!({ ctx })).state, "stopped");
	assert.equal((await service.controller.stop!({ ctx })).state, "stopped");
	const result = await definition.execute("stop", { action: "stop" }, undefined, undefined, ctx);
	assert.match(result.content[0].text, /already stopped/);
	await events.get("session_shutdown")?.({ reason: "quit" }, ctx);
});

test("async loads coalesce edits, fence superseded results, and close waits for owned work", async () => {
	const root = await mkdtemp(join(tmpdir(), "visual-companion-async-"));
	const artifact = join(root, "source.c4");
	await writeFile(artifact, "initial");
	const loads: Array<(value: any) => void> = [];
	let disposed = false;
	const backend = await createVisualCompanionBackend({ viewers: [{ id: "async", loadDocument: () => new Promise(resolve => loads.push(resolve)), close: () => { disposed = true; } }] });
	const waitFor = async (predicate: () => boolean) => {
		for (let i = 0; i < 100 && !predicate(); i++) await new Promise(done => setTimeout(done, 10));
		assert.ok(predicate(), "async condition settled");
	};
	const valid = (revision: string) => ({ ok: true, document: { revision }, errors: [] });
	try {
		const first = backend.show({ viewerId: "async", artifactPath: artifact });
		const firstRejected = assert.rejects(async () => first, /superseded or closed/);
		await waitFor(() => loads.length === 1);
		const second = backend.show({ viewerId: "async", artifactPath: artifact });
		await waitFor(() => loads.length === 2);
		loads[1]!(valid("second"));
		await second;
		loads[0]!(valid("obsolete"));
		await firstRejected;
		const document = () => fetch(`${backend.url}/v/async/api/document`).then(response => response.json());
		assert.equal((await document()).document.revision, "second");
		await writeFile(artifact, "edit1");
		await waitFor(() => loads.length === 3);
		await writeFile(artifact, "edit2");
		await new Promise(done => setTimeout(done, 100));
		assert.equal(loads.length, 3, "no overlapping compilation for same state");
		loads[2]!(valid("stale edit"));
		await waitFor(() => loads.length === 4);
		assert.equal((await document()).document.revision, "second", "stale edit never published");
		loads[3]!(valid("latest edit"));
		await waitFor(() => true);
		assert.equal((await document()).document.revision, "latest edit");
		await writeFile(artifact, "pending at shutdown");
		await waitFor(() => loads.length === 5);
		let closed = false;
		const closing = backend.close().then(() => { closed = true; });
		await new Promise(done => setTimeout(done, 20));
		assert.equal(closed, false);
		assert.equal(disposed, false, "viewer resources outlive owned compilation");
		loads[4]!(valid("late"));
		await closing;
		assert.equal(disposed, true);
		await assert.rejects(async () => backend.show({ viewerId: "async", artifactPath: artifact }), /closed/);
	} finally { await backend.close(); await rm(root, { recursive: true, force: true }); }
});
