import { rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const extensionIndexes = process.argv.flatMap((value, index) => value === "--extension" ? [index + 1] : []);
const bridgePath = extensionIndexes.map((index) => process.argv[index]).find((path) => path?.endsWith("/extensions/subagent/report-bridge.ts"));
if (!bridgePath) throw new Error("production report bridge extension was not injected");

const handlers = new Map();
const pi = {
	on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
};
const bridge = (await import(pathToFileURL(bridgePath).href)).default;
bridge(pi);
const fire = async (name, event = {}) => {
	for (const handler of handlers.get(name) ?? []) await handler(event, {});
};
const native = async (value) => {
	const line = `${JSON.stringify(value)}\n`;
	if (!process.stdout.write(line)) await new Promise((resolve) => process.stdout.once("drain", resolve));
};

const mode = process.env.FAKE_PI_MODE ?? "oversized";
const longToolPayload = mode === "oversized" ? "tool-output-🙂".repeat(120_000) : "tool-output";
let prompt = process.argv.at(-1) ?? "";
for (const handler of handlers.get("input") ?? []) {
	const result = await handler({ text: prompt, source: "interactive" }, {});
	if (result?.action === "transform") prompt = result.text;
	if (result?.action === "handled") process.exit(0);
}
const finalText = process.env.FAKE_FINAL_TEXT ?? (mode === "continuation" ? `reply:${prompt}` : mode === "display-env" ? `display:${process.env.PIBOX_SUBAGENT_DISPLAY}` : `${"🙂中".repeat(300_000)}\n${"z".repeat(1_100_000)}`);

await fire("message_start", { message: { role: "assistant", content: [] } });
await fire("tool_execution_start", { toolCallId: "tool-🙂", toolName: "write", args: { path: "unicode-🙂.txt", content: longToolPayload } });
await native({ type: "tool_execution_start", toolName: "read", args: { payload: longToolPayload } });
await fire("tool_execution_end", { toolCallId: "tool-🙂", toolName: "write", result: { content: [{ type: "text", text: longToolPayload }, { type: "image", data: "private-image" }], details: { stderr: "private-stderr" } }, isError: false });
await native({ type: "tool_execution_end", toolName: "read", result: { content: longToolPayload }, isError: false });
await fire("message_end", { message: { role: "toolResult", content: [{ type: "text", text: longToolPayload }] } });
await native({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: longToolPayload }] } });
await fire("turn_end", { message: { usage: { input: 100, output: 25, cacheRead: 40, cacheWrite: 10, totalTokens: 175 }, content: longToolPayload }, toolResults: [{ content: longToolPayload }] });

if (mode === "malformed-channel") writeSync(3, "{malformed\n");
if (mode === "malformed-lifecycle-display-text") writeSync(3, '{"type":"turn_end","nested":{"type":"display"},broken\n');
if (mode === "malformed-display") {
	writeSync(3, '{"type":"display","frame":{broken}\n');
	writeSync(3, `{"type":"display","frame":"${"x".repeat(40 * 1024)}"}\n`);
}
if (mode === "report-error") rmSync(dirname(process.env.PIBOX_SUBAGENT_REPORT_PATH), { recursive: true, force: true });
const message = {
	role: "assistant",
	content: [{ type: "thinking", thinking: "private reasoning".repeat(100_000) }, { type: "text", text: finalText }],
	stopReason: mode === "assistant-error" ? "error" : "stop",
	...(mode === "assistant-error" ? { errorMessage: "provider failed" } : {}),
};
await fire("message_end", { message });
await native({ type: "message_end", message });
await native({ type: "agent_end", messages: [{ role: "toolResult", content: longToolPayload }, message] });
if (mode === "missing-report") rmSync(process.env.PIBOX_SUBAGENT_REPORT_PATH, { force: true });
if (mode !== "missing-settlement") await fire("agent_settled");
