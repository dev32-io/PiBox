import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import test from "node:test";
import { createProvider } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { registerSystemPromptContribution } from "../../core/system-prompt.js";
import { Type } from "typebox";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK_MODE_EXTENSION = resolve(HERE, "../index.ts");
const SCRATCH_EXTENSION = resolve(HERE, "../../session-scratch/index.ts");
const ORCHESTRATOR_HEADING = "# PiBox Orchestrator Mode";
const WORKSPACE_POINTERS = "Session scratch is private, temporary, and non-authoritative.";

type RequestBody = { messages?: Array<{ role?: string; content?: unknown }> };

function systemText(body: RequestBody): string {
	return body.messages?.find((message) => message.role === "system" || message.role === "developer")?.content as string ?? "";
}

async function lifecycleHarness() {
	const requests: RequestBody[] = [];
	let requestCount = 0;
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += chunk;
		requests.push(JSON.parse(raw));
		requestCount++;
		response.writeHead(200, { "content-type": "text/event-stream" });
		if (requestCount === 2) {
			response.write(`data: ${JSON.stringify({ id: "response-2", object: "chat.completion.chunk", created: 1, model: "controlled", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "lifecycle_probe", arguments: "{}" } }] }, finish_reason: null }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ id: "response-2", object: "chat.completion.chunk", created: 1, model: "controlled", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
		} else {
			response.write(`data: ${JSON.stringify({ id: `response-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "controlled", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ id: `response-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "controlled", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
		}
		response.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("controlled provider did not bind");

	const root = await mkdtemp(join(tmpdir(), "pibox-work-mode-lifecycle-"));
	const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
	const model = {
		id: "controlled",
		name: "Controlled",
		api: "openai-completions" as const,
		provider: "controlled",
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1_000,
	};
	modelRuntime.registerNativeProvider(createProvider({
		id: "controlled",
		auth: { apiKey: { name: "Controlled", resolve: async () => ({ auth: { apiKey: "test" } }) } },
		models: [model],
		api: { stream, streamSimple },
	}));

	let wake: (() => void) | undefined;
	let workspaceRenders = 0;
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 } });
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: join(root, "agent"),
		settingsManager,
		additionalExtensionPaths: [WORK_MODE_EXTENSION, SCRATCH_EXTENSION],
		extensionFactories: [{
			name: "lifecycle-control",
			factory(pi) {
				wake = () => pi.sendMessage({ customType: "controlled-background", content: "background complete", display: false }, { deliverAs: "steer", triggerTurn: true });
				registerSystemPromptContribution(pi, { id: "lifecycle-counter", order: 300, render: () => { workspaceRenders++; return undefined; } });
			},
		}],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "BASE SYSTEM",
	});
	const priorRuntimeRole = process.env.PIBOX_RUNTIME_ROLE;
	delete process.env.PIBOX_RUNTIME_ROLE;
	try {
		await loader.reload();
	} finally {
		if (priorRuntimeRole === undefined) delete process.env.PIBOX_RUNTIME_ROLE;
		else process.env.PIBOX_RUNTIME_ROLE = priorRuntimeRole;
	}
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: join(root, "agent"),
		model,
		modelRuntime,
		resourceLoader: loader,
		settingsManager,
		sessionManager: SessionManager.inMemory(root),
		tools: ["lifecycle_probe"],
		customTools: [defineTool({
			name: "lifecycle_probe",
			label: "Lifecycle probe",
			description: "Return controlled tool output",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "tool complete" }], details: {} }),
		})],
	});
	await session.bindExtensions({ mode: "print" });

	const wakeAndSettle = async () => {
		assert.ok(wake);
		let unsubscribe = () => {};
		let timeout: ReturnType<typeof setTimeout>;
		try {
			await new Promise<void>((resolveSettled, reject) => {
				timeout = setTimeout(() => reject(new Error("Background wake did not settle")), 10_000);
				unsubscribe = session.subscribe((event) => { if (event.type === "agent_settled") resolveSettled(); });
				wake!();
			});
		} finally { unsubscribe(); clearTimeout(timeout!); }
	};

	return {
		requests,
		session,
		workspaceRenders: () => workspaceRenders,
		wakeAndSettle,
		async run() {
			await session.prompt("establish ordinary turn");
			await wakeAndSettle();
			assert.equal(requests.length, 3, "idle wake must make initial and tool-followup requests");
		},
		async compact() {
			await session.compact("controlled lifecycle compaction");
			assert.ok(requests.length > 3, "manual compaction must use controlled provider");
		},
		async close() {
			session.dispose();
			const scratchRoot = systemText(requests[0] ?? {}).match(/Root: (\/tmp\/pibox-session-[a-f0-9]+)/)?.[1];
			if (scratchRoot) await rm(scratchRoot, { recursive: true, force: true });
			await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
			await rm(root, { recursive: true, force: true });
		},
	};
}

test("production system layer stays stable across ordinary, idle wake, tool followup, and compaction requests", async () => {
	const harness = await lifecycleHarness();
	try {
		await harness.run();
		const prompts = harness.requests.map(systemText);
		assert.equal(new Set(prompts).size, 1, "ordinary, idle wake, and tool followup system text is byte-stable");
		assert.match(prompts[0]!, new RegExp(ORCHESTRATOR_HEADING));
		assert.equal(prompts[0]!.indexOf(ORCHESTRATOR_HEADING) < prompts[0]!.indexOf(WORKSPACE_POINTERS), true);
		assert.equal(prompts[0]!.split(WORKSPACE_POINTERS).length - 1, 1);
		assert.equal(harness.requests.some((body) => JSON.stringify(body).includes("pibox-request-")), false, "private marker never reaches provider");
		assert.equal(harness.workspaceRenders(), 3, "contributions resolve on each agent request");
		await harness.compact();
		assert.equal(harness.workspaceRenders(), 3, "compaction does not resolve agent contributions");
		for (const body of harness.requests.slice(3)) {
			assert.doesNotMatch(systemText(body), /PiBox Orchestrator Mode|Session scratch is private/, "request-local marker excludes compaction summarization");
		}
		await harness.wakeAndSettle();
		assert.equal(systemText(harness.requests.at(-1)!), prompts[0], "real scratch paths survive post-compaction idle wake");
	} finally {
		await harness.close();
	}
});
