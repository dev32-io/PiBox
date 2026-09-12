import { createHash } from "node:crypto";
import { appendFileSync, rmSync, writeFileSync, writeSync } from "node:fs";

const mode = process.argv[2] ?? "success";
const prompt = process.env.FAKE_PROMPT ?? "prompt";
const transcript = process.env.FAKE_TRANSCRIPT;
const signalLog = process.env.FAKE_SIGNAL_LOG;
const reportPath = process.env.PIBOX_SUBAGENT_REPORT_PATH;
const eventFd = Number(process.env.PIBOX_SUBAGENT_EVENT_FD ?? 3);
const channel = (value, newline = true) => writeSync(eventFd, `${JSON.stringify(value)}${newline ? "\n" : ""}`);
const emit = (value, newline = true) => {
	process.stdout.write(`${JSON.stringify(value)}${newline ? "\n" : ""}`);
	if (value.type === "message_end" && value.message?.role === "assistant" && Array.isArray(value.message.content)) {
		const text = value.message.content.flatMap((part) => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
		if (reportPath) writeFileSync(reportPath, text, { mode: 0o600 });
		channel({
			type: "message_end",
			message: { role: "assistant", ...(value.message.stopReason ? { stopReason: value.message.stopReason } : {}), ...(value.message.errorMessage ? { errorMessage: value.message.errorMessage } : {}) },
			report: { bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") },
		}, newline);
		return;
	}
	channel(value, newline);
};

if (transcript) appendFileSync(transcript, `${JSON.stringify({ type: "fake_turn", prompt })}\n`, { mode: 0o600 });

switch (mode) {
	case "success":
	case "success-partial":
		emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "display draft" } });
		if (mode === "success-partial" && reportPath) writeFileSync(`${reportPath}.tmp-stale`, "partial", { mode: 0o600 });
		emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "final answer" }] } });
		emit({ type: "agent_settled" });
		break;
	case "progress":
		emit({ type: "tool_execution_start", toolName: "read" });
		emit({ type: "tool_execution_end", toolName: "read", isError: false });
		emit({ type: "turn_end", message: { usage: { input: 100, output: 25, reasoning: 5, cacheRead: 40, cacheWrite: 10, totalTokens: 180 } } });
		emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "progress answer" }] } });
		emit({ type: "agent_settled" });
		break;
	case "authoritative":
		emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "not authoritative" } });
		emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first final" }] } });
		emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "authoritative final" }] } });
		emit({ type: "agent_settled" });
		break;
	case "malformed":
		writeSync(eventFd, "{not-json}\n");
		emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered" }] } });
		emit({ type: "agent_settled" });
		break;
	case "partial":
		emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial final" }] } });
		emit({ type: "agent_settled" }, false);
		break;
	case "continuation":
		emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `reply:${prompt}` }] } });
		emit({ type: "agent_settled" });
		break;
	case "report-error":
		channel({ type: "report_error", error: "simulated write failure" });
		emit({ type: "agent_settled" });
		break;
	case "missing-report":
		emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "vanished" }] } });
		if (reportPath) rmSync(reportPath, { force: true });
		emit({ type: "agent_settled" });
		break;
	case "empty":
		break;
	case "missing-final":
		emit({ type: "agent_settled" });
		break;
	case "missing-settlement":
		emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "unsettled" }] } });
		break;
	case "noisy-error":
		process.stderr.write("x".repeat(4_096));
		process.exitCode = 1;
		break;
	case "wait":
	case "ignore-term": {
		process.on("SIGTERM", () => {
			if (signalLog) appendFileSync(signalLog, "SIGTERM\n");
			if (mode === "wait") process.exit(0);
		});
		emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ready" } });
		setInterval(() => {}, 1_000);
		break;
	}
	default:
		process.stderr.write(`unknown fake mode: ${mode}\n`);
		process.exitCode = 2;
}
