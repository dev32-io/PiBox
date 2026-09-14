import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const action = process.env.LOOP_ACTION;
const run = Number(process.env.LOOP_RUN ?? "1");
const reportPath = process.env.PIBOX_SUBAGENT_REPORT_PATH;
const eventFd = Number(process.env.PIBOX_SUBAGENT_EVENT_FD ?? 3);
if (!action || !reportPath) throw new Error("missing deterministic loop fixture environment");
if (action === "e2e") throw new Error("E2E must use the real Pi report-tool fixture");

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
let result;
if (action === "task-launch") {
	writeFileSync("delivered.txt", "delivered\n");
	git("add", "delivered.txt");
	git("commit", "-qm", "deliver fixture");
	result = "implemented";
} else if (action.endsWith("-fix")) {
	const file = `repair-${action}-${run}.txt`;
	let receipt = `${action} ${run}\n`;
	if (action === "e2e-fix") {
		const prompt = readFileSync(process.env.LOOP_INPUT_PATH, "utf8");
		if (!prompt.includes(`FULL_E2E_DIAGNOSTIC_END_${run}`) || !prompt.includes(`CURRENT_E2E_FINDING_${run}`)) throw new Error("Current full E2E report and structured findings did not reach fixer entrance");
		const witnesses = [...new Set(prompt.match(/REPORT_WITNESS_\d+_[a-f0-9-]+/g) ?? [])];
		if (witnesses.length !== 1) throw new Error("Fixer must receive exactly the current evaluator witness, not stale report history");
		const currentReport = process.env.LOOP_E2E_REPORT_PATH;
		if (!currentReport || !prompt.includes(currentReport)) throw new Error("Workspace report path missing from fixer prompt");
		if (currentReport.startsWith(`${process.cwd()}/`)) throw new Error("Report is inside isolated repair worktree");
		const fullReport = readFileSync(currentReport, "utf8");
		if (!prompt.includes(fullReport)) throw new Error("Fixer did not receive exact full workspace report bytes");
		receipt += `${witnesses[0]}\n`;
	}
	writeFileSync(file, receipt);
	git("add", file);
	git("commit", "-qm", `${action} ${run}`);
	result = "repaired";
} else if (["review", "final-review"].includes(action) && run <= Number(process.env.LOOP_REVIEW_FAILURES ?? "2")) {
	result = JSON.stringify({ result: "repairable", summary: `${action} failure ${run}`, findings: [{ id: `${action}-${run}`, severity: "major", code: "fixture", summary: `repair ${action} ${run}` }], evidenceRefs: [] });
} else {
	result = JSON.stringify({ result: "passed", summary: `${action} passed`, findings: [] });
}

writeFileSync(reportPath, result, { mode: 0o600 });
if (action === "task-launch" || action.endsWith("-fix")) {
	writeFileSync(join(dirname(reportPath), "workflow-ledger.json"), `${JSON.stringify({ summary: `ledger submission from ${action} ${run}`, evidence: [] })}\n`, { mode: 0o600 });
}
const event = { type: "message_end", message: { role: "assistant", stopReason: "stop" }, report: { bytes: Buffer.byteLength(result), sha256: createHash("sha256").update(result).digest("hex") } };
writeSync(eventFd, `${JSON.stringify(event)}\n${JSON.stringify({ type: "agent_settled" })}\n`);
