import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createVisualCompanionBackend } from "../backend.mjs";

const assets = resolve("extensions/visual-companion/assets");

async function viewer(root: string, id: string) {
	const assetsDir = join(root, id);
	await mkdir(assetsDir, { recursive: true });
	await writeFile(join(assetsDir, "index.html"), `<title>${id}</title>`);
	return { id, assetsDir };
}

test("shell exposes accessible stable tabs and lazy viewer mount regions", async () => {
	const html = await readFile(join(assets, "index.html"), "utf8");
	const app = await readFile(join(assets, "app.js"), "utf8");
	assert.match(html, /role="tablist"/);
	assert.match(html, /id="tab-story-board"[\s\S]*role="tab"[\s\S]*aria-controls="panel-story-board"/);
	assert.match(html, /id="tab-architecture"[\s\S]*role="tab"[\s\S]*aria-controls="panel-architecture"/);
	assert.match(html, /role="tabpanel"/);
	assert.doesNotMatch(html, /<iframe[^>]+src=/, "viewer frames must not load before route selection");
	assert.match(app, /routeViewer/);
	assert.match(app, /ArrowRight/);
	assert.match(app, /Mount lazily: a direct Architecture route never initializes Story Board/);
	assert.match(app, /frame\.dataset\.mounted/, "switching tabs should retain mounted iframe state");
});

test("home and deep viewer routes serve one shell while direct Architecture remains selected", async () => {
	const root = await mkdtemp(join(tmpdir(), "visual-companion-shell-"));
	const architecture = await viewer(root, "architecture");
	const storyBoard = await viewer(root, "story-board");
	const backend = await createVisualCompanionBackend({ viewers: [storyBoard, architecture] });
	try {
		const direct = backend.select("architecture");
		assert.equal(new URL(direct).searchParams.get("viewer"), "architecture");
		for (const path of ["/", "/story-board", "/story-board/example/board", "/architecture", "/architecture/overview"]) {
			const response = await fetch(`${backend.url}${path}`);
			assert.equal(response.status, 200, path);
			assert.match(await response.text(), /Visual Companion viewers/);
		}
		assert.equal((await fetch(`${backend.url}/v/architecture/`)).status, 200);
	} finally {
		await backend.close();
		await rm(root, { recursive: true, force: true });
	}
});
