import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createVisualCompanionBackend } from "../backend.mjs";
import visualCompanion from "../index.js";

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
		assert.equal((await fetch(`${architecture.url}api/document`).then((response) => response.json())).document.id, "architecture");
		assert.equal((await fetch(`${sequence.url}api/document`).then((response) => response.json())).document.id, "sequence");
		assert.equal((await fetch(`${backend.url}/package.json`)).status, 404);
	} finally {
		await backend.close();
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
	const result = await definition.execute("stop", { action: "stop" }, undefined, undefined, {
		hasUI: false,
		cwd: process.cwd(),
	});
	assert.match(result.content[0].text, /already stopped/);
});
