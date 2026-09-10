import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { renderedDOM } from "./markdown-dom.js";
// @ts-expect-error Browser module.
import { renderMarkdown } from "../assets/markdown.js";
import { createVisualCompanionBackend } from "../backend.mjs";
import { sanitizeMarkdown } from "../story-board/markdown-policy.js";

const parse = (source: string, story = false) => renderedDOM(renderMarkdown(source, { story }));
test("shared GFM renders semantic blocks, alignment and read-only tasks", () => {
	const dom = parse('# Heading\n\n| Left | Center | Right |\n| :--- | :---: | ---: |\n| **bold** | *em* | ~~gone~~ |\n\n3. parent\n   - nested\n     - [x] done\n\n> quote\n>\n> second\n\n---\n\n```html\n<img src="local" onerror="alert(1)">\n```\n\n`<b>` https://example.test');
	for (const selector of ['h1', 'table thead th.align-left', 'th.align-center', 'th.align-right', 'tbody td strong', 'em', 'del', 'ol[start="3"] > li > ul', 'input[disabled][checked]', 'blockquote p', 'hr', 'pre code', 'a[href="https://example.test"]', '.markdown-table[tabindex="0"]']) assert.ok(dom.querySelector(selector), selector);
	assert.equal(dom.querySelector('pre code')?.textContent, '<img src="local" onerror="alert(1)">\n');
	assert.equal(dom.querySelectorAll('img').length, 0);
});

test("URL and HTML policy rejects active content and arbitrary local requests", () => {
	const source = ['<img src="/api/private" onerror="alert(1)">', '<svg onload="alert(1)"></svg>', '[script](javascript:alert%281%29)', '[entity](jav&#x61;script:alert)', '[relative](../private)', '[absolute](/api/private)', '[protocol](//tracker.test/x)', '[file](file:///etc/passwd)', '![data](data:image/png;base64,xxx)', '![remote](https://tracker.test/pixel)', '[ok](https://example.test)', '[mail](mailto:user@example.test)'].join('\n\n');
	for (const story of [false, true]) {
		const dom = parse(source, story);
		assert.equal(dom.querySelectorAll('img,svg,script,[onerror],[onload]').length, 0);
		for (const link of dom.querySelectorAll('a[href]')) assert.match(link.getAttribute('href')!, /^(https:\/\/|mailto:)/);
	}
	assert.throws(() => renderMarkdown('unsafe', { purifier: undefined, marked: {} }), /unavailable/);
	assert.throws(() => renderMarkdown('unsafe', { purifier: { isSupported: false, sanitize: () => 'unsafe' } }), /unavailable/);
});

test("server resolves full, collapsed and shortcut evidence references, retaining code", () => {
	const context = { storyId: 'story', evaluationId: 'review', evidence: [{ id: 'ev', path: 'agent-artifacts/story/evidence/review/shot.png', manifestMember: true, available: true, supported: true, mediaType: 'image/png', diagnostics: [] }] };
	const source = '![full][shot]\n\n![shot][]\n\n![shot]\n\n[link][shot]\n\n![external][remote]\n\n[bad][unsafe]\n\n[shot]: ../../evidence/review/shot.png\n[remote]: https://tracker.test/pixel\n[unsafe]: javascript:alert\n\n```html\n<script>example</script>\n![shot][shot]\n```\n\n`<b>example</b>`';
	const safe = sanitizeMarkdown(source, context);
	const dom = parse(safe, true);
	assert.equal(dom.querySelectorAll('img[src^="/v/story-board/api/evidence?"]').length, 3);
	assert.equal(dom.querySelectorAll('a[href^="/v/story-board/api/evidence?"]').length, 1);
	assert.equal(dom.querySelectorAll('img[src^="https"],a[href^="javascript"]').length, 0);
	assert.equal(dom.querySelector('pre code')?.textContent, '<script>example</script>\n![shot][shot]\n');
	assert.match(dom.textContent!, /<b>example<\/b>/);
	assert.equal(parse(sanitizeMarkdown(source), true).querySelectorAll('img').length, 0);
	// An authored route is not itself evidence authorization.
	assert.equal(parse(sanitizeMarkdown('![forged](/v/story-board/api/evidence?story=story&evaluation=review&path=shot.png)', context), true).querySelectorAll('img').length, 0);
});

test("browser dependencies and shared modules are bounded local routes", async () => {
	const backend = await createVisualCompanionBackend();
	try {
		for (const path of ['/assets/vendor/marked.js', '/assets/vendor/dompurify.js', '/assets/markdown.js', '/v/assets/markdown.js', '/assets/markdown.css']) {
			const response = await fetch(backend.url + path);
			assert.equal(response.status, 200, path);
			assert.match(response.headers.get('content-type')!, path.endsWith('.css') ? /text\/css/ : /text\/javascript/);
			assert.ok((await response.text()).length > 100);
		}
		for (const path of ['/assets/vendor/package.json', '/assets/vendor/marked.js.map', '/assets/vendor/%2e%2e%2f%2e%2e%2fpackage.json', '/v/assets/backend.mjs', '/node_modules/marked/package.json']) assert.equal((await fetch(backend.url + path)).status, 404, path);
	} finally { await backend.close(); }
});

test("server policy round-trips GFM and cannot assemble HTML from rejected links", () => {
	const source = '# Head *em*\n\n| Name | Value |\n| :--- | ---: |\n| **bold** | ~~old~~ |\n\n2. first\n   - nested\n     - [ ] task\n\n> quote\n>\n> ```html\n> <img src="/local">\n> ```\n\n---\n\nA &amp; B and `<b>`\n\n<scr[ipt](javascript:bad)>text</scr[ipt](javascript:bad)>';
	const safe = sanitizeMarkdown(source);
	assert.doesNotMatch(safe, /<script>/);
	const dom = parse(safe, true);
	for (const selector of ['h1 em', 'table th.align-right', 'td strong', 'td del', 'ol[start="2"] > li > ul', 'input[disabled]', 'blockquote pre code', 'hr']) assert.ok(dom.querySelector(selector), selector);
	assert.equal(dom.querySelector('blockquote pre code')?.textContent, '<img src="/local">\n');
	assert.match(dom.textContent!, /A & B/);
	assert.equal(dom.querySelectorAll('script,img').length, 0);
});


test("both viewers load local dependencies and scoped styles; Story Board restricts resource origins", async () => {
	for (const viewer of ["scratch", "story-board"]) {
		const html = await readFile(new URL(`../${viewer}/assets/index.html`, import.meta.url), "utf8");
		assert.match(html, /href="\/assets\/markdown.css"/);
		assert.ok(html.indexOf('/assets/vendor/marked.js') < html.indexOf('type="module"'));
		assert.ok(html.indexOf('/assets/vendor/dompurify.js') < html.indexOf('type="module"'));
		if (viewer === "story-board") {
			assert.match(html, /default-src 'none'; script-src 'self'/);
			assert.match(html, /style-src 'self'; style-src-attr 'unsafe-inline'/);
			assert.match(html, /img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'/);
		}
	}
});

test("server policy preserves adjacent and nested emphasis delimiters", () => {
	for (const source of [
		"*a*_b_", "**a**__b__",
		"_a_*b*", "__a__**b**",
		"**outer *a*_b_ end**", "*outer **a**__b__ end*",
		"> *a*_b_\n\n- **a**__b__\n\n[**a**__b__](https://example.test)",
	]) {
		assert.equal(renderMarkdown(sanitizeMarkdown(source), { story: true }), renderMarkdown(source, { story: true }), source);
	}
});
