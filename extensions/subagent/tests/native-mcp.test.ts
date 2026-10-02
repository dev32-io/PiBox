import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { nativeSession } from "../../work-mode/tests/support/native-session.js";
import { FakeSubagentService } from "../../workflow-runtime/tests/fixtures/fake-subagent-service.js";
import { WorkflowSubagentLauncher } from "../../workflow-runtime/subagent-launcher.js";
import subagentExtension from "../index.js";
import { DEFAULT_SUBAGENT_CATALOG_CONFIG } from "../catalog.js";
import { SubagentCapabilityRegistry } from "../registry.js";
import nativeMcp, { awaitNativeMcpReady, nativeMcpExtensionPaths } from "../native-mcp.js";

const serverPath = resolve("extensions/subagent/tests/support/native-mcp-server.mjs");

test("native readiness fences both early snapshots, cancellation, concurrent launches, reload and late registrations", { timeout: 30_000 }, async () => {
	const priorDir = process.env.PI_CODING_AGENT_DIR;
	let api!: ExtensionAPI;
	let ctx!: ExtensionContext;
	let spawn!: ToolDefinition;
	let standalone!: FakeSubagentService;
	let replaceGateway = false;
	const h = await nativeSession([(pi) => nativeMcp({ ...pi, getAllTools: () => pi.getAllTools().map((tool) => replaceGateway && tool.name === "codemode" ? { ...tool, parameters: Type.Object({}) } : tool) }), (pi) => {
		api = pi;
		pi.on("session_start", (_event, context) => { ctx = context; });
		subagentExtension({ ...pi, registerTool(tool) {
			if (tool.name === "subagent_spawn") spawn = tool as unknown as ToolDefinition;
			pi.registerTool(tool);
		} }, {
			env: {}, registry: new SubagentCapabilityRegistry(),
			loadCatalog: () => ({ config: { ...structuredClone(DEFAULT_SUBAGENT_CATALOG_CONFIG), agents: { fixture: { prompt: resolve("agent-definitions/general-purpose.md"), tools: ["read", "mcp"] } } }, digest: "fixture", sources: [], diagnostics: [] }),
			createService(owner) { return standalone = new FakeSubagentService(undefined, owner); },
		});
	}]);
	process.env.PI_CODING_AGENT_DIR = join(h.cwd, "agent");
	const log = join(h.cwd, "server.jsonl");
	await writeFile(log, "");
	const config = { command: process.execPath, args: [serverPath, "dev-radius", log, "500"], exposure: "codemode" as const };
	try {
		api.registerMcpServer("dev-radius", config);
		await h.session.bindExtensions({ mode: "print" });
		assert.ok(!api.getAllTools().some((tool) => tool.name.startsWith("mcp__")), "no first prompt or native discovery has run");
		const workflow = new FakeSubagentService();
		const launcher = new WorkflowSubagentLauncher(workflow, [], undefined, () => api.getAllTools());
		const input = { storyId: "fixture", slotId: "fixture", attemptToken: "fixture", action: "task-launch", role: "implementer", tier: "high" as const, cwd: h.cwd, stableSystemContext: "fixture", attemptUserPrompt: "fixture", provider: "fixture", model: "fixture", effort: "off", tools: ["read", "mcp"] };
		const controller = new AbortController();
		const cancelled = launcher.launch({ ...input, signal: controller.signal });
		controller.abort(new Error("cancel readiness"));
		await assert.rejects(cancelled, /cancel readiness/);
		assert.equal(workflow.requests.length, 0);
		const launchStandalone = (signal?: AbortSignal) => spawn.execute("fixture", { agent: "fixture", title: "Fixture snapshot", task: "Fixture", model: "pibox-compat-fixture/fixture", effort: "off" }, signal, undefined, ctx as ExtensionToolContext);
		const standaloneController = new AbortController();
		const cancelledStandalone = launchStandalone(standaloneController.signal);
		standaloneController.abort(new Error("cancel readiness"));
		await assert.rejects(cancelledStandalone, /cancel readiness/);
		assert.equal(standalone.requests.length, 0);
		await Promise.all([launcher.launch(input), launcher.launch({ ...input, slotId: "other" }), launchStandalone()]);
		for (const request of [...workflow.requests, ...standalone.requests]) {
			assert.equal(request.kind, "launch");
			if (request.kind === "launch") {
				assert.equal(request.spec.tools.filter((name) => name.startsWith("mcp__dev_radius__")).length, 6);
				assert.ok(!request.spec.tools.includes("subagent_spawn"));
			}
		}
		const fallback = new FakeSubagentService((request) => request.kind === "launch" && request.spec.provider === "limited"
			? { status: "failed", reason: "failure", exitCode: 1, stderr: "HTTP 429", text: "" }
			: { status: "completed", text: "fallback" });
		await new WorkflowSubagentLauncher(fallback, [], undefined, () => api.getAllTools()).launch({ ...input, provider: "limited", providerCandidates: [{ provider: "fixture", model: "fixture", effort: "off" }] });
		assert.equal(fallback.requests.length, 2);
		assert.ok(fallback.requests.every((request) => request.kind === "launch" && request.spec.tools.includes("mcp__dev_radius__echo")));
		await launcher.launch({ ...input, attemptToken: "continued" });
		assert.equal(workflow.requests.at(-1)?.kind, "continue");
		api.registerMcpServer("late-server", { ...config, args: [serverPath, "late-server", log, "250"] });
		// Native change handlers start asynchronously; no prompt should be needed.
		await new Promise((resolve) => setImmediate(resolve));
		await launcher.launch({ ...input, attemptToken: "late" });
		const late = workflow.requests.at(-1)!;
		assert.equal(late.kind, "launch");
		if (late.kind === "launch") assert.ok(late.spec.tools.includes("mcp__late_server__echo"));
		api.registerMcpServer("reload-pending", { ...config, args: [serverPath, "reload-pending", log, "500"] });
		await new Promise((resolve) => setImmediate(resolve));
		const stale = assert.rejects(awaitNativeMcpReady(), /session changed during discovery/);
		await h.session.reload();
		await stale;
		await assert.rejects(awaitNativeMcpReady(), /active session/, "reload does not reuse a previous context before binding");
		await h.session.bindExtensions({ mode: "print" });
		api.registerMcpServer("dev-radius", config);
		await new Promise((resolve) => setImmediate(resolve));
		await awaitNativeMcpReady();
		assert.ok(api.getAllTools().some((tool) => tool.name === "mcp__dev_radius__echo"));
		replaceGateway = true;
		await assert.rejects(awaitNativeMcpReady(), /requires native codemode or tool_search/, "same-name replacement cannot silently skip discovery");
		await h.session.prompt("Ordinary model turn may continue after native failure");
		assert.equal(h.requests.length, 1, "lifecycle errors do not prevent a model request");
		replaceGateway = false;
		await assert.rejects(awaitNativeMcpReady(), /disabled until reload/, "repairing discovery alone does not clear the latch");
		api.registerMcpServer("after-failure", { ...config, args: [serverPath, "after-failure", log, "100"], exposure: "direct" });
		await new Promise((resolve) => setTimeout(resolve, 300));
		const fixtureFile = join(h.cwd, "ordinary.txt");
		await writeFile(fixtureFile, "ordinary tools still work");
		const ordinary = await h.call("read", { path: fixtureFile });
		assert.ok(ordinary[1]!.messages.some((message) => message.role === "toolResult" && !message.isError));
		const discoveryRequests = await h.call("codemode", { code: "text({all:ALL_TOOLS.filter(t=>t.name.startsWith('mcp__')),namespace:(await describeNamespace('dev-radius'))??null,resource:(await describeTool('read_mcp_resource'))??null});" });
		const discoveryResult = discoveryRequests[1]!.messages.filter((message) => message.role === "toolResult").at(-1);
		assert.ok(discoveryResult?.role === "toolResult" && !discoveryResult.isError);
		assert.ok(JSON.stringify(discoveryResult.content).includes('\\"all\\":[]'));
		assert.ok(JSON.stringify(discoveryResult.content).includes('\\"namespace\\":null'));
		assert.ok(JSON.stringify(discoveryResult.content).includes('\\"resource\\":null'));
		for (const name of ["mcp__dev_radius__echo", "mcp__after_failure__echo", "read_mcp_resource"]) {
			const gate = await h.session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "blocked", toolName: name, input: {} });
			assert.equal(gate?.block, true, "dispatch fence does not depend on permissions or active tools");
		}
		for (const request of h.requests) {
			const systems = JSON.stringify(request.messages.filter((message) => message.role === "system"));
			assert.ok(!/mcp_servers|fixture instructions|mcp__dev_radius|mcp__after_failure|read_mcp_resource/.test(systems), "failed prompt and later registrations expose no native metadata");
		}
		await h.session.reload();
		await h.session.bindExtensions({ mode: "print" });
		api.registerMcpServer("dev-radius", config);
		await new Promise((resolve) => setImmediate(resolve));
		const recovered = await h.call("codemode", { code: "text(await tools.mcp__dev_radius__echo({}));" });
		const recoveredResult = recovered[1]!.messages.filter((message) => message.role === "toolResult").at(-1);
		assert.ok(recoveredResult && !recoveredResult.isError, "fresh reload restores verified native dispatch");
	} finally {
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		assert.deepEqual(nativeMcpExtensionPaths(), []);
		const entries = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
		for (const entry of entries.filter((entry) => entry.start)) assert.throws(() => process.kill(entry.start, 0), /ESRCH/);
		await h.close();
		if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorDir;
	}
});

test("MCP-off strips native structured summary before first prompt, subsequent prompts and reload", { timeout: 30_000 }, async () => {
	const priorDir = process.env.PI_CODING_AGENT_DIR;
	const priorEnabled = process.env.PIBOX_MCP_ENABLED;
	process.env.PIBOX_MCP_ENABLED = "0";
	const h = await nativeSession([nativeMcp, (pi) => {
		pi.registerMcpServer("private-server", { command: process.execPath, args: ["-e", "process.exit(1)"], description: "PRIVATE MCP METADATA" });
	}]);
	process.env.PI_CODING_AGENT_DIR = join(h.cwd, "agent");
	try {
		await h.session.bindExtensions({ mode: "print" });
		for (let i = 0; i < 3; i++) {
			if (i === 2) { await h.session.reload(); await h.session.bindExtensions({ mode: "print" }); }
			await h.session.prompt("Offline fixture");
		}
		assert.equal(h.requests.length, 3);
		for (const request of h.requests) {
			const systems = JSON.stringify(request.messages.filter((message) => message.role === "system"));
			assert.ok(!/mcp_servers|PRIVATE MCP METADATA|mcp__private_server/.test(systems), "no initial or historical summary leakage");
		}
	} finally {
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await h.close();
		if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorDir;
		if (priorEnabled === undefined) delete process.env.PIBOX_MCP_ENABLED; else process.env.PIBOX_MCP_ENABLED = priorEnabled;
	}
});
