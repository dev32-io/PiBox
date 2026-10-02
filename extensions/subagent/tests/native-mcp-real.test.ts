import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import type { JsonObject } from "@earendil-works/pi-ai";
import { WorkflowSubagentLauncher } from "../../workflow-runtime/subagent-launcher.js";
import { createPiInvocationResolver } from "../invocation.js";
import { isMcpTool, mcpLaunchEnvironment, resolveMcpTools, type CapabilityTool } from "../mcp-capabilities.js";
import { SubagentProcessManager } from "../process-manager.js";
import { SUBAGENT_CONTROL_TOOLS } from "../tool-policy.js";

type Step = { name: string; arguments: JsonObject };
type Report = {
	registry: Array<CapabilityTool & { exposure?: string }>;
	readinessError?: string;
	beforePromptNativeCount: number;
	nativePaths: string[];
	mcpCommands: number;
	systems: string[];
	version: string;
	schemas: Array<Array<{ name: string; description: string }>>;
	results: Array<{ isError: boolean; details?: { loaded?: unknown[] }; content: Array<{ type: string; text?: string }> }>;
	calls: Array<{ name: string; parent?: string }>;
	identities: Array<{ name: string; identity?: { server: string; tool: string } }>;
};
const code = (value: string): Step => ({ name: "codemode", arguments: { code: value } });
const fixture = resolve("extensions/subagent/tests/support");

test("real native children enforce binary MCP across exposure, discovery, resources, bypass and workflow roles", { timeout: 180_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-native-binary-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let sequence = 0;
	async function run(selectors: string[], registry: CapabilityTool[], steps: Step[], options: { exposure?: string; mode?: string; searchOnly?: boolean; gatewayFault?: "missing" | "replaced"; preconnected?: boolean; workflow?: "task-launch" | "e2e" } = {}) {
		const cwd = join(root, String(sequence++));
		const agentDir = join(cwd, "agent");
		await mkdir(agentDir, { recursive: true });
		await mkdir(join(cwd, ".pi"));
		await writeFile(join(cwd, ".pi", "permissions.yaml"), "version: 1\ndefault: allow\npermissions:\n  deny:\n    - Mcp(dev-radius/a.b)\n");
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, enableInstallTelemetry: false, defaultTools: ["codemode", "tool_search"] }));
		const log = join(cwd, "server.jsonl");
		await writeFile(log, "");
		await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { ...Object.fromEntries(["dev-radius", "two"].map((name) => [name, { command: process.execPath, args: [join(fixture, "native-mcp-server.mjs"), name, log, "250"], description: `PRIVATE fixture ${name}`, exposure: options.exposure ?? "codemode" }])), unavailable: { command: process.execPath, args: ["-e", "process.exit(1)"] } } }));
		const stepsPath = join(cwd, "steps.json");
		await writeFile(stepsPath, JSON.stringify(steps));
		await writeFile(join(cwd, "ordinary.txt"), "ordinary tools still work");
		const owner = { sessionId: "native", activationId: "native", processInstanceId: "native" };
		const resolver = createPiInvocationResolver({ piInvocation: {
			command: process.env.PIBOX_TEST_PI_CLI ?? resolve("node_modules/.bin/pi"),
			args: ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-themes", ...(options.gatewayFault ? [] : [...(options.searchOnly ? [] : ["-e", "builtin:codemode"]), "-e", "builtin:tool-search"])],
			env: { PI_CODING_AGENT_DIR: agentDir, HOME: root, PI_OFFLINE: "1", PIBOX_PERMISSION_MODE: options.mode ?? "enforce", PIBOX_MCP_TEST_STEPS: stepsPath, ...(options.gatewayFault ? { PIBOX_MCP_TEST_GATEWAY: options.gatewayFault, PIBOX_MCP_TEST_PRECONNECTED: options.preconnected ? "1" : "0" } : {}) },
		} });
		const manager = new SubagentProcessManager({ owner, sessionDirectory: join(cwd, "sessions"), invocationResolver: resolver });
		const extensionPaths = [resolve("extensions/subagent/native-mcp.ts"), join(fixture, "native-mcp-provider.ts"), resolve("extensions/subagent/index.ts"), resolve("extensions/workflow/index.ts")];
		try {
			let text: string;
			let reportPath: string | undefined;
			if (options.workflow) {
				const launcher = new WorkflowSubagentLauncher(manager, extensionPaths, undefined, () => registry);
				const result = await launcher.launch({ storyId: "fixture", slotId: "fixture", attemptToken: "fixture", action: options.workflow, role: options.workflow === "e2e" ? "e2e-tester" : "implementer", tier: "high", cwd, stableSystemContext: "Offline fixture", attemptUserPrompt: "Run fixture", provider: "pibox-native-mcp-test", model: "fixture", effort: "off", tools: selectors, ...(options.workflow === "task-launch" ? { taskId: "fixture" } : {}) });
				assert.equal(result.exitCode, 0, result.stderr);
				text = result.text;
				reportPath = result.reportPath;
			} else {
				const started = await manager.launch({ owner, agent: "implementer", cwd, stableSystemContext: "Offline fixture", attemptUserPrompt: "Run fixture", provider: "pibox-native-mcp-test", model: "fixture", effort: "off", tools: resolveMcpTools(selectors, registry), extensionPaths, skillPaths: [], fast: false, env: mcpLaunchEnvironment(selectors) });
				const result = await started.result;
				assert.equal(result.status, "completed", result.stderr);
				text = result.text;
				reportPath = result.reportPath;
			}
			if (reportPath) await rm(dirname(reportPath), { recursive: true, force: true });
			const report = JSON.parse(text) as Report;
			const dispatches = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
			for (const entry of dispatches.filter((entry) => entry.start)) assert.throws(() => process.kill(entry.start, 0), /ESRCH/, "native fixture process must be cleaned up");
			assert.ok(SUBAGENT_CONTROL_TOOLS.every((name) => !report.registry.some((tool) => tool.name === name)));
			return { report, dispatches };
		} finally { await manager.teardown(); }
	}

	// Wrapper must await delayed indirect registration before the first model request.
	const initial = (await run(["*"], [], [])).report;
	const snapshot = initial.registry;
	assert.equal(snapshot.filter((tool) => tool.namespace?.name === "mcp__dev_radius").length, 6);
	const searchOnly = (await run(["*"], [], [], { searchOnly: true })).report;
	assert.equal(searchOnly.registry.filter((tool) => tool.namespace?.name === "mcp__dev_radius").length, 6, "native tool_search alone also supplies the readiness barrier");
	const denied = initial.identities.find((entry) => entry.identity?.server === "dev-radius" && entry.identity.tool === "a.b")!.name;
	const collision = initial.identities.find((entry) => entry.identity?.server === "dev-radius" && entry.identity.tool === "a_b")!.name;
	assert.notEqual(denied, collision);
	assert.notEqual(denied, "mcp__dev_radius__a_b");
	assert.notEqual(collision, "mcp__dev_radius__a_b");
	// Missing/replaced gateways must not leak capabilities when lifecycle throws are
	// swallowed. Reinstall native discovery during the first ordinary read, then
	// probe every discovery/dispatch surface after delayed servers have registered.
	const failureSteps: Step[] = [
		{ name: "read", arguments: { path: "ordinary.txt" } },
		code("text({all:ALL_TOOLS.filter(t=>t.name.startsWith('mcp__')||t.name.includes('_mcp_resource')),search:await searchTools('mcp__'),describe:(await describeTool('mcp__dev_radius__echo'))??null,namespaces:await Promise.all(['dev-radius','dev_radius','mcp__dev-radius','mcp__dev_radius'].map(async n=>(await describeNamespace(n))??null))});"),
		{ name: "mcp__two__echo", arguments: {} },
		{ name: "list_mcp_resources", arguments: {} },
		{ name: "list_mcp_resource_templates", arguments: {} },
		{ name: "read_mcp_resource", arguments: { server: "two", uri: "fixture://two/secret" } },
		code("for(const name of ['mcp__two__echo','list_mcp_resources','list_mcp_resource_templates','read_mcp_resource']) {try {text(await tools[name]({server:'two',uri:'fixture://two/secret'}));} catch(e) {text(String(e));}} text(await tools.read({path:'ordinary.txt'}));"),
		{ name: "tool_search", arguments: { query: "mcp__" } },
		{ name: "read", arguments: { path: "ordinary.txt" } },
	];
	function assertFailedNative(report: Report, dispatches: Array<{ method?: string }>) {
		assert.equal(report.results.length, failureSteps.length, "ordinary model turns continue");
		assert.ok(report.readinessError?.includes("disabled until reload"));
		assert.equal(report.nativePaths.length, 1, "failed wrapper must not masquerade as an absent alternate integration");
		assert.equal(report.mcpCommands, 1, "retain replacement ownership");
		assert.ok(report.registry.filter(isMcpTool).every((tool) => tool.exposure === "hidden"));
		assert.ok(report.identities.every((entry) => !entry.identity));
		assert.ok(report.schemas.every((schema) => !schema.some(isMcpTool)));
		assert.ok(report.systems.every((system) => !/mcp_servers|PRIVATE fixture|fixture instructions|mcp__dev_radius|mcp__two|list_mcp_resources|read_mcp_resource/.test(system)));
		assert.deepEqual(JSON.parse(report.results[1]!.content[1]!.text!), { all: [], search: [], describe: null, namespaces: [null, null, null, null] });
		for (const index of [2, 3, 4, 5]) assert.equal(report.results[index]!.isError, true, "native dispatch blocked even in bypass");
		for (const index of [0, 6, 8]) {
			assert.equal(report.results[index]!.isError, false, "ordinary direct/nested read stays available");
			assert.ok(JSON.stringify(report.results[index]!.content).includes("ordinary tools still work"));
		}
		assert.deepEqual(report.results[7]!.details?.loaded, []);
		assert.ok(!dispatches.some((entry) => entry.method === "tools/call" || entry.method === "resources/read"));
	}
	for (const gatewayFault of ["missing", "replaced"] as const) {
		for (const mode of ["enforce", "bypass"]) {
			for (const exposure of ["direct", "codemode"]) {
				for (const preconnected of [false, true]) await t.test(`native failure ${gatewayFault}/${mode}/${exposure}/${preconnected ? "registered" : "delayed"}`, async () => {
					const { report, dispatches } = await run(["read", "mcp"], snapshot, failureSteps, { gatewayFault, mode, exposure, preconnected });
					assertFailedNative(report, dispatches);
					if (preconnected) assert.ok(report.beforePromptNativeCount > 0, "native tools already registered before the failing prompt");
					assert.ok(report.registry.some(isMcpTool), "exercise hidden registrations, not only an empty registry");
				});
			}
		}
	}
	const steps = [
		code("text({all:ALL_TOOLS,search:await searchTools('mcp__'),describe:(await describeTool('mcp__dev_radius__echo'))??null,namespaces:await Promise.all(['dev-radius','dev_radius','mcp__dev-radius','mcp__dev_radius'].map(async n=>(await describeNamespace(n))??null))});"),
		{ name: "tool_search", arguments: { query: "mcp__two__echo", limit: 1 } },
		{ name: "mcp__two__echo", arguments: {} },
		code(`try {text(await tools.${denied}({}));} catch(e) {text(String(e));}`),
		code("try {text(await tools.list_mcp_resources({})); text(await tools.list_mcp_resource_templates({})); text(await tools.read_mcp_resource({server:'two',uri:'fixture://two/secret'}));} catch(e) {text(String(e));}"),
		code("text({all:ALL_TOOLS,search:await searchTools('ungranted_extension'),describe:(await describeTool('ungranted_extension'))??null}); try {text(await tools.ungranted_extension({}));} catch(e) {text(String(e));} try {text(await tools.mcp__two__late({}));} catch(e) {text(String(e));}"),
		{ name: "read_mcp_resource", arguments: { server: "dev-radius", uri: "fixture://dev-radius/secret" } },
		{ name: "ungranted_extension", arguments: {} },
	] satisfies Step[];
	for (const exposure of ["codemode", "codemode-deferred", "deferred", "direct", "hidden"]) {
		for (const mode of ["enforce", "bypass"]) {
			for (const enabled of [false, true]) {
				const { report, dispatches } = await run(["read", "codemode", "tool_search", ...(enabled ? ["mcp"] : [])], snapshot, steps, { exposure, mode });
				assert.equal(report.results.length, steps.length);
				assert.ok(!report.registry.some((tool) => tool.name === "ungranted_extension"));
				assert.ok(report.results[7]!.isError);
				assert.ok(report.schemas.every((schema) => !JSON.stringify(schema).includes("Ordinary excluded fixture tool")));
				assert.ok(!report.registry.some((tool) => tool.name === "mcp__two__late"));
				const discovery = JSON.parse(report.results[0]!.content[1]!.text!);
				const ordinaryDiscovery = JSON.parse(report.results[5]!.content[1]!.text!);
				assert.deepEqual(ordinaryDiscovery.search, []);
				assert.ok(!ordinaryDiscovery.all.some((tool: CapabilityTool) => tool.name === "ungranted_extension"));
				assert.equal(ordinaryDiscovery.describe, null);
				if (!enabled || exposure === "hidden") {
					assert.ok(!discovery.all.some((tool: CapabilityTool) => isMcpTool(tool)));
					assert.equal(discovery.describe, null);
					assert.deepEqual(discovery.namespaces, [null, null, null, null]);
					assert.ok(report.results[2]!.isError);
					assert.ok(report.results[6]!.isError);
					assert.ok(!dispatches.some((entry) => entry.method === "tools/call" || entry.method === "resources/read"));
					if (!enabled) {
						assert.ok(!report.registry.some(isMcpTool));
						assert.ok(report.systems.every((system) => !/mcp_servers|PRIVATE fixture|fixture instructions|mcp__dev_radius|mcp__two/.test(system)), "no MCP metadata in initial or appended system messages");
						assert.ok(report.schemas.every((schema) => !schema.some((tool) => isMcpTool(tool))));
						assert.ok(!/mcp__dev_radius__|mcp__two__|list_mcp_resources|read_mcp_resource/.test(JSON.stringify(report.schemas)));
						assert.deepEqual(report.results[1]!.details?.loaded, []);
						assert.deepEqual(discovery.search, []);
					}
				} else {
					assert.equal(report.results[2]!.isError, false, `${exposure}/${mode}: ${JSON.stringify(report.results[2])}`);
					assert.equal(report.results[6]!.isError, exposure !== "direct");
					for (const namespace of discovery.namespaces) {
						assert.equal(namespace.name, "mcp__dev_radius");
						assert.equal(namespace.description, "PRIVATE fixture dev-radius");
						assert.equal(namespace.instructions, "fixture instructions dev-radius");
					}
					const resources = JSON.stringify(report.results[4]);
					for (const expected of ["dev-radius-resource", "two-resource", "dev-radius-template", "two-template", "two-resource-body"]) assert.ok(resources.includes(expected), expected);
					assert.equal(dispatches.some((entry) => entry.server === "dev-radius" && entry.method === "tools/call" && entry.params.name === "a.b"), mode === "bypass");
					assert.ok(report.calls.some((call) => call.name === "list_mcp_resources" && call.parent));
					if (mode === "bypass") assert.ok(report.calls.some((call) => call.name === denied && call.parent));
					if (exposure !== "direct") assert.ok(!report.schemas[0]!.some((tool) => tool.name === "mcp__dev_radius__echo"), "initial native exposure must remain indirect");
				}
			}
		}
	}
	const identity = await run(["*"], snapshot, [code("for (const {name} of ALL_TOOLS.filter(t => t.name.startsWith('mcp__'))) text({name,result:await tools[name]({})});")], { mode: "bypass" });
	assert.equal(identity.report.results[0]!.isError, false);
	const returned = identity.report.results[0]!.content.slice(1).map((part) => JSON.parse(part.text!));
	for (const pair of returned) {
		const original = JSON.parse(pair.result.content[0].text);
		assert.deepEqual(identity.report.identities.find((entry) => entry.name === pair.name)?.identity, { server: original.server, tool: original.original });
		assert.ok(identity.dispatches.some((entry) => entry.server === original.server && entry.method === "tools/call" && entry.params.name === original.original));
	}
	assert.equal(returned.length, 12, "identity proof covers collisions, slash and long original names on both servers");
	const wildcard = await run(["*"], snapshot, [code("text(await tools.mcp__two__echo({}));"), code("text(await tools.mcp__two__late({}));")], { mode: "bypass" });
	assert.ok(wildcard.dispatches.some((entry) => entry.params?.name === "late"));
	const fresh = await run(["mcp"], wildcard.report.registry, [code("text(await tools.mcp__two__echo({}));"), code("text(await tools.mcp__two__late({}));")], { mode: "bypass" });
	assert.ok(fresh.dispatches.some((entry) => entry.params?.name === "late"), "fresh launch admits the newer snapshot");
	for (const action of ["task-launch", "e2e"] as const) {
		const { report } = await run(["*"], snapshot, [], { workflow: action, mode: "bypass" });
		for (const name of ["task_clarify", "workflow_ledger"]) assert.equal(report.registry.some((tool) => tool.name === name), action === "task-launch");
		assert.ok(report.registry.some(isMcpTool));
	}
});
