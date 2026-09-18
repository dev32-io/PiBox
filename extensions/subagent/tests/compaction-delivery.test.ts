import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProvider } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import subagentExtension from "../index.js";
import type { RuntimeOwner, SubagentService, TerminalResult } from "../api.js";
import { BUILT_IN_AGENT_ROOT, DEFAULT_SUBAGENT_CATALOG_CONFIG } from "../catalog.js";
import { PendingSubagentDeliveryRegistry } from "../pending-deliveries.js";
import { SubagentCapabilityRegistry } from "../registry.js";
import { SubagentUiProjectionRegistry } from "../ui-projection.js";

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void }
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

function service(owner: RuntimeOwner): SubagentService {
	const replay = { snapshot: { owner, cursor: 0, agents: [] }, events: [], reset: false } as const;
	return {
		protocolVersion: 1,
		owner,
		launch: async () => { throw new Error("unused"); },
		continue: async () => { throw new Error("unused"); },
		wait: async () => { throw new Error("unused"); },
		stop: async () => undefined,
		release: async () => undefined,
		inspect: () => [],
		replay: () => replay,
		subscribe: () => ({ initial: replay, unsubscribe() {} }),
		teardown() {},
	};
}

function terminal(owner: RuntimeOwner): TerminalResult {
	return {
		owner,
		handle: { owner, agentId: "compaction-agent", continuationCapability: "capability" },
		attemptId: "attempt",
		contextHashes: { stableSystemContextHash: "sha256:stable", attemptUserTurnHash: "sha256:attempt" },
		status: "completed",
		reason: "completed",
		exitCode: 0,
		text: "compaction result",
	};
}

test("real AgentSession keeps delivery gated through later compaction hooks", async () => {
	const requests: unknown[] = [];
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += chunk;
		requests.push(JSON.parse(raw));
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(`data: ${JSON.stringify({ id: `response-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "controlled", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`);
		response.write(`data: ${JSON.stringify({ id: `response-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "controlled", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
		response.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("controlled provider did not bind");

	const root = await mkdtemp(join(tmpdir(), "pibox-compaction-delivery-"));
	const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
	const model = {
		id: "controlled", name: "Controlled", api: "openai-completions" as const, provider: "controlled",
		baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 1_000,
	};
	modelRuntime.registerNativeProvider(createProvider({
		id: "controlled",
		auth: { apiKey: { name: "Controlled", resolve: async () => ({ auth: { apiKey: "test" } }) } },
		models: [model],
		api: { stream, streamSimple },
	}));

	const pending = new PendingSubagentDeliveryRegistry(25);
	const compactionStarted = deferred<void>();
	const laterHookStarted = deferred<void>();
	const releaseLaterHook = deferred<void>();
	let owner: RuntimeOwner | undefined;
	const loaded = { config: structuredClone(DEFAULT_SUBAGENT_CATALOG_CONFIG), digest: "test", sources: ["test"], diagnostics: [] };
	loaded.config.agents = { "general-purpose": { description: "General", prompt: `${BUILT_IN_AGENT_ROOT}/general-purpose.md`, tier: "medium", tools: ["*"] } };
	const controlExtension = (pi: ExtensionAPI) => {
		subagentExtension(pi, {
			registry: new SubagentCapabilityRegistry(),
			uiRegistry: new SubagentUiProjectionRegistry(),
			pendingDeliveries: pending,
			processInstanceId: "controlled-process",
			loadCatalog: () => loaded,
			createService(createdOwner) { owner = createdOwner; return service(createdOwner); },
		});
		pi.on("session_before_compact", () => { compactionStarted.resolve(undefined); });
		pi.on("session_compact", async () => {
			laterHookStarted.resolve(undefined);
			await releaseLaterHook.promise;
		});
	};
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 } });
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: join(root, "agent"),
		settingsManager,
		extensionFactories: [{ name: "compaction-control", factory: controlExtension }],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	const runtimeRole = process.env.PIBOX_RUNTIME_ROLE;
	delete process.env.PIBOX_RUNTIME_ROLE;
	try { await loader.reload(); }
	finally {
		if (runtimeRole === undefined) delete process.env.PIBOX_RUNTIME_ROLE;
		else process.env.PIBOX_RUNTIME_ROLE = runtimeRole;
	}
	const sessionManager = SessionManager.inMemory(root);
	const { session } = await createAgentSession({ cwd: root, agentDir: join(root, "agent"), model, modelRuntime, resourceLoader: loader, settingsManager, sessionManager, tools: [] });
	const extensionErrors: unknown[] = [];
	await session.bindExtensions({
		mode: "print",
		commandContextActions: { waitForIdle: () => session.waitForIdle() } as any,
		onError: (error) => { extensionErrors.push(error); },
	});

	try {
		await session.prompt(`first turn ${"x".repeat(2_000)}`);
		await session.prompt(`second turn ${"y".repeat(2_000)}`);
		assert.ok(owner);
		assert.deepEqual(extensionErrors, []);
		let settle!: (value: TerminalResult) => void;
		const result = new Promise<TerminalResult>((resolve) => { settle = resolve; });
		pending.track({ owner, agent: "general-purpose", agentId: "compaction-agent" }, result);

		const compacting = session.compact("controlled compaction");
		await compactionStarted.promise;
		settle(terminal(owner));
		await laterHookStarted.promise;
		assert.equal(session.isIdle, false, "supported Pi runtime treats pending compaction hooks as busy");
		const requestsDuringHook = requests.length;
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(requests.length, requestsDuringHook, "no delivery request starts during a later awaited compaction hook");
		assert.doesNotMatch(JSON.stringify(sessionManager.getEntries()), /pibox-subagent-delivery-/, "internal command is never persisted");

		releaseLaterHook.resolve(undefined);
		await compacting;
		for (let attempts = 0; requests.length < requestsDuringHook + 1 && attempts < 100; attempts++) await new Promise((resolve) => setTimeout(resolve, 5));
		await session.waitForIdle();
		assert.equal(requests.length, requestsDuringHook + 1, "retained result triggers exactly one post-idle turn");
		const serialized = JSON.stringify(sessionManager.getEntries());
		assert.doesNotMatch(serialized, /pibox-subagent-delivery-/);
		assert.equal(serialized.match(/"customType":"pibox-subagent-result"/g)?.length, 1);
	} finally {
		session.dispose();
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(root, { recursive: true, force: true });
	}
});
