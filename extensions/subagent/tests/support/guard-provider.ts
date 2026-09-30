import { createAssistantMessageEventStream, type Api, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Offline actor: real Bash plus a local MCP stand-in, never network or auth. */
export default function guardProvider(pi: ExtensionAPI): void {
	pi.registerTool({ name: "mcp", label: "Fixture MCP", description: "Offline guard witness", parameters: Type.Object({}, { additionalProperties: true }),
		async execute(_id, input) { return { content: [{ type: "text", text: JSON.stringify(input) }], details: {} }; },
	});
	pi.registerProvider("pibox-guard-test", {
		baseUrl: "https://offline.invalid", apiKey: "fixture-key", api: "pibox-guard-test" as Api,
		models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const output: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "pending", timestamp: Date.now() };
				stream.push({ type: "start", partial: output });
				const results = context.messages.filter((message) => message.role === "toolResult");
				if (results.length === 0) {
					const calls = [
						{ name: "bash", arguments: { command: "echo allowed > allowed.txt" } },
						{ name: "bash", arguments: { command: "echo denied > denied.txt" } },
						{ name: "bash", arguments: { command: "echo asked > asked.txt" } },
						{ name: "mcp", arguments: { tool: "test" } },
						{ name: "mcp", arguments: { tool: "test", server: "other" } },
						{ name: "mcp", arguments: { action: "install", server: "playwright", url: "https://other.invalid" } },
					];
					for (const [contentIndex, call] of calls.entries()) {
						const toolCall = { type: "toolCall" as const, id: `guard-${contentIndex}`, ...call };
						output.content.push(toolCall);
						stream.push({ type: "toolcall_start", contentIndex, partial: output });
						stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
					}
					output.stopReason = "toolUse";
					stream.push({ type: "done", reason: "toolUse", message: output });
				} else {
					const text = JSON.stringify({ results: results.map((message) => ({ id: message.toolCallId, error: message.isError, content: message.content })), tools: pi.getActiveTools(), permissionCommands: pi.getCommands().filter((command) => command.name === "permissions").length });
					output.content.push({ type: "text", text });
					stream.push({ type: "text_start", contentIndex: 0, partial: output });
					stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
					output.stopReason = "stop";
					stream.push({ type: "done", reason: "stop", message: output });
				}
				stream.end();
			});
			return stream;
		},
	});
}
