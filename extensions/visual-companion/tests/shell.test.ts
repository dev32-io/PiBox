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
	assert.match(html, /id="tab-mockup"[\s\S]*role="tab"[\s\S]*aria-controls="panel-mockup"/);
	assert.match(html, /role="tabpanel"/);
	assert.doesNotMatch(html, /<iframe[^>]+src=/, "viewer frames must not load before route selection");
	assert.match(app, /routeViewer/);
	assert.match(app, /ArrowRight/);
	assert.match(app, /Mount lazily: a direct viewer route never initializes the other viewers/);
	assert.match(app, /frame\.dataset\.mounted/, "switching tabs should retain mounted iframe state");
	assert.match(app, /const retainedRoutes = new Map/); assert.match(app, /rememberRoute\(activeViewer\)/); assert.match(app, /retainedRoutes\.get\(id\) \?\? route/, "switching viewers should restore each viewer's deep route");
	assert.match(app, /postMessage\(\{ type: ACTIVITY_MESSAGE, active \}, location\.origin\)/, "viewer activity messages must use the exact shell origin");
	assert.match(app, /notifyActivity\(viewerId, selected\)/, "tab changes must notify mounted viewers");
	assert.match(app, /notifyActivity\(id, id === activeViewer\)/, "iframe load must send its initial activity state");
});

test("home and deep viewer routes serve one shell while direct viewers remain selected", async () => {
	const root = await mkdtemp(join(tmpdir(), "visual-companion-shell-"));
	const architecture = await viewer(root, "architecture");
	const storyBoard = await viewer(root, "story-board");
	const mockup = await viewer(root, "mockup");
	const backend = await createVisualCompanionBackend({ viewers: [storyBoard, architecture, mockup] });
	try {
		const direct = backend.select("architecture");
		assert.equal(new URL(direct).searchParams.get("viewer"), "architecture");
		for (const path of ["/", "/story-board", "/story-board/example/board", "/architecture", "/architecture/overview", "/mockup"]) {
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
