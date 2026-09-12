import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PROVIDER = "pibox-real-cli-test";
const MODEL = "fixture-model";
const TOOL = "oversized_fixture_tool";

function message(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 3,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 8,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function streamFixture(model: Model<Api>, context: Context, _options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const output = message(model);
		stream.push({ type: "start", partial: output });
		const toolAlreadyRan = context.messages.some((candidate) => candidate.role === "toolResult" && candidate.toolName === TOOL);
		if (!toolAlreadyRan && process.env.PIBOX_REAL_PI_TOOL_MARKER) {
			const user = [...context.messages].reverse().find((candidate) => candidate.role === "user");
			const prompt = !user ? "" : typeof user.content === "string"
				? user.content
				: user.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			appendFileSync(process.env.PIBOX_REAL_PI_TOOL_MARKER, `${JSON.stringify({
				promptBytes: Buffer.byteLength(prompt),
				promptSha256: createHash("sha256").update(prompt).digest("hex"),
				stableContextPresent: context.systemPrompt?.includes("Stable context survives file transport: π🙂") === true,
			})}\n`);
		}
		if (!toolAlreadyRan) {
			const toolCall = { type: "toolCall" as const, id: "fixture-call-1", name: TOOL, arguments: { value: "selected" } };
			output.content.push(toolCall);
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
			stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "{\"value\":\"selected\"}", partial: output });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
			output.stopReason = "toolUse";
			stream.push({ type: "done", reason: "toolUse", message: output });
			stream.end();
			return;
		}

		const text = `${"real-pi-final-🙂".repeat(90_000)}\nREAL_PI_FINAL_SENTINEL`;
		output.content.push({ type: "text", text });
		stream.push({ type: "text_start", contentIndex: 0, partial: output });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
		output.stopReason = "stop";
		stream.push({ type: "done", reason: "stop", message: output });
		stream.end();
	});
	return stream;
}

export default function realPiProvider(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL,
		label: "Oversized Fixture Tool",
		description: "Return deterministic oversized fixture output",
		parameters: Type.Object({ value: Type.String() }),
		async execute(_id, params) {
			if (process.env.PIBOX_REAL_PI_TOOL_MARKER) appendFileSync(process.env.PIBOX_REAL_PI_TOOL_MARKER, `${params.value}\n`);
			const text = `${"real-pi-tool-native-event-🙂".repeat(80_000)}\nREAL_PI_TOOL_SENTINEL`;
			return { content: [{ type: "text" as const, text }], details: { selected: params.value, nativePayload: text } };
		},
	});
	pi.registerProvider(PROVIDER, {
		name: "PiBox real CLI fixture",
		baseUrl: "http://127.0.0.1.invalid",
		apiKey: "fixture-key",
		api: "pibox-real-cli-test-api" as Api,
		models: [{
			id: MODEL,
			name: "PiBox fixture model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16_000_000,
			maxTokens: 4_000_000,
		}],
		streamSimple: streamFixture,
	});
}
