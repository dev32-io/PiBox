import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExtensionRunner, formatSkillsForPrompt, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installWorkModeRuntime } from "../../work-mode/runtime.js";
import type { PiBoxWorkMode } from "../../work-mode/policy.js";
import designerExtension, { loadClosestDesignAuthority } from "../index.js";

test("published package separates the designer prompt, mode-only handoff skill, and visual diff example", async () => {
	const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { files?: string[]; pi?: { extensions?: string[]; skills?: string[] } };
	assert.ok(packageJson.files?.includes("prompt"));
	assert.ok(packageJson.files?.includes("skills"));
	assert.ok(packageJson.files?.includes("examples"));
	assert.ok(packageJson.pi?.skills?.includes("!./skills/designer-handoff/SKILL.md"), "normal package discovery excludes the mode-only skill");
	const prompt = await readFile("prompt/designer.md", "utf8");
	assert.match(prompt, /# Visual Designer/);
	assert.match(prompt, /read and follow the `designer-handoff` skill/);
	assert.doesNotMatch(prompt, /handoff\/static/);
	assert.doesNotMatch(prompt, /A button reference contains one button only/);
	assert.match(prompt, /proposed solution as a starting hypothesis/);
	assert.match(prompt, /`general-purpose` for web references/);
	assert.match(prompt, /independently combinable design dimensions/);
	assert.match(prompt, /docs\/mockup-tweaks\.md/);
	assert.match(prompt, /JSON describes controls only/);
	assert.match(prompt, /reload the prototype with selections restored/);

	const handoff = await readFile("skills/designer-handoff/SKILL.md", "utf8");
	assert.match(handoff, /name: designer-handoff/);
	assert.match(handoff, /handoff\/static/);
	assert.match(handoff, /handoff\/recordings/);
	assert.match(handoff, /one repeatable script/);
	assert.match(handoff, /headless Chrome through CDP/);
	assert.match(handoff, /browser MCP only for a state that cannot reasonably be scripted/);
	assert.match(handoff, /exactly one independently implementable component instance in one state/);
	assert.match(handoff, /showcase section, specimen row, comparison group, variant grid, collection, or page is not a component reference/);
	assert.match(handoff, /split and recapture/);
	assert.match(handoff, /exact path and one-line meaning for every static reference and motion sequence/);
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

test("designer authority composes lazily only while Designer mode is active", async () => {
	const root = await mkdtemp(join(tmpdir(), "pibox-designer-extension-"));
	await mkdir(join(root, ".git"));
	await writeFile(join(root, "DESIGN.md"), "Use the repository palette.");
	let mode: PiBoxWorkMode = "agent";
	const uninstallMode = installWorkModeRuntime({ snapshot: () => ({ sessionId: "session", mode, workflowToolsExposed: false, generation: 1 }) });
	let activeTools = ["read", "subagent_spawn"];
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const pi = {
		getAllTools() { return [{ name: "read" }, { name: "subagent_spawn" }]; },
		getActiveTools() { return activeTools; },
		setActiveTools(tools: string[]) { activeTools = tools; },
		on(name: string, handler: (...args: any[]) => unknown) {
			const previous = handlers.get(name);
			handlers.set(name, async (...args) => { await previous?.(...args); return handler(...args); });
		},
	} as unknown as ExtensionAPI;
	const priorRole = process.env.PIBOX_RUNTIME_ROLE;
	delete process.env.PIBOX_RUNTIME_ROLE;
	try { designerExtension(pi); } finally {
		if (priorRole === undefined) delete process.env.PIBOX_RUNTIME_ROLE;
		else process.env.PIBOX_RUNTIME_ROLE = priorRole;
	}
	const notices: string[] = [];
	const ctx = { sessionManager: { getSessionId: () => "designer-test" }, model: { api: "openai-completions" }, cwd: root, hasUI: false, ui: { notify(message: string) { notices.push(message); } } } as any;
	const payload = async () => {
		const context = await handlers.get("context")?.({ messages: [{ role: "user", content: "task" }] }, ctx) as any;
		return ExtensionRunner.prototype.emitBeforeProviderRequest.call({
			extensions: [{ path: "designer", handlers: new Map([...handlers].map(([name, handler]) => [name, [handler]])) }],
			createContext: () => ctx, emitError() {},
		} as any, { messages: [
			{ role: "system", content: "BASE" },
			...context.messages.map((message: any) => ({ role: "user", content: message.content })),
		] }) as any;
	};
	try {
		await handlers.get("session_start")?.({}, ctx);
		const resources = await handlers.get("resources_discover")?.({}, ctx) as { skillPaths?: string[] };
		assert.equal(resources.skillPaths?.length, 1, "the load-once resource is always discoverable");
		assert.match(resources.skillPaths?.[0] ?? "", /skills\/designer-handoff\/SKILL\.md$/);
		const skills = [
			{ name: "product-discussion", description: "Product exploration", filePath: "/skills/product-discussion/SKILL.md" },
			{ name: "shape-story", description: "Story shaping", filePath: "/skills/shape-story/SKILL.md" },
			{ name: "plan-delivery", description: "Delivery planning", filePath: "/skills/plan-delivery/SKILL.md" },
			{ name: "workflow-run", description: "Workflow execution", filePath: "/skills/workflow-run/SKILL.md" },
			{ name: "architecture-visualizer", description: "Architecture diagrams", filePath: "/skills/architecture-visualizer/SKILL.md" },
			{ name: "designer-handoff", description: "Designer handoff", filePath: resources.skillPaths?.[0] },
		] as any[];
		const base = `base${formatSkillsForPrompt(skills)}`;
		const event = { systemPrompt: base, systemPromptOptions: { skills } } as any;

		const ordinary = await handlers.get("before_agent_start")?.(event, ctx) as { systemPrompt: string };
		assert.doesNotMatch(ordinary.systemPrompt, /<name>designer-handoff<\/name>|# Visual Designer|Repository Design Authority/);
		assert.match(ordinary.systemPrompt, /<name>product-discussion<\/name>/);
		assert.deepEqual(await handlers.get("input")?.({ text: "/skill:designer-handoff", source: "interactive" }, ctx), { action: "handled" });
		assert.match(notices.at(-1) ?? "", /only in PiBox Designer mode/);

		mode = "designer";
		assert.equal(await handlers.get("input")?.({ text: "/skill:designer-handoff", source: "interactive" }, ctx), undefined);
		const result = await handlers.get("before_agent_start")?.(event, ctx) as { systemPrompt: string };
		assert.deepEqual(activeTools, ["read", "subagent_spawn"]);
		assert.doesNotMatch(result.systemPrompt, /<name>(product-discussion|shape-story|plan-delivery|workflow-run)<\/name>/);
		assert.match(result.systemPrompt, /<name>architecture-visualizer<\/name>/);
		assert.match(result.systemPrompt, /<name>designer-handoff<\/name>/);
		assert.match((await payload()).messages[0].content, /# Visual Designer[\s\S]+# Repository Design Authority[\s\S]+Use the repository palette\./);
		activeTools = ["read"];
		// Actual host dispatch catches hook errors and continues: test the provider boundary, not a direct throw.
		const errors: unknown[] = [];
		const runner = {
			extensions: [{ path: "designer", handlers: new Map([...handlers].map(([name, handler]) => [name, [handler]])) }],
			createContext: () => ctx, assertActive() {}, emitError(error: unknown) { errors.push(error); },
		};
		await ExtensionRunner.prototype.emitBeforeAgentStart.call(runner as any, "task", undefined, { customPrompt: "BASE", cwd: root });
		const failed = await payload();
		assert.match(failed.__pibox_system_prompt_error, /active subagent_spawn tool/);
		assert.equal(failed.messages, undefined, "no unauthorized conversation survives failure");
		assert.deepEqual(errors, []);
		activeTools = ["read", "subagent_spawn"];

		await writeFile(join(root, "DESIGN.md"), "Changed after first designer turn.");
		const later = (await payload()).messages[0].content;
		assert.match(later, /Use the repository palette\./, "authority is snapshotted lazily once");
		assert.doesNotMatch(later, /Changed after first designer turn/);

		mode = "agent";
		const returned = await handlers.get("before_agent_start")?.(event, ctx) as { systemPrompt: string };
		assert.doesNotMatch(returned.systemPrompt, /# Visual Designer|Repository Design Authority|<name>designer-handoff<\/name>/);
		assert.doesNotMatch((await payload()).messages[0].content, /# Visual Designer|Repository Design Authority/);

		// A failed DESIGN.md read must not cache a partial snapshot, even on retry.
		mode = "designer";
		ctx.cwd = join(root, "broken");
		await mkdir(join(ctx.cwd, "DESIGN.md"), { recursive: true });
		for (let attempt = 0; attempt < 2; attempt++) {
			assert.match((await payload()).__pibox_system_prompt_error, /EISDIR/);
		}
		await rm(join(ctx.cwd, "DESIGN.md"), { recursive: true });
		await writeFile(join(ctx.cwd, "DESIGN.md"), "Recovered authority");
		assert.match((await payload()).messages[0].content, /Recovered authority/);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		uninstallMode();
		await rm(root, { recursive: true, force: true });
	}
});

test("child sessions register no Designer controls or authority", () => {
	const previous = process.env.PIBOX_RUNTIME_ROLE;
	process.env.PIBOX_RUNTIME_ROLE = "subagent";
	try {
		designerExtension({ on() { assert.fail("child must not register Designer hooks"); } } as unknown as ExtensionAPI);
	} finally {
		if (previous === undefined) delete process.env.PIBOX_RUNTIME_ROLE;
		else process.env.PIBOX_RUNTIME_ROLE = previous;
	}
});
