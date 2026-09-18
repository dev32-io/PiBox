import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isSubagentRuntime } from "../core/runtime-role.js";
import { registerSystemPromptContribution } from "../core/system-prompt.js";
import { SUBAGENT_REPORT_PATH_ENV } from "../subagent/report-bridge.js";
import { PIBOX_SUBAGENT_AGENT_ENV } from "../subagent/invocation.js";
import {
	createE2eEvaluation,
	createE2eWorkspace,
	retainE2eEvidence,
	restoreE2eWorkspace,
	submitE2eWorkspaceReport,
	type E2eEvaluation,
	type E2eReportInput,
	type E2eWorkspace,
	type E2eWorkspaceBinding,
} from "./workspace.js";

export const E2E_WORKSPACE_ENTRY_TYPE = "pibox-e2e-workspace-v1";
interface Entry { schemaVersion: 1; binding: E2eWorkspaceBinding }

function restoredBinding(ctx: Pick<ExtensionContext, "sessionManager">): E2eWorkspaceBinding | undefined {
	const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== E2E_WORKSPACE_ENTRY_TYPE || !entry.data || typeof entry.data !== "object") continue;
		const value = entry.data as Partial<Entry>;
		if (value.schemaVersion === 1 && value.binding && typeof value.binding.workspaceId === "string" && typeof value.binding.sessionId === "string") return { ...value.binding };
	}
	return undefined;
}

export default function e2eWorkspaceExtension(pi: ExtensionAPI): void {
	if (!isSubagentRuntime(process.env) || process.env[PIBOX_SUBAGENT_AGENT_ENV] !== "e2e-tester") return;
	let ctx: ExtensionContext | undefined;
	let binding: E2eWorkspaceBinding | undefined;
	let workspace: E2eWorkspace | undefined;
	let evaluation: E2eEvaluation | undefined;
	let unavailable: string | undefined;
	const sessionId = () => { if (!ctx) throw new Error("E2E workspace is not bound to an active child session"); return ctx.sessionManager.getSessionId(); };
	const attach = async (): Promise<E2eWorkspace | undefined> => {
		if (!binding) return undefined;
		if (binding.sessionId !== sessionId()) { unavailable = "Saved workspace belongs to another Pi session; forks and new agents do not inherit it"; return undefined; }
		try { workspace = await restoreE2eWorkspace({ binding }); unavailable = undefined; return workspace; }
		catch (error) { workspace = undefined; evaluation = undefined; unavailable = error instanceof Error ? error.message : String(error); return undefined; }
	};
	const activeEvaluation = async () => {
		const current = await attach();
		if (!current) throw new Error(unavailable ? `Saved E2E workspace is unavailable: ${unavailable}. Call status, then init for a fresh workspace.` : "No E2E workspace exists. Call init first.");
		return evaluation ??= await createE2eEvaluation({ workspace: current });
	};

	pi.registerTool({
		name: "e2e_workspace",
		label: "E2E Workspace",
		description: "Manage this e2e-tester session's private temporary evaluation workspace. status inspects availability without creating storage. Same-session resume restores its workspace; forks stay isolated. init prepares this invocation's distinct evaluation (repeat calls reuse it) and returns owned outputDirectory for captures; finalized evaluations are immutable. evidence retains one useful supported passive text/log/JSON/screenshot file from that directory with a reason. Keep only smallest sufficient sanitized witness; summarize routine passes inline. Never retain directories, globs, repositories, build trees, dependencies, databases, caches, full logs, or one forced file per case. report writes authoritative report.json with cited evidence and ends this evaluation; no second verdict or report destination needed. /tmp retention is best effort and continuity loss is reported when saved storage is missing or invalid.",
		parameters: Type.Object({
			action: StringEnum(["status", "init", "evidence", "report"] as const),
			path: Type.Optional(Type.String({ description: "For evidence: one file in outputDirectory, by filename or exact path" })),
			reason: Type.Optional(Type.String({ description: "For evidence: short reason this file is necessary proof" })),
			report: Type.Optional(Type.Unknown({ description: "For action=report: {cases:[{case:string,verdict:'passed'|'failed'|'blocked',steps?:string[],expected?:string,observed?:string,evidence?:string[],notes?:string}],summary?:string,findings?:[{summary:string,severity?:'minor'|'major'|'critical'}]}. Include every assigned case once. Evidence strings must be references returned by action=evidence. Harness derives overall result; omitted finding severity means major." })),
		}, { additionalProperties: false }),
		async execute(_id, params): Promise<any> {
			if (params.action === "status") {
				const current = await attach();
				return { content: [{ type: "text", text: current ? `E2E workspace available. /tmp retention is best effort.${evaluation ? `\nRun: ${evaluation.runId}\nOutput directory: ${evaluation.outputDirectory}` : "\nCall init to begin a distinct evaluation."}` : unavailable ? `Saved E2E workspace unavailable: ${unavailable}\nContinuity was not recreated. Call init to start fresh.` : "No E2E workspace exists. Call init to create one." }], details: { available: Boolean(current), ...(evaluation ? { runId: evaluation.runId, outputDirectory: evaluation.outputDirectory } : {}) } };
			}
			if (params.action === "init") {
				let current = await attach();
				const continuityLoss = current ? undefined : unavailable;
				if (!current) { current = await createE2eWorkspace({ sessionId: sessionId() }); binding = current.binding; workspace = current; evaluation = undefined; unavailable = undefined; pi.appendEntry(E2E_WORKSPACE_ENTRY_TYPE, { schemaVersion: 1, binding }); }
				const run = await activeEvaluation();
				return { content: [{ type: "text", text: `${continuityLoss ? `Saved E2E workspace continuity was lost: ${continuityLoss}\nFresh workspace created; prior unfinished data is unavailable.\n` : ""}Evaluation ready as a distinct immutable-on-finalization snapshot. Write only curated candidate captures here, then retain useful individual files with action=evidence.\nOutput directory: ${run.outputDirectory}\nNo evidence file is required for routine passing cases.` }], details: { available: true, ...(continuityLoss ? { continuityLost: true } : {}), workspaceId: current.binding.workspaceId, runId: run.runId, outputDirectory: run.outputDirectory } };
			}
			if (params.action === "evidence") {
				if (!params.path || !params.reason) throw new Error("evidence requires path and reason");
				const run = await activeEvaluation();
				const retained = await retainE2eEvidence({ evaluation: run, sourcePath: params.path, reason: params.reason });
				return { content: [{ type: "text", text: `${retained.deduplicated ? "Evidence already retained" : "Evidence retained"}: ${retained.reference}\nEvaluation total: ${retained.retainedFiles} file(s), ${retained.retainedBytes} bytes. Reuse this reference in report cases.` }], details: retained };
			}
			if (!params.report) throw new Error("report requires report object");
			const run = await activeEvaluation();
			const nativeReportPath = process.env[SUBAGENT_REPORT_PATH_ENV];
			if (!nativeReportPath) throw new Error("report requires harness-managed native report path");
			const submitted = await submitE2eWorkspaceReport({ evaluation: run, submission: params.report as E2eReportInput, nativeReportPath });
			return { content: [{ type: "text", text: `E2E snapshot finalized: ${submitted.reportPath}\nResult: ${submitted.report.result}; referenced evidence: ${submitted.evidence.length} file(s), ${submitted.evidence.reduce((sum, item) => sum + item.bytes, 0)} bytes.` }], details: { reference: submitted.reference, reportPath: submitted.reportPath, evidenceFiles: submitted.evidence.length, evidenceBytes: submitted.evidence.reduce((sum, item) => sum + item.bytes, 0) }, terminate: true };
		},
	});

	registerSystemPromptContribution(pi, {
		id: "e2e-workspace",
		order: 200,
		async render() {
			const current = await attach();
			if (!current) return unavailable
				? `Saved E2E workspace unavailable: ${unavailable}\nContinuity was not recreated. Call e2e_workspace init to start fresh.`
				: "No E2E workspace exists. Call e2e_workspace init before writing evaluation output.";
			return [
				"E2E workspace is private temporary storage; /tmp retention is best effort only.",
				`Root: ${current.root}`,
				...(evaluation ? [
					`Output directory: ${evaluation.outputDirectory}`,
					`Evidence directory (tool-managed): ${evaluation.evidenceDirectory}`,
					`Report (tool-managed): ${evaluation.reportPath}`,
					"Use e2e_workspace evidence to retain selected proof and e2e_workspace report to finalize the evaluation.",
				] : ["Call e2e_workspace init to begin this invocation's distinct evaluation."]),
			].join("\n");
		},
	});

	const restore = (next: ExtensionContext) => { ctx = next; binding = restoredBinding(next); workspace = undefined; evaluation = undefined; unavailable = undefined; };
	pi.on("session_start", (_event, next) => restore(next));
	pi.on("session_tree", (_event, next) => restore(next));
	pi.on("session_shutdown", () => { ctx = undefined; binding = undefined; workspace = undefined; evaluation = undefined; unavailable = undefined; });
}

export * from "./workspace.js";
