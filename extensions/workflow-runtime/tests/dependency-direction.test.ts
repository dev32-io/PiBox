import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { isSubagentRuntime, PIBOX_RUNTIME_ROLE_ENV, PIBOX_SUBAGENT_RUNTIME_ROLE } from "../../subagent/tool-policy.js";

async function productionTypeScriptFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (entry.name === "tests") continue;
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...await productionTypeScriptFiles(path));
		else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
	}
	return files;
}

test("workflow consumes the standalone subagent boundary and dependency direction never reverses", async () => {
	const repository = resolve(".");
	const coordinator = await readFile(join(repository, "extensions/workflow-runtime/launch-coordinator.ts"), "utf8");
	const workflow = await readFile(join(repository, "extensions/workflow/index.ts"), "utf8");
	assert.match(coordinator, /from "\.\.\/subagent\/api\.js"/);
	assert.match(workflow, /from "\.\.\/subagent\/registry\.js"/);
	assert.match(workflow, /resolveSubagentServiceForConsumer/);
	assert.doesNotMatch(coordinator, /child_process|runDirectAgent|legacy-launch/);

	for (const relative of [
		"extensions/workflow-runtime/legacy-launch-coordinator.ts",
		"extensions/workflow-runtime/direct-agent.ts",
		"extensions/workflow-runtime/agent-live-projection.ts",
		"extensions/workflow-runtime/agent-progress.ts",
		"extensions/workflow-runtime/subagent-display.ts",
		"extensions/workflow-runtime/subagent-status.ts",
		"extensions/workflow/agent-definitions.ts",
		"extensions/workflow/mcp-capabilities.ts",
	]) await assert.rejects(access(join(repository, relative)), /ENOENT/, `${relative} must remain deleted`);

	for (const path of await productionTypeScriptFiles(join(repository, "extensions/subagent"))) {
		const source = await readFile(path, "utf8");
		assert.doesNotMatch(source, /(?:from|import\()\s*["'][^"']*(?:workflow-runtime|\/workflow)(?:\/|\.)/, `${path} must not import workflow`);
	}
});

test("package activation order and runtime role remain explicit compatibility contracts", async () => {
	const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { pi?: { extensions?: string[] } };
	const extensions = packageJson.pi?.extensions ?? [];
	const standalone = extensions.indexOf("./extensions/subagent/index.ts");
	const runtime = extensions.indexOf("./extensions/workflow-runtime/index.ts");
	const workflow = extensions.indexOf("./extensions/workflow/index.ts");
	assert.ok(standalone >= 0 && standalone < runtime && runtime < workflow, "standalone service must activate before workflow consumers");

	assert.equal(isSubagentRuntime({ PIBOX_SUBAGENT_ID: "managed-identity" }), false, "identity metadata cannot select child behavior");
	assert.equal(isSubagentRuntime({ [PIBOX_RUNTIME_ROLE_ENV]: PIBOX_SUBAGENT_RUNTIME_ROLE }), true);
	assert.equal(isSubagentRuntime({ [PIBOX_RUNTIME_ROLE_ENV]: "main", PIBOX_SUBAGENT_ID: "managed-identity" }), false);
});
