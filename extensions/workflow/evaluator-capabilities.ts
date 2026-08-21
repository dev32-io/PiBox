import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { describeHarnessError, HarnessError } from "./errors.js";
import { discoverRepository } from "./repository.js";
import { HarnessRunStore, type EvaluationHandoff } from "./run-store.js";
import { WorkItemStore } from "./work-items.js";

const response = (text: string, details: unknown = null) => ({ content: [{ type: "text" as const, text }], details });

function evaluatorEnvironment() {
	const runId = process.env.PIBOX_HARNESS_RUN_ID;
	const workItemId = process.env.PIBOX_HARNESS_WORK_ITEM;
	const evaluationId = process.env.PIBOX_HARNESS_EVALUATION;
	const credential = process.env.PIBOX_HARNESS_CREDENTIAL;
	if (!runId || !workItemId || !evaluationId || !credential) throw new HarnessError("CAPABILITY_DENIED", "Evaluator capability requires a supervised evaluation run");
	return { runId, workItemId, evaluationId, credential };
}

async function authorized(ctx: ExtensionContext) {
	const scope = evaluatorEnvironment();
	const identity = await discoverRepository(ctx.cwd);
	const runs = new HarnessRunStore(identity, scope.workItemId);
	const run = await runs.authorize(scope.runId, scope.credential);
	if (run.evaluationId !== scope.evaluationId || run.workspace !== ctx.cwd) throw new HarnessError("CAPABILITY_DENIED", "Evaluator run scope mismatch");
	return { scope, identity, runs, run, workItems: new WorkItemStore(identity.root) };
}

export function isEvaluatorProcess(): boolean {
	return Boolean(process.env.PIBOX_HARNESS_EVALUATION);
}

export function registerEvaluatorCapabilities(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "evaluation_context",
		label: "Evaluation Context",
		description: "Read canonical context and the assigned evaluation boundary.",
		parameters: Type.Object({ artifactId: Type.Optional(Type.String()) }),
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const auth = await authorized(ctx);
				const item = await auth.workItems.read(auth.scope.workItemId);
				if (auth.run.planningRevision !== undefined && item.planning.revision !== auth.run.planningRevision) throw new HarnessError("CONTEXT_REFRESH_REQUIRED", `Evaluation planning advanced from revision ${auth.run.planningRevision} to ${item.planning.revision}`);
				const evaluation = await auth.workItems.readEvaluation(item.id, auth.scope.evaluationId);
				if (!params.artifactId) return response(`Evaluation ${evaluation.id} (${evaluation.type})\nScope: ${JSON.stringify(evaluation.scope)}\nPlanning r${item.planning.revision}\n${item.artifacts.map((artifact) => `- ${artifact.id} (${artifact.type})`).join("\n")}`, { item, evaluation });
				const artifact = item.artifacts.find((candidate) => candidate.id === params.artifactId);
				if (!artifact) throw new HarnessError("INVALID_ARTIFACT", `Unknown artifact: ${params.artifactId}`);
				return response(await readFile(join(auth.workItems.workItemRoot(item.id), artifact.path), "utf8"), { revision: item.planning.revision });
			} catch (error) {
				throw new Error(describeHarnessError(error));
			}
		},
	});

	for (const name of ["evidence_record", "finding_report", "evaluation_checkpoint"] as const) {
		pi.registerTool({
			name,
			label: name.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" "),
			description: `Persist structured ${name.replaceAll("_", " ")} data in the private evaluation run.`,
			parameters: Type.Object({ data: Type.Record(Type.String(), Type.Unknown()) }),
			async execute(_id, params, _signal, _update, ctx) {
				try {
					const auth = await authorized(ctx);
					await auth.runs.appendEvent(auth.scope.runId, name.replaceAll("_", "."), params.data);
					return response("Evaluation run data persisted.");
				} catch (error) {
					throw new Error(describeHarnessError(error));
				}
			},
		});
	}

	pi.registerTool({
		name: "evaluation_complete",
		label: "Complete Evaluation",
		description: "Submit the terminal verdict with observations, evidence, discrete findings, and residual uncertainty.",
		parameters: Type.Object({
			verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("blocked"), Type.Literal("not_applicable")]),
			report: Type.String({ description: "Concise evaluation observations; canonical report structure is rendered by the capability." }),
			residualRisks: Type.Optional(Type.Array(Type.String())),
			evidence: Type.Optional(Type.Array(Type.Object({ command: Type.Optional(Type.String()), result: Type.String(), path: Type.Optional(Type.String()), description: Type.Optional(Type.String()) }))),
			findings: Type.Optional(Type.Array(Type.Object({
				id: Type.String(),
				severity: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")]),
				status: Type.Union([Type.Literal("open"), Type.Literal("accepted"), Type.Literal("rejected"), Type.Literal("duplicate"), Type.Literal("deferred"), Type.Literal("resolved"), Type.Literal("needs_user")]),
				criterion: Type.Optional(Type.String()),
				location: Type.Optional(Type.String()),
				summary: Type.String(),
				blocking: Type.Boolean(),
			}))),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const auth = await authorized(ctx);
				if (!params.report.trim()) throw new HarnessError("INVALID_HANDOFF", "Evaluation report must not be empty");
				const handoff: EvaluationHandoff = {
					schemaVersion: 1,
					type: "evaluation_complete",
					runId: auth.scope.runId,
					evaluationId: auth.scope.evaluationId,
					verdict: params.verdict,
					report: params.report,
					residualRisks: params.residualRisks ?? [],
					evidence: params.evidence ?? [],
					findings: params.findings ?? [],
					completedAt: new Date().toISOString(),
				};
				await auth.runs.writeEvaluationHandoff(auth.scope.runId, handoff);
				return response("Terminal evaluation handoff accepted.", handoff);
			} catch (error) {
				throw new Error(describeHarnessError(error));
			}
		},
	});
}
