import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatSkillsForPrompt, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resetActiveProfile, setActiveProfile } from "../../profile/registry.js";
import designerExtension, { loadClosestDesignAuthority } from "../index.js";

test("published package includes the editable designer prompt after workflow routing", async () => {
	const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { files?: string[]; pi?: { extensions?: string[] } };
	assert.ok(packageJson.files?.includes("prompt"));
	const prompt = await readFile("prompt/designer.md", "utf8");
	assert.match(prompt, /# Visual Designer/);
	assert.doesNotMatch(prompt, /design-handoff skill/i);
	for (const section of ["Outcome", "Source", "Behavior", "Decisions", "Open"]) assert.match(prompt, new RegExp(`\\*\\*${section}\\*\\*`));
	assert.match(prompt, /Do not repeat values visible in the prototype or CSS/);
	const extensions = packageJson.pi?.extensions ?? [];
	assert.ok(extensions.indexOf("./extensions/designer/index.ts") > extensions.indexOf("./extensions/workflow/index.ts"));
});

test("closest DESIGN.md is snapshotted within the repository boundary", async () => {
	const root = await mkdtemp(join(tmpdir(), "pibox-designer-"));
	const nested = join(root, "packages", "app", "src");
	await mkdir(join(root, ".git"));
	await mkdir(nested, { recursive: true });
	await writeFile(join(root, "DESIGN.md"), "root authority");
	await writeFile(join(root, "packages", "app", "DESIGN.md"), "closest authority");
	try {
		const result = loadClosestDesignAuthority(nested);
		assert.equal(result?.content, "closest authority");
		assert.equal(result?.path, join(root, "packages", "app", "DESIGN.md"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("designer prompt and DESIGN.md apply only to --profile designer", async () => {
	const root = await mkdtemp(join(tmpdir(), "pibox-designer-extension-"));
	await mkdir(join(root, ".git"));
	await writeFile(join(root, "DESIGN.md"), "Use the repository palette.");
	let activeTools = ["read"];
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const pi = {
		getAllTools() { return [{ name: "read" }, { name: "subagent_spawn" }]; },
		getActiveTools() { return activeTools; },
		setActiveTools(tools: string[]) { activeTools = tools; },
		on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); },
	} as unknown as ExtensionAPI;
	designerExtension(pi);
	const ctx = { cwd: root, hasUI: false } as any;
	try {
		setActiveProfile("default");
		await handlers.get("session_start")?.({}, ctx);
		assert.equal(await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx), undefined);

		setActiveProfile("designer");
		await handlers.get("session_start")?.({}, ctx);

		const skills = [
			{ name: "product-discussion", description: "Product exploration", filePath: "/skills/product-discussion/SKILL.md" },
			{ name: "shape-story", description: "Story shaping", filePath: "/skills/shape-story/SKILL.md" },
			{ name: "plan-delivery", description: "Delivery planning", filePath: "/skills/plan-delivery/SKILL.md" },
			{ name: "workflow-run", description: "Workflow execution", filePath: "/skills/workflow-run/SKILL.md" },
			{ name: "architecture-visualizer", description: "Architecture diagrams", filePath: "/skills/architecture-visualizer/SKILL.md" },
		] as any[];
		const base = `base${formatSkillsForPrompt(skills)}`;
		const event = { systemPrompt: base, systemPromptOptions: { skills } } as any;
		const result = await handlers.get("before_agent_start")?.(event, ctx) as { systemPrompt: string };
		assert.deepEqual(activeTools, ["read", "subagent_spawn"], "designer keeps subagent_spawn active");
		assert.match(result.systemPrompt, /^base/);
		assert.doesNotMatch(result.systemPrompt, /<name>(product-discussion|shape-story|plan-delivery|workflow-run)<\/name>/);
		assert.match(result.systemPrompt, /<name>architecture-visualizer<\/name>/, "non-product skills remain visible");
		assert.match(result.systemPrompt, /# Visual Designer/);
		assert.match(result.systemPrompt, /# Repository Design Authority/);
		assert.match(result.systemPrompt, /Use the repository palette\./);

		await writeFile(join(root, "DESIGN.md"), "Changed after startup.");
		const later = await handlers.get("before_agent_start")?.(event, ctx) as { systemPrompt: string };
		assert.match(later.systemPrompt, /Use the repository palette\./, "authority is a session-start snapshot");
		assert.doesNotMatch(later.systemPrompt, /Changed after startup/);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		resetActiveProfile();
		await rm(root, { recursive: true, force: true });
	}
});
