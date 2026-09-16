import { dirname, join } from "node:path";
import { readE2eWorkspaceHandoff, type E2eWorkspaceReportReference, type E2eWorkspaceReportResult } from "../e2e-workspace/workspace.js";

export type StandaloneE2eReceipt =
	| { readonly state: "unavailable" | "error" }
	| {
		readonly state: "validated";
		readonly outcome: "passed" | "failed" | "blocked";
		readonly critical: boolean;
		readonly cases: Readonly<Record<"passed" | "failed" | "blocked", number>>;
		readonly findings: Readonly<Record<"critical" | "major" | "minor", number>>;
		readonly reportPath: string;
		readonly evidenceCount: number;
		readonly evidencePath: string;
		readonly reference: E2eWorkspaceReportReference;
	};

export async function readStandaloneE2eReceipt(nativeReportPath: string | undefined): Promise<StandaloneE2eReceipt> {
	if (!nativeReportPath) return { state: "unavailable" };
	try {
		const workspace = await readE2eWorkspaceHandoff(nativeReportPath);
		return workspace ? receiptFor(workspace) : { state: "unavailable" };
	} catch {
		return { state: "error" };
	}
}

export function formatStandaloneE2eReceipt(receipt: StandaloneE2eReceipt): string {
	if (receipt.state !== "validated") return `E2E report: ${receipt.state}.`;
	const critical = receipt.critical ? " (critical)" : "";
	return [
		`E2E outcome: ${receipt.outcome}${critical}`,
		`Cases: ${receipt.cases.passed} passed · ${receipt.cases.failed} failed · ${receipt.cases.blocked} blocked`,
		`Findings: ${receipt.findings.critical} critical · ${receipt.findings.major} major · ${receipt.findings.minor} minor`,
		`Report: ${receipt.reportPath}`,
		`Evidence: ${receipt.evidenceCount} retained · ${receipt.evidencePath}`,
		`Use read/grep on ${receipt.reportPath} for full authoritative report.`,
	].join("\n");
}

function receiptFor(workspace: E2eWorkspaceReportResult): StandaloneE2eReceipt {
	const cases = { passed: 0, failed: 0, blocked: 0 };
	for (const result of workspace.report.caseResults) cases[result.status]++;
	const findings = { critical: 0, major: 0, minor: 0 };
	for (const finding of workspace.report.findings ?? []) findings[finding.severity ?? "major"]++;
	const critical = workspace.report.result === "critical";
	const outcome = workspace.report.result === "passed" ? "passed" : workspace.report.result === "needs_user" ? "blocked" : "failed";
	return {
		state: "validated", outcome, critical, cases, findings,
		reportPath: workspace.reportPath,
		evidenceCount: workspace.evidence.length,
		evidencePath: join(dirname(workspace.reportPath), "evidence"),
		reference: workspace.reference,
	};
}
