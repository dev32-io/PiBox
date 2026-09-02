import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatSkillsForPrompt, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resetActiveProfile, setActiveProfile } from "../../profile/registry.js";
import designerExtension, { loadClosestDesignAuthority } from "../index.js";

test("published package separates the designer prompt, profile-only handoff skill, and visual diff example", async () => {
	const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { files?: string[]; pi?: { extensions?: string[]; skills?: string[] } };
	assert.ok(packageJson.files?.includes("prompt"));
	assert.ok(packageJson.files?.includes("skills"));
	assert.ok(packageJson.files?.includes("examples"));
	assert.ok(packageJson.pi?.skills?.includes("!./skills/designer-handoff/SKILL.md"), "normal package discovery excludes the profile-only skill");
	const prompt = await readFile("prompt/designer.md", "utf8");
	assert.match(prompt, /# Visual Designer/);
	assert.match(prompt, /read and follow the `designer-handoff` skill/);
	assert.doesNotMatch(prompt, /handoff\/static/);
	assert.doesNotMatch(prompt, /A button reference contains one button only/);

	const handoff = await readFile("skills/designer-handoff/SKILL.md", "utf8");
	assert.match(handoff, /name: designer-handoff/);
	assert.match(handoff, /handoff\/static/);
	assert.match(handoff, /handoff\/recordings/);
	assert.match(handoff, /Prefer scripted batch capture/);
	assert.match(handoff, /headless Chrome through CDP/);
	assert.match(handoff, /Prefer one scripted batch over repeated agent-driven browser calls/);
	assert.match(handoff, /Use browser MCP only for a reference or state that cannot reasonably be generated or captured/);
	assert.match(handoff, /exactly one independently implementable component instance in exactly one state/);
	assert.match(handoff, /A button reference contains one button only/);
	assert.match(handoff, /showcase section, specimen row, comparison group, variant grid, collection, or page is not a component reference/);
	assert.match(handoff, /Showcase grouping must never become the handoff capture boundary/);
	assert.match(handoff, /If any image contains multiple component instances or multiple states, split and recapture it/);
	assert.match(handoff, /exact path and one-line meaning for every static reference and motion sequence/);
	assert.match(handoff, /When in doubt, inspect the referenced image/);
	assert.doesNotMatch(handoff, /\*\*Decisions\*\*/);
	const examplePackage = JSON.parse(await readFile("examples/visual-diff/package.json", "utf8")) as { dependencies?: Record<string, string> };
	assert.equal(examplePackage.dependencies?.["odiff-bin"], "4.5.0");
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
		assert.equal(await handlers.get("resources_discover")?.({}, ctx), undefined, "default profile does not load the handoff skill");
		assert.equal(await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx), undefined);

		setActiveProfile("designer");
		await handlers.get("session_start")?.({}, ctx);
		const resources = await handlers.get("resources_discover")?.({}, ctx) as { skillPaths?: string[] };
		assert.equal(resources.skillPaths?.length, 1);
		assert.match(resources.skillPaths?.[0] ?? "", /skills\/designer-handoff\/SKILL\.md$/);

		const skills = [
			{ name: "product-discussion", description: "Product exploration", filePath: "/skills/product-discussion/SKILL.md" },
			{ name: "shape-story", description: "Story shaping", filePath: "/skills/shape-story/SKILL.md" },
			{ name: "plan-delivery", description: "Delivery planning", filePath: "/skills/plan-delivery/SKILL.md" },
			{ name: "workflow-run", description: "Workflow execution", filePath: "/skills/workflow-run/SKILL.md" },
			{ name: "architecture-visualizer", description: "Architecture diagrams", filePath: "/skills/architecture-visualizer/SKILL.md" },
			{ name: "designer-handoff", description: "Deliver an approved visual mockup as implementation references", filePath: resources.skillPaths?.[0] },
		] as any[];
		const base = `base${formatSkillsForPrompt(skills)}`;
		const event = { systemPrompt: base, systemPromptOptions: { skills } } as any;
		const result = await handlers.get("before_agent_start")?.(event, ctx) as { systemPrompt: string };
		assert.deepEqual(activeTools, ["read", "subagent_spawn"], "designer keeps subagent_spawn active");
		assert.match(result.systemPrompt, /^base/);
		assert.doesNotMatch(result.systemPrompt, /<name>(product-discussion|shape-story|plan-delivery|workflow-run)<\/name>/);
		assert.match(result.systemPrompt, /<name>architecture-visualizer<\/name>/, "non-product skills remain visible");
		assert.match(result.systemPrompt, /<name>designer-handoff<\/name>/, "profile-only handoff skill is available on demand");
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
