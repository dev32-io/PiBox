import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverRules, renderRules, rulesForRead, unconditionalRules } from "../rules.js";

function write(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pibox-rules-"));
	const repo = join(root, "repo");
	const home = join(root, "home");
	mkdirSync(join(repo, ".git"), { recursive: true });
	write(join(home, ".claude", "rules", "user.md"), "# User rule\n\nAlways preserve user work.\n");
	write(join(home, ".pi", "agent", "rules", "typescript.md"), "---\npaths: ['**/*.ts']\n---\n# User TypeScript\n\nUse strict types.\n");
	write(join(repo, ".claude", "rules", "gateway.md"), "---\npaths:\n  - 'gateway/**/*.ts'\n---\n# Gateway\n\nUse gateway conventions.\n");
	write(join(repo, ".pi", "rules", "project.md"), "# Project rule\n\nRun focused checks.\n");
	write(join(repo, ".pi", "rules", "invalid.md"), "---\npaths: 42\n---\nInvalid.\n");
	return { root, repo, home };
}

test("discovers user and project rules from Claude and Pi directories", () => {
	const { repo, home } = fixture();
	const discovery = discoverRules(join(repo, "gateway"), home);
	assert.equal(discovery.projectRoot, repo);
	assert.deepEqual(discovery.rules.map((rule) => `${rule.scope}:${rule.format}:${rule.label}`), [
		"user:claude:user",
		"user:pi:typescript",
		"project:claude:gateway",
		"project:pi:project",
	]);
	assert.equal(discovery.diagnostics.length, 1);
	assert.match(discovery.diagnostics[0]?.message ?? "", /paths frontmatter/i);
	assert.deepEqual(unconditionalRules(discovery).map((rule) => rule.label), ["user", "project"]);
});

test("activates scoped rules only after a matching file read and deduplicates them", () => {
	const { repo, home } = fixture();
	const discovery = discoverRules(repo, home);
	const matching = rulesForRead(discovery, "gateway/src/server.ts", repo);
	assert.deepEqual(matching.map((rule) => rule.label), ["typescript", "gateway"]);
	assert.deepEqual(rulesForRead(discovery, "README.md", repo).map((rule) => rule.label), []);
	assert.deepEqual(rulesForRead(discovery, "gateway/src/server.ts", repo, new Set([matching[0]!.id])).map((rule) => rule.label), ["gateway"]);
});

test("reading a scoped rule directly marks that rule as applicable", () => {
	const { repo, home } = fixture();
	const discovery = discoverRules(repo, home);
	const rule = discovery.rules.find((candidate) => candidate.label === "gateway");
	assert.ok(rule);
	assert.deepEqual(rulesForRead(discovery, rule.path, repo).map((candidate) => candidate.id), [rule.id]);
});

test("renders rule bodies without repeating YAML frontmatter", () => {
	const { repo, home } = fixture();
	const discovery = discoverRules(repo, home);
	const output = renderRules(rulesForRead(discovery, "gateway/src/server.ts", repo), "Rules loaded for gateway/src/server.ts");
	assert.match(output, /^## Rules loaded for gateway\/src\/server\.ts/);
	assert.match(output, /Use strict types/);
	assert.match(output, /Use gateway conventions/);
	assert.doesNotMatch(output, /paths:/);
});
