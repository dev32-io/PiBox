import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
// @ts-expect-error Browser assets intentionally have no TypeScript declaration surface.
import { renderMarkdown } from "../scratch/assets/markdown.js";

const assets = resolve("extensions/visual-companion/scratch/assets");

test("Scratch viewer is read-only, refreshable, and activity-aware", async () => {
	const [html, app, css] = await Promise.all([
		readFile(resolve(assets, "index.html"), "utf8"),
		readFile(resolve(assets, "app.js"), "utf8"),
		readFile(resolve(assets, "styles.css"), "utf8"),
	]);
	assert.match(html, /Private, temporary working context/);
	assert.match(html, /not an authoritative plan or record/);
	assert.match(html, /id="tab-plan"[^>]*role="tab"[^>]*aria-controls="panel-plan"/);
	assert.match(html, /id="tab-ledger"[^>]*role="tab"[^>]*aria-controls="panel-ledger"/);
	assert.match(html, /id="refresh"[^>]*>Refresh</);
	assert.doesNotMatch(html, /textarea|contenteditable|type="file"/i);
	assert.match(app, /fetch\("\/v\/scratch\/api\/notes", \{ cache: "no-store"/);
	assert.match(app, /event\.origin !== location\.origin \|\| event\.source !== parent/);
	assert.match(app, /event\.data\.active === true/);
	assert.match(app, /scrollPositions/);
	assert.match(app, /response\.status === 404[\s\S]*clearNotes/);
	assert.doesNotMatch(app, /setInterval|localStorage|sessionStorage/);
	assert.match(css, /\.markdown \{\s+grid-row: 2;\s+min-height: 0;\s+box-sizing: border-box;/, "notes stay in the bounded scrolling row when the notice is hidden");
	assert.match(css, /@media \(max-width: 600px\)/);
	assert.match(css, /@media \(forced-colors: active\)/);
	assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("Scratch Markdown is readable without allowing embedded or local resources", () => {
	const rendered = renderMarkdown(`# Heading

- [x] complete
- [ ] pending

[Web](https://example.com) [Mail](mailto:user@example.com) [Local](../evidence/private.txt) [Unsafe](javascript:alert(1))
![remote](https://example.com/tracker.png)

\`inline\`

\`\`\`js
<script>alert("no")</script>
\`\`\``);
	assert.match(rendered, /<h1>Heading<\/h1>/);
	assert.match(rendered, /type="checkbox" disabled checked/);
	assert.match(rendered, /href="https:\/\/example\.com" target="_blank" rel="noreferrer"/);
	assert.match(rendered, /href="mailto:user@example\.com"/);
	assert.doesNotMatch(rendered, /href="\.\.\/evidence/);
	assert.doesNotMatch(rendered, /href="javascript:/);
	assert.doesNotMatch(rendered, /<img|src=/);
	assert.match(rendered, /Image: remote/);
	assert.match(rendered, /<pre><code>&lt;script&gt;alert\(&quot;no&quot;\)&lt;\/script&gt;<\/code><\/pre>/);
	assert.doesNotMatch(rendered, /<script>/);
});
