import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type JsonObject } from "@earendil-works/pi-ai";
import { createCodemodeExtension, createToolSearchExtension, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { awaitNativeMcpReady, nativeMcpExtensionPaths, nativeMcpIdentity } from "../../native-mcp.js";

/** Deterministic offline actor; fixture steps are disposable test data, never user prompts. */
export default function nativeMcpProvider(pi: ExtensionAPI): void {
	const steps = JSON.parse(readFileSync(process.env.PIBOX_MCP_TEST_STEPS!, "utf8")) as Array<{ name: string; arguments: JsonObject }>;
	const calls: Array<{ name: string; parent?: string }> = [];
	const schemas: unknown[] = [];
	const systems: string[] = [];
	const gatewayFault = process.env.PIBOX_MCP_TEST_GATEWAY;
	let beforePromptNativeCount = 0;
	if (gatewayFault === "replaced") {
		for (const name of ["codemode", "tool_search"]) pi.registerTool({ name, label: "Non-native fixture", description: "Non-native discovery replacement", parameters: Type.Object({}), async execute() { throw new Error("Non-native replacement must not execute"); } });
	}
	if (gatewayFault) {
		// Exercise withdrawal of pre-existing tools as well as registrations arriving
		// after the failed prompt. Repairing discovery is not itself a native reload.
		pi.on("session_start", async () => {
			if (process.env.PIBOX_MCP_TEST_PRECONNECTED === "1") {
				for (let i = 0; i < 200 && !pi.getAllTools().some((tool) => tool.name === "read_mcp_resource"); i++) await new Promise((resolve) => setTimeout(resolve, 25));
			}
			beforePromptNativeCount = pi.getAllTools().filter((tool) => tool.name.startsWith("mcp__") || tool.name === "read_mcp_resource").length;
		});
		let restored = false;
		pi.on("tool_result", async (event) => {
			if (event.toolName !== "read" || restored) return;
			restored = true;
			await createCodemodeExtension()(pi);
			await createToolSearchExtension()(pi);
			pi.setActiveTools([...pi.getActiveTools(), "codemode", "tool_search"]);
			await new Promise((resolve) => setTimeout(resolve, 700));
		});
	}
	pi.registerTool({ name: "ungranted_extension", label: "Ungrantable fixture", description: "Ordinary excluded fixture tool", exposure: "codemode", parameters: Type.Object({}), async execute() { throw new Error("Ungrantable fixture dispatched"); } });
	pi.on("tool_call", (event) => { calls.push({ name: event.toolName, ...(event.parentToolCallId ? { parent: event.parentToolCallId } : {}) }); });
	pi.registerProvider("pibox-native-mcp-test", {
		baseUrl: "https://offline.invalid", apiKey: "fixture", api: "pibox-native-mcp-test",
		models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				const results = context.messages.filter((message) => message.role === "toolResult");
				// Let the deterministic server's list-changed notification arrive between turns.
				if (results.length) await new Promise((resolve) => setTimeout(resolve, 100));
				schemas.push(getCurrentTools(context.messages));
				systems.push(JSON.stringify(context.messages.filter((message) => message.role === "system")));
				const output: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "pending", timestamp: Date.now() };
				stream.push({ type: "start", partial: output });
				const step = steps[results.length];
				if (step) {
					const toolCall = { type: "toolCall" as const, id: `native-${results.length}`, ...step };
					output.content.push(toolCall);
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
					output.stopReason = "toolUse";
					stream.push({ type: "done", reason: "toolUse", message: output });
				} else {
					const registry = pi.getAllTools();
					let readinessError: string | undefined;
					if (gatewayFault) try { await awaitNativeMcpReady(); } catch (error) { readinessError = String(error); }
					const text = JSON.stringify({ registry, schemas, systems, version: VERSION, calls, results, readinessError, beforePromptNativeCount, nativePaths: nativeMcpExtensionPaths(), mcpCommands: pi.getCommands().filter((command) => command.name === "mcp").length, identities: registry.map(({ name }) => ({ name, identity: nativeMcpIdentity(name) })) });
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
