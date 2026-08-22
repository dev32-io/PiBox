import { HarnessError } from "./errors.js";
import type { EvaluationHandoff } from "./run-store.js";

/** Keep the human-readable merge line and structured verdict from contradicting each other. */
export function validateManagedEvaluationReport(report: string, verdict: EvaluationHandoff["verdict"]): void {
	const firstLine = report.split("\n").find((line) => line.trim())?.trim();
	if (!firstLine || !["MERGE: YES", "MERGE: YES_WITH_RISK", "MERGE: NO"].includes(firstLine)) throw new HarnessError("INVALID_HANDOFF", "Managed evaluation report must begin with an exact MERGE verdict line");
	if (verdict === "pass" && firstLine === "MERGE: NO") throw new HarnessError("INVALID_HANDOFF", "A passing evaluation cannot report MERGE: NO");
	if ((verdict === "fail" || verdict === "blocked") && firstLine !== "MERGE: NO") throw new HarnessError("INVALID_HANDOFF", `A ${verdict} evaluation must report MERGE: NO`);
}
