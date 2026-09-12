import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const action = process.env.LOOP_ACTION;
const run = Number(process.env.LOOP_RUN ?? "1");
const reportPath = process.env.PIBOX_SUBAGENT_REPORT_PATH;
const eventFd = Number(process.env.PIBOX_SUBAGENT_EVENT_FD ?? 3);
if (!action || !reportPath) throw new Error("missing deterministic loop fixture environment");

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
let result;
if (action === "task-launch") {
	writeFileSync("delivered.txt", "delivered\n");
	git("add", "delivered.txt");
	git("commit", "-qm", "deliver fixture");
	result = "implemented";
} else if (action.endsWith("-fix")) {
	const file = `repair-${action}-${run}.txt`;
	writeFileSync(file, `${action} ${run}\n`);
	git("add", file);
	git("commit", "-qm", `${action} ${run}`);
	result = "repaired";
} else if (["review", "final-review", "e2e"].includes(action) && run <= 2) {
	result = JSON.stringify({ result: "repairable", summary: `${action} failure ${run}`, findings: [{ id: `${action}-${run}`, severity: "major", code: "fixture", summary: `repair ${action} ${run}` }], evidenceRefs: [] });
} else if (action === "e2e") {
	const evidence = join(process.cwd(), "agent-artifacts", "example", "evidence", "loop.txt");
	mkdirSync(dirname(evidence), { recursive: true });
	writeFileSync(evidence, "all E2E cases passed\n");
	result = JSON.stringify({ result: "passed", summary: "E2E passed", findings: [], evidenceRefs: ["evidence/loop.txt"] });
} else {
	result = JSON.stringify({ result: "passed", summary: `${action} passed`, findings: [] });
}

if (action === "e2e") {
	const terminal = JSON.parse(result);
	const evidenceRef = `evidence/e2e-run-${run}.json`;
	const evidence = join(process.cwd(), "agent-artifacts", "example", evidenceRef);
	mkdirSync(dirname(evidence), { recursive: true });
	const observedStatus = run <= 2 ? "blocked" : "passed";
	// Rich report content intentionally differs from the small terminal control reply.
	writeFileSync(evidence, `${JSON.stringify({
		result: observedStatus,
		summary: terminal.summary,
		caseResults: [{ caseId: "E2E-001", status: observedStatus, executedActions: ["Read the delivered result"], observations: [terminal.summary], evidenceRefs: [evidenceRef] }],
		findings: run <= 2 ? [terminal.summary] : [],
	}, null, 2)}\n`);
	terminal.evidenceRefs = [...(terminal.evidenceRefs ?? []), evidenceRef];
	result = JSON.stringify(terminal);
}

writeFileSync(reportPath, result, { mode: 0o600 });
if (action === "task-launch" || action.endsWith("-fix")) {
	writeFileSync(join(dirname(reportPath), "workflow-ledger.json"), `${JSON.stringify({ summary: `ledger submission from ${action} ${run}`, evidence: [] })}\n`, { mode: 0o600 });
}
const event = { type: "message_end", message: { role: "assistant", stopReason: "stop" }, report: { bytes: Buffer.byteLength(result), sha256: createHash("sha256").update(result).digest("hex") } };
writeSync(eventFd, `${JSON.stringify(event)}\n${JSON.stringify({ type: "agent_settled" })}\n`);
