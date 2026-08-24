import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const assets = new URL("../assets/", import.meta.url);

test("catalog production assets expose contained state, diagnostics, retry, and refresh UI", async () => {
	const app = await readFile(new URL("app.js", assets), "utf8");
	for (const text of ["Loading stories…", "No stories found", "Unable to load", "Diagnostics", "Refresh", "Degraded"]) assert.match(app, new RegExp(text));
	assert.match(app, /errorRegion\(state\.error, "retry"\)/);
	assert.match(app, /story\.intentExcerpt/);
	assert.match(app, /planningRevision/);
});
