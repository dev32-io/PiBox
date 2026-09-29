import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { createVisualCompanionBackend } from "../backend.mjs";
import { createScratchViewer } from "../scratch/index.js";

const assets = resolve("extensions/visual-companion/scratch/assets");
const icons = [
	"arrow-down", "arrow-up", "chevron-down", "chevron-left", "chevron-right", "file-code", "file-cog", "file-image", "file-json", "file-text", "file-warning", "file", "folder-open", "folder", "grip-vertical", "lock", "panel-left-close", "panel-left-open", "panel-left", "pin", "refresh-cw", "search", "x",
];

test("Scratch vendor bundle matches pinned source and serves only selected same-origin icons", async () => {
	const result = await build({ entryPoints: ["scripts/scratch-webawesome-entry.js"], bundle: true, format: "esm", minify: true, target: "es2022", write: false });
	assert.deepEqual(Buffer.from(result.outputFiles[0]!.contents), await readFile(resolve(assets, "webawesome.min.js")));
	assert.deepEqual((await readdir(resolve(assets, "icons"))).sort(), icons.map((icon) => `${icon}.svg`).sort());
	const entry = await readFile("scripts/scratch-webawesome-entry.js", "utf8");
	assert.deepEqual([...entry.matchAll(/dist\/components\/([^/]+)\/\1\.js/g)].map((match) => match[1]), ["tree", "tree-item", "tab-group", "tab", "tab-panel", "split-panel"]);
	assert.match(entry, /new URL\(`\.\/icons\/\$\{name\}\.svg`, import\.meta\.url\)/);
	const systemIcons = [...entry.matchAll(/'([\w-]+)'/g)].map((match) => match[1]!).filter((name) => icons.includes(name));
	assert.deepEqual(systemIcons, ["chevron-left", "chevron-right", "chevron-down", "grip-vertical"]);
	assert.match(await readFile(resolve(assets, "app.js"), "utf8"), /^import ['"]\.\/webawesome\.min\.js['"];?/);
	const css = await readFile(resolve(assets, "styles.css"), "utf8");
	const cssIcons = [...css.matchAll(/\.\/icons\/([\w-]+\.svg)/g)].map((match) => match[1]);
	assert.deepEqual([...new Set([...cssIcons, ...systemIcons.map((name) => `${name}.svg`)])].sort(), icons.map((icon) => `${icon}.svg`).sort());
	const backend = await createVisualCompanionBackend({ viewers: [createScratchViewer(() => undefined)] });
	try {
		const base = `${backend.url}/v/scratch/`;
		const bundle = await fetch(base + "webawesome.min.js");
		assert.equal(bundle.status, 200);
		assert.match(bundle.headers.get("content-type") ?? "", /^text\/javascript/);
		assert.deepEqual(Buffer.from(await bundle.arrayBuffer()), Buffer.from(result.outputFiles[0]!.contents));
		assert.equal(bundle.headers.get("content-security-policy")?.includes("connect-src 'self'"), true);
		for (const name of icons) {
			const path = `icons/${name}.svg`;
			const response = await fetch(base + path);
			assert.equal(response.status, 200, path);
			assert.equal(response.headers.get("content-type"), "image/svg+xml", path);
			assert.equal(await response.text(), await readFile(resolve(assets, path), "utf8"), path);
		}
		for (const path of ["icons/nope.svg", "icons/%2e%2e%2findex.html", "icons/%252e%252e%252findex.html", "licenses/lucide-ISC.txt", "node_modules/@awesome.me/webawesome/package.json", "webawesome.min.js.map"]) {
			assert.equal((await fetch(base + path)).status, 404, path);
		}
	} finally { await backend.close(); }
});
