import { renderedDOM } from "./markdown-dom.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
// @ts-expect-error Browser assets intentionally have no TypeScript declaration surface.
import { renderMarkdown } from "../scratch/assets/markdown.js";

const assets = resolve("extensions/visual-companion/scratch/assets");

test("Scratch explorer uses local components and shared safe Markdown under read-only CSP", async () => {
	const [html, app, css] = await Promise.all([
		readFile(resolve(assets, "index.html"), "utf8"),
		readFile(resolve(assets, "app.js"), "utf8"),
		readFile(resolve(assets, "styles.css"), "utf8"),
	]);
	assert.match(html, /<wa-tree[^>]*selection="leaf"/);
	assert.match(html, /<wa-tab-group/);
	assert.match(html, /<wa-split-panel/);
	assert.match(html, /id="files-toggle"[^>]*aria-controls="scratch-sidebar"[^>]*aria-expanded="true"/);
	assert.match(html, /id="refresh"/);
	assert.doesNotMatch(html, /class="topbar"|id="session-id"|id="collapse"|id="show-sidebar"/);
	assert.match(html, /\/assets\/vendor\/marked\.js/);
	assert.match(html, /\/assets\/vendor\/dompurify\.js/);
	assert.match(app, /import '\.\/webawesome\.min\.js'/);
	assert.match(app, /fetch\(url, \{ cache: 'no-store', signal \}\)/);
	assert.match(app, /event\.origin !== location\.origin \|\| event\.source !== parent/);
	assert.doesNotMatch(html, /textarea|contenteditable|type="file"|PROTOTYPE|fixture/i);
	assert.doesNotMatch(app, /localStorage|sessionStorage|api\/notes/);
	assert.match(css, /\.sidebar \{ height:100%/);
	assert.match(css, /@media\(max-width:600px\)/);
	assert.match(css, /@media \(forced-colors: active\)/);
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
 const dom = renderedDOM(rendered);
 assert.equal(dom.querySelectorAll('input[type="checkbox"][disabled]').length, 2);
 assert.equal(dom.querySelectorAll('input[checked]').length, 1);
 assert.equal(dom.querySelector('a[href="https://example.com"]')?.getAttribute("rel"), "noopener noreferrer");
 assert.ok(dom.querySelector('a[href="mailto:user@example.com"]'));
 assert.equal(dom.querySelectorAll('img,script,a[href^=".."],a[href^="javascript:"]').length, 0);
 assert.match(dom.textContent || "", /Image: remote/);
 assert.equal(dom.querySelector("pre code")?.textContent, '<script>alert("no")</script>\n');
});
