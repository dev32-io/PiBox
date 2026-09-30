import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { WORKFLOW_CHILD_EXTENSION_PATHS } from "../../workflow/index.js";
import { STANDALONE_CHILD_EXTENSION_PATHS } from "../child-extensions.js";
import { createPiInvocationResolver, PERMISSIONS_EXTENSION_PATH } from "../invocation.js";
import { SubagentProcessManager } from "../process-manager.js";
import { SUBAGENT_CONTROL_TOOLS } from "../tool-policy.js";

const provider = resolve("extensions/subagent/tests/support/guard-provider.ts");

test("explicit child launch guards enforce policy and MCP scope without global rediscovery, and deduplicate with it", { timeout: 120_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-child-guards-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const owner = { sessionId: "guards", activationId: "guards", processInstanceId: "guards" };
	for (const rediscover of [false, true]) {
		const agentDir = join(root, `agent-${rediscover}`);
		await mkdir(agentDir);
		// A disposable personal package declaration exercises normal package + CLI
		// identity, without reading the user's settings or credentials.
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: rediscover ? [resolve(".")] : [], retry: { enabled: false } }));
		for (const [kind, agent, paths] of [
			["standalone", "implementer", STANDALONE_CHILD_EXTENSION_PATHS],
			["workflow", "implementer", WORKFLOW_CHILD_EXTENSION_PATHS],
			["e2e", "e2e-tester", WORKFLOW_CHILD_EXTENSION_PATHS],
		] as const) {
			for (const mode of ["enforce", "bypass"]) {
				const cwd = join(root, `${rediscover}-${kind}-${mode}`);
				await mkdir(join(cwd, ".pi"), { recursive: true });
				await writeFile(join(cwd, ".pi/permissions.yaml"), "version: 1\ndefault: allow\npermissions:\n  deny:\n    - Bash(echo denied *)\n  ask:\n    - Bash(echo asked *)\n");
				const resolver = createPiInvocationResolver({ piInvocation: {
					command: process.env.PIBOX_TEST_PI_CLI ?? resolve("node_modules/.bin/pi"), args: ["--offline", "--no-context-files", "--no-skills"],
					env: { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, HOME: root, PIBOX_PERMISSION_MODE: mode },
				} });
				const manager = new SubagentProcessManager({ owner, sessionDirectory: join(cwd, "sessions"), invocationResolver: async (request) => {
					const invocation = await resolver(request);
					assert.equal(invocation.args.filter((arg) => arg === PERMISSIONS_EXTENSION_PATH).length, 1);
					return invocation;
				} });
				try {
					const started = await manager.launch({ owner, agent, cwd, stableSystemContext: "Offline guard fixture", attemptUserPrompt: "Run guard checks", provider: "pibox-guard-test", model: "fixture", effort: "off", tools: ["bash", "mcp"], extensionPaths: [...paths, provider], skillPaths: [], fast: false, env: { PIBOX_ALLOWED_MCP_SERVERS: "playwright" } });
					const result = await started.result;
					assert.equal(result.status, "completed", `${rediscover}/${kind}/${mode}: ${result.stderr}`);
					const report = JSON.parse(result.text);
					assert.equal(report.permissionCommands, 1, "package rediscovery must not duplicate permissions factory");
					assert.ok(SUBAGENT_CONTROL_TOOLS.every((tool) => !report.tools.includes(tool)));
					assert.deepEqual(report.results.map((entry: { error: boolean }) => entry.error), [false, mode === "enforce", mode === "enforce", false, true, true]);
					assert.match(JSON.stringify(report.results[3]), /playwright/);
					assert.equal(await readFile(join(cwd, "allowed.txt"), "utf8"), "allowed\n");
					for (const file of ["denied.txt", "asked.txt"]) {
						if (mode === "enforce") await assert.rejects(access(join(cwd, file)), /ENOENT/);
						else await access(join(cwd, file));
					}
					if (result.reportPath) await rm(dirname(result.reportPath), { recursive: true, force: true });
				} finally { await manager.teardown(); }
			}
		}
	}
});
