import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createVisualCompanionBackend } from "../backend.mjs";
import { createVisualCompanionPlatform } from "../platform.js";

async function fixture(root: string) {
	const assetsDir = join(root, "viewer");
	const artifactPath = join(root, "document.json");
	await mkdir(assetsDir);
	await writeFile(join(assetsDir, "index.html"), "viewer");
	await writeFile(artifactPath, "{}");
	return { assetsDir, artifactPath };
}

test("platform publishes the shell before creating an optional viewer and reuses concurrent starts", async () => {
	let shellReady = false;
	let backendCreations = 0;
	const platform = createVisualCompanionPlatform({
		createBackend: async () => {
			backendCreations++;
			const backend = await createVisualCompanionBackend();
			assert.equal((await fetch(backend.url)).status, 200);
			shellReady = true;
			return backend;
		},
	});
	const [first, second] = await Promise.all([platform.start(), platform.start()]);
	assert.equal(first.backend, second.backend);
	assert.equal(backendCreations, 1);
	assert.equal(platform.status().state, "running");

	const root = await mkdtemp(join(tmpdir(), "visual-platform-"));
	const { assetsDir, artifactPath } = await fixture(root);
	try {
		const shown = await platform.open({
			viewer: () => {
				assert.equal(shellReady, true);
				return { id: "architecture", assetsDir, loadDocument: () => ({ ok: true, document: {}, errors: [] }) };
			},
			artifactPath,
		});
		assert.equal(shown.reused, true);
		assert.equal(new URL(shown.url).pathname, "/");
		assert.equal(new URL(shown.url).searchParams.get("viewer"), "architecture");
		assert.equal(first.backend.selectedViewer, "architecture");
	} finally {
		await Promise.all([platform.stop(), platform.stop()]);
		assert.equal(platform.status().state, "stopped");
		await rm(root, { recursive: true, force: true });
	}
});

test("registered static and dynamic routes stay viewer-scoped and resources close once", async () => {
	const root = await mkdtemp(join(tmpdir(), "visual-routes-"));
	const { assetsDir } = await fixture(root);
	let closes = 0;
	const backend = await createVisualCompanionBackend();
	backend.registerViewer({
		id: "bounded",
		assetsDir,
		handlers: {
			"/api/ping": (_request, response) => {
				response.writeHead(200, { "content-type": "text/plain" });
				response.end("pong");
			},
		},
		close: () => { closes++; },
	});
	try {
		assert.equal(await fetch(`${backend.url}/v/bounded/api/ping`).then((response) => response.text()), "pong");
		assert.equal((await fetch(`${backend.url}/api/ping`)).status, 404);
		assert.equal((await fetch(`${backend.url}/v/bounded/missing`)).status, 404);
		assert.equal((await fetch(`${backend.url}/v/bounded/%252e%252e/package.json`)).status, 404);
		assert.equal((await fetch(`${backend.url}/assets/%252e%252e/backend.mjs`)).status, 404);
	} finally {
		await Promise.all([backend.close(), backend.close()]);
		assert.equal(closes, 1);
		await rm(root, { recursive: true, force: true });
	}
});

test("backend rejects non-loopback binding", async () => {
	await assert.rejects(createVisualCompanionBackend({ host: "0.0.0.0" }), /loopback/);
});
