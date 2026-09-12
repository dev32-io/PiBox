import { appendFileSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TOOL = "workflow_e2e_report";
let gateReleased = false;

function message(model: Model<Api>): AssistantMessage {
	return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
		usage: { input: 3, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "pending", timestamp: Date.now() };
}

export default function e2eReportProvider(pi: ExtensionAPI): void {
	pi.registerProvider("pibox-e2e-report-test", {
		name: "Offline E2E report tool fixture", baseUrl: "http://127.0.0.1.invalid", apiKey: "fixture-key", api: "pibox-e2e-report-test-api" as Api,
		models: [{ id: "fixture-model", name: "E2E report fixture", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_000_000, maxTokens: 4_000_000 }],
		streamSimple(model: Model<Api>, context: Context) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				const output = message(model);
				stream.push({ type: "start", partial: output });
				try {
					if (process.env.PIBOX_REPORT_FIXTURE_OMIT_REPORT === "1") {
						const text = "Evaluator stopped without submitting a report.";
						output.content.push({ type: "text", text });
						stream.push({ type: "text_start", contentIndex: 0, partial: output });
						stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
						stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
						output.stopReason = "stop"; stream.push({ type: "done", reason: "stop", message: output });
						stream.end(); return;
					}
					if (!gateReleased && process.env.PIBOX_REPORT_FIXTURE_PAUSE_PORT) {
						await new Promise<void>((resolve, reject) => {
							const socket = createConnection({ host: "127.0.0.1", port: Number(process.env.PIBOX_REPORT_FIXTURE_PAUSE_PORT) });
							socket.once("data", () => { socket.end(); resolve(); }); socket.once("error", reject);
						});
						gateReleased = true;
					}
					const lastUser = context.messages.length - 1 - [...context.messages].reverse().findIndex((entry) => entry.role === "user");
					const results = context.messages.slice(lastUser + 1).filter((entry): entry is Extract<Context["messages"][number], { role: "toolResult" }> => entry.role === "toolResult" && entry.toolName === TOOL);
					if (!context.tools?.some((tool) => tool.name === TOOL)) throw new Error("Managed E2E report tool was not advertised to the real Pi model");
					if (results.length < 2) {
						const args = results.length === 0
							? { cases: [{ case: "E2E-001", verdict: "invalid" }] }
							: JSON.parse(readFileSync(process.env.PIBOX_REPORT_FIXTURE_INPUT!, "utf8"));
						if (results.length === 1 && !results[0]!.isError) throw new Error("Invalid report arguments unexpectedly succeeded");
						const toolCall = { type: "toolCall" as const, id: `report-${process.env.PIBOX_WORKFLOW_ATTEMPT_TOKEN}-${results.length}`, name: TOOL, arguments: args };
						output.content.push(toolCall);
						stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
						stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: output });
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
						output.stopReason = "toolUse"; stream.push({ type: "done", reason: "toolUse", message: output });
					} else {
						if (results[1]!.isError) throw new Error(`Valid report submission failed: ${JSON.stringify(results[1])}`);
						if (process.env.PIBOX_REPORT_FIXTURE_MARKER) appendFileSync(process.env.PIBOX_REPORT_FIXTURE_MARKER, `${JSON.stringify({ token: process.env.PIBOX_WORKFLOW_ATTEMPT_TOKEN, rejectedInvalid: true, submitted: true })}\n`);
						const text = "Report submitted through the tool. This final prose is deliberately NOT JSON.";
						output.content.push({ type: "text", text });
						stream.push({ type: "text_start", contentIndex: 0, partial: output });
						stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
						stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
						output.stopReason = "stop"; stream.push({ type: "done", reason: "stop", message: output });
					}
				} catch (error) {
					output.stopReason = "error"; output.errorMessage = error instanceof Error ? error.message : String(error);
					stream.push({ type: "error", reason: "error", error: output });
				}
				stream.end();
			});
			return stream;
		},
	});
}
