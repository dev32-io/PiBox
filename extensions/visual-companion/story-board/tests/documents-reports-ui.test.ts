import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evidencePresentation, renderMarkdown } from "../assets/app.js";

const assets = new URL("../assets/", import.meta.url);

test("safe Markdown never injects canonical HTML or auto-loads external images", () => {
	const rendered = renderMarkdown("<script>alert(1)</script>\n![remote](https://example.test/a.png)\n[site](https://example.test)");
	assert.doesNotMatch(rendered, /<script>|<img[^>]+example/);
	assert.match(rendered, /&lt;script&gt;/);
	assert.match(rendered, /target="_blank" rel="noreferrer"/);
});

test("evidence rendering distinguishes canonical images, text, missing, and unsupported items", () => {
	assert.equal(evidencePresentation({ available: true, supported: true, manifestMember: true, mediaType: "image/png" }), "image");
	assert.equal(evidencePresentation({ available: true, supported: true, manifestMember: true, mediaType: "text/plain" }), "text");
	assert.equal(evidencePresentation({ available: false }), "missing");
	assert.equal(evidencePresentation({ available: true, supported: false }), "unsupported");
});

test("documents, reports, task links, and responsive detail sheets use production accessible assets", async () => {
	const [app, styles] = await Promise.all([readFile(new URL("app.js", assets), "utf8"), readFile(new URL("styles.css", assets), "utf8")]);
	assert.match(app, /<details><summary>/);
	assert.match(app, /data-related-report/);
	assert.match(app, /data-go-task/);
	assert.match(app, /Accepted risk/);
	assert.match(styles, /\.detail-layer \{ position: fixed;[^}]*place-items: center/);
	assert.match(styles, /\.detail-sheet \{ width: 100%; max-height: calc\(100vh - 2 \* var\(--space-3\)\)/);
	assert.match(styles, /prefers-reduced-motion/);
});
