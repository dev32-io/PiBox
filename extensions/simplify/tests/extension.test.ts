import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatSkillsForPrompt, loadSkillsFromDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import simplifyExtension from "../index.js";

test("simplify registers only an explicit command and queues its bundled skill with optional focus", async () => {
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const sent: Array<{ content: unknown; options: unknown }> = [];
	// No event/tool APIs: registration must not install automatic prompt triggers.
	simplifyExtension({
		registerCommand: (name, command) => { commands.set(name, command); },
		sendUserMessage: (content, options) => { sent.push({ content, options }); },
	} as ExtensionAPI);
	assert.deepEqual([...commands.keys()], ["simplify"]);
	assert.equal(sent.length, 0);
	for (const args of ["", "  focus on memory efficiency  "]) {
		await commands.get("simplify")!.handler(args, {} as any);
		const message = sent.at(-1)!;
		assert.match(String(message.content), /# Simplify/);
		assert.match(String(message.content), /Three parallel reviews/);
		assert.ok(String(message.content).endsWith(`/simplify${args.trim() ? ` ${args.trim()}` : ""}`));
		assert.doesNotMatch(String(message.content), /disable-model-invocation:/);
		assert.deepEqual(message.options, { deliverAs: "followUp" });
	}
});

test("simplify is packaged but excluded from automatic discovery and model invocation", () => {
	const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
	assert.ok(manifest.pi.extensions.includes("./extensions/simplify/index.ts"));
	assert.ok(manifest.files.includes("skills"));
	assert.ok(manifest.pi.skills.includes("!./skills/simplify/SKILL.md"));
	const { skills, diagnostics } = loadSkillsFromDir({
		dir: fileURLToPath(new URL("../../../skills/simplify", import.meta.url)), source: "test",
	});
	assert.deepEqual(diagnostics, []);
	assert.equal(skills.length, 1);
	assert.equal(skills[0]!.disableModelInvocation, true);
	assert.equal(formatSkillsForPrompt(skills), "");
});
