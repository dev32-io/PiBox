import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import designerExtension, { loadClosestDesignAuthority } from "../index.js";

test("published package includes the editable designer prompt", async () => {
	const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { files?: string[] };
	assert.ok(packageJson.files?.includes("prompt"));
	assert.match(await readFile("prompt/designer.md", "utf8"), /# Visual Designer/);
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
	let profile: unknown;
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const pi = {
		getFlag() { return profile; },
		on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); },
	} as unknown as ExtensionAPI;
	designerExtension(pi);
	const ctx = { cwd: root, hasUI: false } as any;
	try {
		await handlers.get("session_start")?.({}, ctx);
		assert.equal(await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx), undefined);

		profile = "designer";
		await handlers.get("session_start")?.({}, ctx);
		const result = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx) as { systemPrompt: string };
		assert.match(result.systemPrompt, /^base/);
		assert.match(result.systemPrompt, /# Visual Designer/);
		assert.match(result.systemPrompt, /# Repository Design Authority/);
		assert.match(result.systemPrompt, /Use the repository palette\./);

		await writeFile(join(root, "DESIGN.md"), "Changed after startup.");
		const later = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx) as { systemPrompt: string };
		assert.match(later.systemPrompt, /Use the repository palette\./, "authority is a session-start snapshot");
		assert.doesNotMatch(later.systemPrompt, /Changed after startup/);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		await rm(root, { recursive: true, force: true });
	}
});
