import assert from "node:assert/strict";
import test from "node:test";
import { safeMarkdownLink, sanitizeMarkdown } from "../index.js";

test("shared Markdown policy removes executable HTML and scriptable schemes", () => {
	const result = sanitizeMarkdown('<script>alert(1)</script> <b>text</b> [run](javascript:alert) [site](https://example.test)');
	assert.doesNotMatch(result, /<script|<b>|javascript:/i);
	assert.match(result, /text/); assert.match(result, /\[site\]\(https:\/\/example\.test\)/);
	assert.equal(safeMarkdownLink("data:text/html,bad"), undefined);
	assert.equal(safeMarkdownLink("java&#58;script:bad"), undefined);
});

test("external images become inert links while manifest-listed local images use the evidence route", () => {
	const external = sanitizeMarkdown("![tracker](https://tracker.test/pixel.png)");
	assert.equal(external, "[tracker](https://tracker.test/pixel.png)");
	const local = sanitizeMarkdown("![shot](../../evidence/review/files/shot.png)", {
		storyId: "story", evaluationId: "review", evidence: [{ id: "ev", path: "agent-artifacts/story/evidence/review/files/shot.png", mediaType: "image/png", manifestMember: true, available: true, supported: true, diagnostics: [] }],
	});
	assert.match(local, /^!\[shot\]\(\/v\/story-board\/api\/evidence\?/);
	assert.doesNotMatch(sanitizeMarkdown("![escape](../../evidence/review/../secret.png)", { storyId: "story", evaluationId: "review", evidence: [] }), /^!/);
});
