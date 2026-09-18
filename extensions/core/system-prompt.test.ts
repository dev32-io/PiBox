import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { applySystemPromptContributions, formatSystemPromptContributions, registerSystemPromptContribution } from "./system-prompt.js";

const MARKER = "private-request-marker";
const CONTRIBUTIONS = [
	{ id: "mode", text: "MODE" },
	{ id: "workspace", text: "WORKSPACE" },
];
const BLOCK = formatSystemPromptContributions(CONTRIBUTIONS);

function systemString(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((item) => typeof item?.text === "string" ? item.text : "").join("\n");
	return "";
}

function assertTransformed(api: string, payload: unknown, system: (result: any) => unknown): void {
	const result = applySystemPromptContributions(payload, api, MARKER, CONTRIBUTIONS) as any;
	assert.ok(result);
	assert.equal(JSON.stringify(result).includes(MARKER), false, `${api} removes private request marker`);
	assert.equal(JSON.stringify(result).includes("task"), true, `${api} preserves user content merged beside marker`);
	assert.equal(systemString(system(result)).includes(BLOCK), true, `${api} receives true system block`);
	const repeated = applySystemPromptContributions(
		api === "openai-codex-responses" || api === "openai-responses" || api === "azure-openai-responses"
			? { ...result, input: [...result.input, { role: "user", content: MARKER }] }
			: api === "google-generative-ai" || api === "google-vertex"
				? { ...result, contents: [...result.contents, { role: "user", parts: [{ text: MARKER }] }] }
				: api === "pi-messages"
					? { ...result, context: { ...result.context, messages: [...result.context.messages, { role: "user", content: MARKER }] } }
					: { ...result, messages: [...result.messages, { role: "user", content: MARKER }] },
		api,
		MARKER,
		CONTRIBUTIONS,
	) as any;
	assert.equal(systemString(system(repeated)).split(BLOCK).length - 1, 1, `${api} replacement is idempotent`);
}

test("known provider payloads receive one ordered system block and lose request marker", () => {
	for (const api of ["openai-completions", "mistral-conversations"]) {
		assertTransformed(api, {
			messages: [{ role: "system", content: "BASE" }, { role: "user", content: MARKER }, { role: "user", content: "task" }],
		}, (result) => result.messages[0].content);
	}
	for (const api of ["openai-responses", "azure-openai-responses"]) {
		assertTransformed(api, {
			input: [{ role: "developer", content: "BASE" }, { role: "user", content: [{ type: "input_text", text: MARKER }, { type: "input_text", text: "task" }] }],
		}, (result) => result.input[0].content);
	}
	assertTransformed("openai-codex-responses", {
		instructions: "BASE",
		input: [{ role: "user", content: [{ type: "input_text", text: MARKER }, { type: "input_text", text: "task" }] }],
	}, (result) => result.instructions);
	assertTransformed("anthropic-messages", {
		system: [{ type: "text", text: "BASE" }],
		messages: [{ role: "user", content: [{ type: "text", text: MARKER }, { type: "text", text: "task" }] }],
	}, (result) => result.system);
	assertTransformed("bedrock-converse-stream", {
		system: [{ text: "BASE" }],
		messages: [{ role: "user", content: [{ text: MARKER }, { text: "task" }] }],
	}, (result) => result.system);
	for (const api of ["google-generative-ai", "google-vertex"]) {
		assertTransformed(api, {
			config: { systemInstruction: "BASE" },
			contents: [{ role: "user", parts: [{ text: MARKER }, { text: "task" }] }],
		}, (result) => result.config.systemInstruction);
	}
	assertTransformed("pi-messages", {
		context: { systemPrompt: "BASE", messages: [{ role: "custom", content: [{ type: "text", text: MARKER }] }, { role: "user", content: "task" }] },
	}, (result) => result.context.systemPrompt);
});

test("real Anthropic serializer cache metadata is removed with marker", async () => {
	let serialized: any;
	const request = streamAnthropic({
		id: "claude-sonnet-4-5", name: "Claude", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://api.anthropic.com",
		reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_192,
	}, {
		systemPrompt: "BASE",
		messages: [{ role: "user", content: MARKER, timestamp: 0 }],
	}, {
		client: {} as never,
		onPayload(payload) {
			serialized = structuredClone(payload);
			throw new Error("payload captured");
		},
	});
	await request.result();

	assert.deepEqual(serialized.messages[0].content[0].cache_control, { type: "ephemeral" });
	const result = applySystemPromptContributions(serialized, "anthropic-messages", MARKER, CONTRIBUTIONS) as any;
	assert.deepEqual(result.messages, []);
	assert.equal(JSON.stringify(result).includes(MARKER), false);
	assert.deepEqual(result.system.at(-1).cache_control, { type: "ephemeral" });
	assert.equal(result.system[0].cache_control, undefined);
});

test("Anthropic replacement keeps cache breakpoints on new system suffix and last meaningful user block", () => {
	const cache = { type: "ephemeral", ttl: "1h" };
	const oldBlock = formatSystemPromptContributions([{ id: "old", text: "OLD" }]);
	const result = applySystemPromptContributions({
		system: [{ type: "text", text: "BASE" }, { type: "text", text: oldBlock, cache_control: cache }],
		messages: [{ role: "user", content: [{ type: "text", text: "task" }, { type: "text", text: MARKER, cache_control: cache }] }],
	}, "anthropic-messages", MARKER, CONTRIBUTIONS) as any;

	assert.deepEqual(result.system, [{ type: "text", text: "BASE" }, { type: "text", text: BLOCK, cache_control: cache }]);
	assert.deepEqual(result.messages, [{ role: "user", content: [{ type: "text", text: "task", cache_control: cache }] }]);
	assert.equal(JSON.stringify(result).includes(MARKER), false);
	assert.equal(JSON.stringify(result).match(/cache_control/g)?.length, 2, "replacement neither drops nor adds cache breakpoints");
});

test("unmarked summarization and user text cannot activate system contributions", () => {
	assert.equal(applySystemPromptContributions({ messages: [{ role: "system", content: "BASE" }, { role: "user", content: "summary" }] }, "openai-completions", MARKER, CONTRIBUTIONS), undefined);
	assert.equal(applySystemPromptContributions({ messages: [{ role: "system", content: "BASE" }, { role: "user", content: `quote ${MARKER}` }] }, "openai-completions", MARKER, CONTRIBUTIONS), undefined);
	assert.throws(() => applySystemPromptContributions({ messages: [{ role: "system", content: "BASE" }, { role: "tool", content: MARKER }] }, "openai-completions", MARKER, CONTRIBUTIONS), /Unsupported openai-completions provider payload shape/);
});

test("unknown APIs and malformed known payloads fail explicitly when marker is present", () => {
	assert.throws(() => applySystemPromptContributions({ prompt: MARKER }, "custom-api", MARKER, CONTRIBUTIONS), /Unsupported custom-api provider payload shape/);
	assert.throws(() => applySystemPromptContributions({ messages: [{ role: "user", content: MARKER }] }, "openai-completions", MARKER, CONTRIBUTIONS), /no system message/);
	assert.throws(() => applySystemPromptContributions({
		system: [{ type: "text", text: "BASE" }],
		messages: [{ role: "user", content: [{ type: "text", text: MARKER, cache_control: { type: "ephemeral", ttl: "2h" } }] }],
	}, "anthropic-messages", MARKER, CONTRIBUTIONS), /Unsupported Anthropic cache_control shape/);
});

test("contributions re-register after shutdown and remain isolated by session", async () => {
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	const pi = {
		on(name: string, handler: (...args: any[]) => any) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	registerSystemPromptContribution(pi, { id: "session", order: 100, render: (ctx) => `SESSION ${ctx.sessionManager.getSessionId()}` });

	const ctx = (sessionId: string, api = "openai-completions") => ({ sessionManager: { getSessionId: () => sessionId }, model: { api } }) as any;
	const emit = async (name: string, event: unknown, context: unknown) => {
		let result: unknown;
		for (const handler of handlers.get(name) ?? []) result = await handler(event, context) ?? result;
		return result as any;
	};
	const markerFor = async (sessionId: string) => {
		const result = await emit("context", { messages: [{ role: "user", content: "task" }] }, ctx(sessionId));
		return result.messages.find((message: any) => message.customType === "pibox-system-prompt-request").content as string;
	};

	await emit("session_start", { reason: "startup" }, ctx("session-a"));
	const markerA = await markerFor("session-a");
	const first = await emit("before_provider_request", {
		payload: { messages: [{ role: "system", content: "BASE" }, { role: "user", content: markerA }, { role: "user", content: "task" }] },
	}, ctx("session-a"));
	assert.match(first.messages[0].content, /SESSION session-a/);

	await emit("session_shutdown", { reason: "new" }, ctx("session-a"));
	assert.equal(await emit("context", { messages: [{ role: "user", content: "task" }] }, ctx("session-a")), undefined);
	await emit("session_start", { reason: "new" }, ctx("session-b"));
	const markerB = await markerFor("session-b");
	assert.notEqual(markerB, markerA);
	const second = await emit("before_provider_request", {
		payload: { messages: [{ role: "system", content: "BASE" }, { role: "user", content: markerB }, { role: "user", content: "task" }] },
	}, ctx("session-b"));
	assert.match(second.messages[0].content, /SESSION session-b/);
	assert.doesNotMatch(second.messages[0].content, /session-a/);

	const failed = await emit("before_provider_request", { payload: { prompt: markerB } }, ctx("session-b", "custom-api"));
	assert.deepEqual(failed, { __pibox_system_prompt_error: "Unsupported custom-api provider payload shape" }, "invalid replacement makes swallowed hook errors fail closed at provider boundary");
});
