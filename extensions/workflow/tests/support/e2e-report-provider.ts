import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readE2eWorkspaceHandoff } from "../../../e2e-workspace/workspace.js";

const TOOL = "e2e_workspace";
let gateReleased = false;
function message(model: Model<Api>): AssistantMessage {
	return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
		usage: { input: 3, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "pending", timestamp: Date.now() };
}
function textOf(result: Extract<Context["messages"][number], { role: "toolResult" }>): string {
	return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

export default function e2eReportProvider(pi: ExtensionAPI): void {
	let rejectedInvalid = false;
	let deduplicated = false;
	let initText = "";
	pi.on("tool_result", async (event) => {
		if (event.toolName !== TOOL) return;
		const action = (event.input as { action?: string }).action;
		if (action === "init") initText = event.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		if (action === "report" && event.isError) rejectedInvalid = true;
		if (action === "evidence" && !event.isError && (event.details as { deduplicated?: boolean } | undefined)?.deduplicated) deduplicated = true;
		if (action !== "report" || event.isError) return;
		const snapshot = await readE2eWorkspaceHandoff(process.env.PIBOX_SUBAGENT_REPORT_PATH!);
		if (!snapshot) throw new Error("Successful report call did not persist a current-attempt handoff");
		if (process.env.PIBOX_REPORT_FIXTURE_MARKER) appendFileSync(process.env.PIBOX_REPORT_FIXTURE_MARKER, `${JSON.stringify({ token: process.env.PIBOX_WORKFLOW_ATTEMPT_TOKEN, rejectedInvalid, deduplicated, initText, submitted: true, reference: snapshot.reference, reportPath: snapshot.reportPath, workspaceRoot: snapshot.workspaceRoot, evidence: snapshot.evidence })}\n`);
	});
	pi.registerProvider("pibox-e2e-report-test", {
		name: "Offline E2E workspace fixture", baseUrl: "http://127.0.0.1.invalid", apiKey: "fixture-key", api: "pibox-e2e-report-test-api" as Api,
		models: [{ id: "fixture-model", name: "E2E workspace fixture", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_000_000, maxTokens: 4_000_000 }],
		streamSimple(model: Model<Api>, context: Context) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				const output = message(model);
				stream.push({ type: "start", partial: output });
				const finish = (text: string) => {
					output.content.push({ type: "text", text });
					stream.push({ type: "text_start", contentIndex: 0, partial: output });
					stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
					stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
					output.stopReason = "stop"; stream.push({ type: "done", reason: "stop", message: output });
				};
				try {
					if (process.env.PIBOX_REPORT_FIXTURE_OMIT_REPORT === "1") {
						finish("Evaluator stopped without submitting a report."); stream.end(); return;
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
					if (!context.tools?.some((tool) => tool.name === TOOL)) throw new Error("E2E workspace tool was not advertised to the real Pi model");
					if (context.tools.some((tool) => tool.name === "workflow_e2e_report")) throw new Error("Obsolete workflow report tool is still advertised");
					const index = results.length;
					for (const [position, result] of results.entries()) {
						if (position === 3 ? !result.isError : result.isError) throw new Error(`Unexpected workspace result at step ${position}: ${textOf(result)}`);
					}
					if (index < 5) {
						let args: Record<string, unknown>;
						if (index === 0) args = { action: "init" };
						else if (index === 1 || index === 2) {
							const directory = textOf(results[0]!).match(/Output directory: ([^\r\n]+)/)?.[1];
							if (!directory) throw new Error("Workspace init did not expose its owned output directory");
							const source = join(directory, "selected-witness.log");
							if (index === 1) writeFileSync(source, process.env.PIBOX_REPORT_FIXTURE_EVIDENCE_TEXT ?? "Selected standalone witness π🙂\n");
							args = { action: "evidence", path: source, reason: "Minimal fixture witness for this evaluation's observed result." };
						} else if (index === 3) args = { action: "report", report: { cases: [{ case: "E2E-001", verdict: "invalid" }] } };
						else {
							if (!textOf(results[2]!).includes("already retained")) throw new Error("Duplicate evidence was copied again");
							const reference = textOf(results[1]!).match(/Evidence retained: ([^\r\n]+)/)?.[1];
							if (!reference) throw new Error("Evidence retention did not return a usable reference");
							const report = JSON.parse(readFileSync(process.env.PIBOX_REPORT_FIXTURE_INPUT!, "utf8"));
							report.cases[0].evidence = [reference];
							args = { action: "report", report };
						}
						const toolCall = { type: "toolCall" as const, id: `workspace-${process.env.PIBOX_WORKFLOW_ATTEMPT_TOKEN ?? "standalone"}-${index}`, name: TOOL, arguments: args };
						output.content.push(toolCall);
						stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
						stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: output });
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
						output.stopReason = "toolUse"; stream.push({ type: "done", reason: "toolUse", message: output });
					} else {
						finish("Workspace report submitted. This final prose is deliberately NOT JSON.");
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
