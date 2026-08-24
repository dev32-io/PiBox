import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createVisualCompanionBackend } from "../backend.mjs";
import { createMockupViewer } from "../mockup/index.js";

test("mockup canvas allows scripts without granting same-origin parent access", async () => {
	const html = await readFile(resolve("extensions/visual-companion/mockup/assets/index.html"), "utf8");
	assert.match(html, /sandbox="[^"]*allow-scripts/);
	assert.doesNotMatch(html, /sandbox="[^"]*allow-same-origin/);
});

async function waitForEvent(reader: ReadableStreamDefaultReader<Uint8Array>, event: string, timeoutMs = 3_000): Promise<void> {
	const decoder = new TextDecoder();
	let content = "";
	const deadline = Date.now() + timeoutMs;
	while (!content.includes(`event: ${event}`)) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error(`Timed out waiting for ${event}`);
		const result = await Promise.race([
			reader.read(),
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), remaining)),
		]);
		if (result.done) throw new Error(`Event stream ended before ${event}`);
		content += decoder.decode(result.value, { stream: true });
	}
}

test("mockup viewer serves one bounded browser-renderable prototype directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "visual-mockup-"));
	const prototype = join(root, "prototype");
	await mkdir(join(prototype, "assets"), { recursive: true });
	await writeFile(join(prototype, "index.html"), '<link rel="stylesheet" href="assets/app.css"><h1>Mockup</h1>');
	await writeFile(join(prototype, "assets", "app.css"), "h1 { color: red; }");
	await writeFile(join(root, "secret.txt"), "not served");
	const backend = await createVisualCompanionBackend({ viewers: [createMockupViewer()] });
	try {
		const shown = backend.show({ viewerId: "mockup", artifactPath: prototype });
		assert.equal(shown.valid, true);
		assert.match(await fetch(shown.viewerUrl).then((response) => response.text()), /Interactive visual mockup/);
		const content = await fetch(`${shown.viewerUrl}content/`);
		assert.equal(content.headers.get("access-control-allow-origin"), "null", "opaque sandbox origin may load local modules");
		assert.match(await content.text(), /<h1>Mockup<\/h1>/);
		assert.match(await fetch(`${shown.viewerUrl}content/assets/app.css`).then((response) => response.text()), /color: red/);
		assert.equal((await fetch(`${shown.viewerUrl}content/../secret.txt`)).status, 404);

		await symlink(join(root, "secret.txt"), join(prototype, "leak.txt"));
		await symlink(root, join(prototype, "outside"));
		assert.equal((await fetch(`${shown.viewerUrl}content/leak.txt`)).status, 404);
		assert.equal((await fetch(`${shown.viewerUrl}content/outside/secret.txt`)).status, 404);
	} finally {
		await backend.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("single-file mockups reload when a sibling asset changes", async () => {
	const root = await mkdtemp(join(tmpdir(), "visual-mockup-file-"));
	const entry = join(root, "concept.html");
	const styles = join(root, "concept.css");
	await writeFile(entry, '<link rel="stylesheet" href="concept.css"><h1>Concept</h1>');
	await writeFile(styles, "h1 { color: red; }");
	const backend = await createVisualCompanionBackend({ viewers: [createMockupViewer()] });
	const controller = new AbortController();
	try {
		const shown = backend.show({ viewerId: "mockup", artifactPath: entry });
		assert.equal(shown.valid, true);
		assert.match(await fetch(`${shown.viewerUrl}content/`).then((response) => response.text()), /Concept/);
		const events = await fetch(`${shown.viewerUrl}events`, { signal: controller.signal });
		const reader = events.body!.getReader();
		await waitForEvent(reader, "ready");
		await writeFile(styles, "h1 { color: blue; }");
		await waitForEvent(reader, "changed");
	} finally {
		controller.abort();
		await backend.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("mockup viewer rejects regular non-HTML files", async () => {
	const root = await mkdtemp(join(tmpdir(), "visual-mockup-invalid-"));
	const entry = join(root, "notes.txt");
	await writeFile(entry, "not html");
	const backend = await createVisualCompanionBackend({ viewers: [createMockupViewer()] });
	try {
		const shown = backend.show({ viewerId: "mockup", artifactPath: entry });
		assert.equal(shown.valid, false);
		assert.match(shown.errors?.join(" ") ?? "", /HTML file/);
	} finally {
		await backend.close();
		await rm(root, { recursive: true, force: true });
	}
});
