import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type JsonObject, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** Real native agent loop + QuickJS, with deterministic offline provider requests. */
export async function nativeSession(factories: ExtensionFactory[]) {
	const cwd = await mkdtemp(join(tmpdir(), "pibox-native-compat-"));
	const requests: TranscriptContext[] = [];
	let nextCall: { name: string; arguments: JsonObject } | undefined;
	let sequence = 0;
	const model = {
		id: "fixture", name: "Fixture", api: "pibox-compat-fixture", provider: "pibox-compat-fixture", baseUrl: "https://offline.invalid",
		reasoning: false, input: ["text"] as ("text" | "image")[], contextWindow: 128_000, maxTokens: 1_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const settingsManager = SettingsManager.inMemory({ defaultTools: ["+codemode"], compaction: { enabled: false }, retry: { enabled: false } });
	const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
	const loader = new DefaultResourceLoader({
		cwd, agentDir: join(cwd, "agent"), settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		systemPrompt: "Offline compatibility fixture",
		extensionFactories: [createCodemodeExtension({ mode: "on", models: false }), ...factories, (pi) => {
			pi.registerProvider(model.provider, {
				api: model.api, baseUrl: model.baseUrl, apiKey: "fixture", models: [model],
				streamSimple(runtimeModel, context, options) {
					const stream = createAssistantMessageEventStream();
					queueMicrotask(async () => {
						await options?.onPayload?.({ fixture: true }, runtimeModel);
						requests.push(structuredClone(context));
						const call = nextCall;
						nextCall = undefined;
						const output: AssistantMessage = {
							role: "assistant", api: runtimeModel.api, provider: runtimeModel.provider, model: runtimeModel.id,
							content: [], stopReason: "pending", timestamp: Date.now(),
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						};
						stream.push({ type: "start", partial: output });
						if (call) {
							const toolCall = { type: "toolCall" as const, id: `fixture-${sequence++}`, ...call };
							output.content.push(toolCall);
							stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
							stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
							output.stopReason = "toolUse";
							stream.push({ type: "done", reason: "toolUse", message: output });
						} else {
							output.content.push({ type: "text", text: "done" });
							stream.push({ type: "text_start", contentIndex: 0, partial: output });
							stream.push({ type: "text_end", contentIndex: 0, content: "done", partial: output });
							output.stopReason = "stop";
							stream.push({ type: "done", reason: "stop", message: output });
						}
						stream.end();
					});
					return stream;
				},
			});
		}],
	});
	const priorRole = process.env.PIBOX_RUNTIME_ROLE;
	delete process.env.PIBOX_RUNTIME_ROLE;
	try { await loader.reload(); } finally {
		if (priorRole === undefined) delete process.env.PIBOX_RUNTIME_ROLE;
		else process.env.PIBOX_RUNTIME_ROLE = priorRole;
	}
	const { session } = await createAgentSession({ cwd, agentDir: join(cwd, "agent"), model, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd) });
	return {
		cwd, session, requests,
		async call(name: string, args: JsonObject) {
			nextCall = { name, arguments: args };
			const before = requests.length;
			await session.prompt("Run disposable compatibility step");
			return requests.slice(before);
		},
		async close() { session.dispose(); await rm(cwd, { recursive: true, force: true }); },
	};
}
