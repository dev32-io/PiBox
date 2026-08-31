import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { HarnessError } from "./errors.js";
import { readBuiltInPrompt, renderBuiltInPrompt } from "./prompt-loader.js";
import type { EvaluationManifest, TaskAuthoredManifest, TaskManifest, WorkItemIndex } from "./types.js";
import { renderVerificationCheck } from "./verification-checks.js";
import { WorkItemStore } from "./work-items.js";

export const TASK_CONTEXT_BUDGET_BYTES = 128 * 1024;
export const REVIEW_CONTEXT_BUDGET_BYTES = 512 * 1024;

export interface ContextBudgetOptions {
	maxBytes?: number;
}

interface ContextSource {
	ref: string;
	type: "task-contract" | "brief" | "acceptance" | "intent" | "spec" | "design" | "decision" | "e2e-matrix" | "evaluation" | "review-policy";
	content: string;
}

function body(markdown: string): string {
	return markdown.trim().replace(/^# .+\n+/, "");
}

function qualifiedCriteria(markdown: string): Map<string, Set<string>> {
	const references = new Map<string, Set<string>>();
	for (const match of markdown.matchAll(/\b([a-z0-9]+(?:-[a-z0-9]+)*)#(AC-\d{3})\b/g)) {
		const ids = references.get(match[1]!) ?? new Set<string>();
		ids.add(match[2]!);
		references.set(match[1]!, ids);
	}
	return references;
}

function criterionExcerpt(markdown: string, ids: Set<string>): string {
	const lines = markdown.split("\n").filter((line) => [...ids].some((id) => new RegExp(`(?:\\*\\*|^|\\s)${id}:?`).test(line)));
	return lines.join("\n").trim();
}

function sourceManifest(kind: "task" | "review", budgetBytes: number, sources: readonly ContextSource[]): string {
	const sourceBytes = sources.reduce((total, source) => total + Buffer.byteLength(source.content, "utf8"), 0);
	return [
		"## Context Source Manifest",
		"",
		"```yaml",
		stringify({
			schemaVersion: 1,
			kind,
			budgetBytes,
			sourceBytes,
			sources: sources.map((source) => ({
				ref: source.ref,
				type: source.type,
				bytes: Buffer.byteLength(source.content, "utf8"),
				digest: `sha256:${createHash("sha256").update(source.content, "utf8").digest("hex")}`,
				inclusion: "full",
			})),
		}).trim(),
		"```",
	].join("\n");
}

function boundedPacket(kind: "task" | "review", rendered: string, sources: readonly ContextSource[], budgetBytes: number): string {
	if (!Number.isInteger(budgetBytes) || budgetBytes < 1) throw new HarnessError("INVALID_ARTIFACT", `${kind} context budget must be a positive byte count`);
	const packet = `${sourceManifest(kind, budgetBytes, sources)}\n\n${rendered.trim()}\n`;
	const bytes = Buffer.byteLength(packet, "utf8");
	if (bytes > budgetBytes) {
		throw new HarnessError("INVALID_ARTIFACT", `${kind} context requires ${bytes} bytes, exceeding its explicit ${budgetBytes}-byte budget; requirements were not truncated`, {
			budgetBytes,
			actualBytes: bytes,
			sources: sources.map((source) => ({ ref: source.ref, bytes: Buffer.byteLength(source.content, "utf8") })),
		});
	}
	return packet;
}

function authoredTaskManifest(task: TaskManifest): TaskAuthoredManifest {
	const { runtime: _runtime, ...authored } = task;
	return authored;
}

function stableTaskManifest(task: TaskManifest): Omit<TaskAuthoredManifest, "status"> {
	const { status: _status, ...stable } = authoredTaskManifest(task);
	return stable;
}

function stableEvaluationManifest(evaluation: EvaluationManifest): Omit<EvaluationManifest, "status" | "attempt" | "result" | "findings" | "loop"> {
	const { status: _status, attempt: _attempt, result: _result, findings: _findings, loop: _loop, ...stable } = evaluation;
	return stable;
}

/** Build the small authoritative context that every task attempt keeps in its system prompt. */
export async function buildTaskPersistentContext(store: WorkItemStore, workItemId: string, task: TaskManifest, options: ContextBudgetOptions = {}): Promise<string> {
	const item = await store.read(workItemId);
	const contract = await store.readTaskContract(workItemId, task.id);
	const legacyReferences = task.references;
	const referenced = legacyReferences ? [...new Set([...legacyReferences.specs, ...legacyReferences.designs, ...legacyReferences.decisions])] : [];
	const criteria = qualifiedCriteria(contract.acceptance);
	const planSections: string[] = [];
	const sources: ContextSource[] = [
		{ ref: `work-item:${workItemId}/task:${task.id}`, type: "task-contract", content: stringify(stableTaskManifest(task)).trim() },
		{ ref: `work-item:${workItemId}/task:${task.id}/brief`, type: "brief", content: body(contract.brief) },
		{ ref: `work-item:${workItemId}/task:${task.id}/acceptance`, type: "acceptance", content: body(contract.acceptance) },
	];

	// New task contracts are complete assignment packets and deliberately omit
	// references. Preserve extraction only for stored legacy tasks.
	if (legacyReferences) {
		if (referenced.length === 0) {
			const intent = await store.readArtifact(workItemId, "intent");
			const content = body(intent.content);
			planSections.push("## Work-Item Intent", "", content);
			sources.push({ ref: `work-item:${workItemId}/artifact:intent`, type: "intent", content });
		} else {
			for (const id of referenced) {
				const artifact = await store.readArtifact(workItemId, id);
				if (artifact.metadata.type === "spec" && criteria.has(id)) {
					const excerpt = criterionExcerpt(artifact.content, criteria.get(id)!);
					if (excerpt) {
						planSections.push(`## Assigned acceptance criteria: ${id}`, "", excerpt);
						sources.push({ ref: `work-item:${workItemId}/artifact:${id}#assigned-criteria`, type: "spec", content: excerpt });
					}
					continue;
				}
				if (artifact.metadata.type === "design") {
					const pointer = readBuiltInPrompt("design-context-pointer");
					planSections.push(`## Referenced design: ${id}`, "", pointer);
					sources.push({ ref: `work-item:${workItemId}/artifact:${id}#pointer`, type: "design", content: pointer });
					continue;
				}
				const content = body(artifact.content);
				planSections.push(`## Referenced ${artifact.metadata.type}: ${id}`, "", content);
				sources.push({ ref: `work-item:${workItemId}/artifact:${id}`, type: artifact.metadata.type as "intent" | "spec" | "decision", content });
			}
		}
	}

	const rendered = renderBuiltInPrompt("implementation-context", {
		workItem: item.title,
		assignment: `${task.id} — ${task.title}\n\nExpected contribution state: ${task.assembly.intermediateState}; execution stage: ${task.assembly.stageId ?? task.assembly.integrationUnit}.`,
		brief: body(contract.brief),
		acceptance: body(contract.acceptance),
		planContext: planSections.join("\n\n"),
		checks: task.verification.taskChecks.length ? task.verification.taskChecks.map((check) => `- ${check}`).join("\n") : "- None assigned at this boundary.",
	});
	return boundedPacket("task", rendered, sources, options.maxBytes ?? TASK_CONTEXT_BUDGET_BYTES);
}

export function buildTaskAttemptContext(task: TaskManifest): string {
	const failure = task.runtime?.deterministicFailure;
	if (!failure) return "";
	return [
		"## Changes Requested by Deterministic CI", "", `Repair generation: ${failure.generation}`,
		`Candidate: ${failure.candidateCommit}`,
		...(failure.checkId ? [`Check: ${failure.checkId}`] : []),
		...(failure.command ? [`Command: ${failure.command}`] : []),
		...(failure.attemptPath ? [`Evidence: ${failure.attemptPath}`] : []),
		"", failure.summary, "",
		"Resolve only the surfaced deterministic failure, preserve the reviewed contract and unrelated green work, commit the repair, rerun the focused check, and resubmit.",
	].join("\n");
}

async function amendmentChain(store: WorkItemStore, item: WorkItemIndex): Promise<WorkItemIndex[]> {
	const items = [item];
	const seen = new Set([item.id]);
	let cursor = item;
	while (cursor.amendment) {
		const baselineId = cursor.amendment.baselineWorkItemId;
		if (seen.has(baselineId)) throw new HarnessError("INVALID_ARTIFACT", `Amendment baseline cycle detected at ${baselineId}`);
		seen.add(baselineId);
		cursor = await store.read(baselineId);
		items.unshift(cursor);
	}
	return items;
}

function assignedTaskIds(item: WorkItemIndex, evaluation: EvaluationManifest): string[] {
	const stage = evaluation.checkpoint === "stage-review" ? item.executionStages?.find((candidate) => candidate.id === evaluation.stageId) : undefined;
	return stage?.tasks ?? (evaluation.scope.task ? [evaluation.scope.task] : item.tasks.map((task) => task.id));
}

/** Build the bounded contract/spec context kept stable across review attempts. */
export async function buildReviewPersistentContext(store: WorkItemStore, workItemId: string, evaluation: EvaluationManifest, options: ContextBudgetOptions = {}): Promise<string> {
	const item = await store.read(workItemId);
	if (evaluation.context && (!Array.isArray(evaluation.context.taskIds) || !Array.isArray(evaluation.context.artifactRefs))) {
		throw new HarnessError("INVALID_ARTIFACT", `Evaluation ${evaluation.id} has an incomplete explicit context scope`);
	}
	const stage = evaluation.checkpoint === "stage-review" ? item.executionStages?.find((candidate) => candidate.id === evaluation.stageId) : undefined;
	const canonicalContext = evaluation.context ? await store.canonicalEvaluationContext(workItemId, evaluation) : undefined;
	const taskIds = canonicalContext?.taskIds ?? assignedTaskIds(item, evaluation);
	const explicitTaskIds = evaluation.context?.taskIds;
	if (explicitTaskIds) {
		const duplicates = explicitTaskIds.filter((taskId, index) => explicitTaskIds.indexOf(taskId) !== index);
		const omitted = taskIds.filter((taskId) => !explicitTaskIds.includes(taskId));
		const extra = explicitTaskIds.filter((taskId) => !taskIds.includes(taskId));
		if (duplicates.length || omitted.length || extra.length) {
			throw new HarnessError("INVALID_ARTIFACT", `Evaluation ${evaluation.id} context task selection must exactly match its assigned contracts`, {
				duplicates: [...new Set(duplicates)], omitted, extra,
			});
		}
	}
	const tasks: string[] = [];
	const sources: ContextSource[] = [];
	for (const taskId of taskIds) {
		const task = await store.readTask(workItemId, taskId);
		const contract = await store.readTaskContract(workItemId, taskId);
		const manifest = stringify(stableTaskManifest(task)).trim();
		const brief = body(contract.brief);
		const acceptance = body(contract.acceptance);
		sources.push(
			{ ref: `work-item:${workItemId}/task:${taskId}`, type: "task-contract", content: manifest },
			{ ref: `work-item:${workItemId}/task:${taskId}/brief`, type: "brief", content: brief },
			{ ref: `work-item:${workItemId}/task:${taskId}/acceptance`, type: "acceptance", content: acceptance },
		);
		tasks.push([
			`### ${task.id} — ${task.title}`, "", "#### Manifest", "", "```yaml", manifest, "```", "", "#### Brief", "", brief, "", "#### Acceptance Contract", "", acceptance,
		].join("\n"));
	}

	const artifactItems = await amendmentChain(store, item);
	const explicitArtifacts = evaluation.context?.artifactRefs;
	if (explicitArtifacts) {
		const keys = explicitArtifacts.map((ref) => `${ref.workItemId}/${ref.artifactId}`);
		const required = canonicalContext!.artifactRefs.map((ref) => `${ref.workItemId}/${ref.artifactId}`);
		const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
		const omitted = required.filter((key) => !keys.includes(key));
		const extra = keys.filter((key) => !required.includes(key));
		if (duplicates.length || omitted.length || extra.length) {
			throw new HarnessError("INVALID_ARTIFACT", `Evaluation ${evaluation.id} context artifact selection must exactly match its canonical review scope`, {
				duplicates: [...new Set(duplicates)], omitted, extra,
			});
		}
	}
	const selected = explicitArtifacts
		? explicitArtifacts.map((ref) => ({ item: artifactItems.find((candidate) => candidate.id === ref.workItemId), workItemId: ref.workItemId, artifactId: ref.artifactId })).map(({ item: selectedItem, workItemId: selectedWorkItemId, artifactId }) => {
			if (!selectedItem) throw new HarnessError("INVALID_ARTIFACT", `Evaluation ${evaluation.id} context references unavailable work item ${selectedWorkItemId}`);
			const entry = selectedItem.artifacts.find((candidate) => candidate.id === artifactId);
			if (!entry) throw new HarnessError("INVALID_ARTIFACT", `Evaluation ${evaluation.id} context references unknown artifact ${selectedItem.id}/${artifactId}`);
			return { item: selectedItem, entry };
		})
		: artifactItems.flatMap((artifactItem) => artifactItem.artifacts
			.filter((artifact) => ["intent", "spec", "design", "decision"].includes(artifact.type) || ((evaluation.type === "e2e" || evaluation.checkpoint === "final-review") && artifact.type === "e2e-matrix"))
			.map((entry) => ({ item: artifactItem, entry })));
	const artifacts: string[] = [];
	for (const { item: artifactItem, entry } of selected) {
		if (!["intent", "spec", "design", "decision", "e2e-matrix"].includes(entry.type)) throw new HarnessError("INVALID_ARTIFACT", `Evaluation ${evaluation.id} selected unsupported context artifact ${entry.type}`);
		const artifact = await store.readArtifact(artifactItem.id, entry.id);
		const content = body(artifact.content);
		const relationship = artifactItem.id === item.id ? (item.amendment ? "current amendment" : "current work item") : "immutable amendment baseline";
		artifacts.push(`### ${relationship}: ${artifactItem.id}/${entry.type}:${entry.id}\n\n${content}`);
		sources.push({ ref: `work-item:${artifactItem.id}/artifact:${entry.id}`, type: entry.type as ContextSource["type"], content });
	}

	const evaluationText = stage ? [
		`Evaluation: ${evaluation.id} (${evaluation.type}, ${evaluation.checkpoint})`,
		`Stage checks:\n${stage.checks?.map((check) => `- ${renderVerificationCheck(check)}`).join("\n") ?? "- None declared."}`,
		`Review focus:\n${stage.review?.focus?.map((focus) => `- ${focus}`).join("\n") ?? "- General correctness, contract fit, regressions, maintainability, and focused proof."}`,
	].join("\n\n") : `Evaluation contract:\n\n\`\`\`yaml\n${stringify(stableEvaluationManifest(evaluation)).trim()}\n\`\`\``;
	sources.push({ ref: `work-item:${workItemId}/evaluation:${evaluation.id}`, type: stage ? "review-policy" : "evaluation", content: evaluationText });
	const rendered = renderBuiltInPrompt("review-context", {
		workItem: stage ? `Stage ${stage.id}` : `${item.id} — ${item.title}`,
		evaluation: evaluationText,
		tasks: tasks.join("\n\n") || "No task manifest is assigned to this evaluation boundary.",
		artifacts: artifacts.join("\n\n") || "No specification or design artifacts are selected.",
	});
	return boundedPacket("review", rendered, sources, options.maxBytes ?? REVIEW_CONTEXT_BUDGET_BYTES);
}

/** Attempt-local review/fix facts belong in the bounded user turn, never the cache prefix. */
export async function buildReviewAttemptContext(store: WorkItemStore, workItemId: string, evaluation: EvaluationManifest, reviewedCommit?: string): Promise<string> {
	const item = await store.read(workItemId);
	const currentReviewedCommit = reviewedCommit ?? evaluation.loop?.reviewedCommit ?? "not recorded";
	const wholeBranchBase = item.delivery?.executionStartCommit ?? item.delivery?.createdFromCommit;
	const rereviewBase = evaluation.loop?.reviewedCommit;
	return [
		"## Current Review Attempt",
		`Reviewed commit: ${currentReviewedCommit}`,
		`Review mode: ${evaluation.loop?.state === "rereviewing" ? "closure-focused re-review" : "initial exhaustive review"}`,
		`Repair generation: ${evaluation.loop?.iteration ?? 0}`,
		`Prior findings: ${(evaluation.findings ?? []).map((finding) => `${finding.id} (${finding.severity}, ${finding.status}) — ${finding.summary}`).join("; ") || "None recorded."}`,
		`Manager decision: ${evaluation.loop?.managerPrompt ?? "No prior manager decision recorded."}`,
		...(evaluation.checkpoint === "final-review" ? [
			`Whole-branch base commit: ${wholeBranchBase ?? "not recorded"}`,
			`Whole-branch head commit: ${currentReviewedCommit}`,
			`Initial review diff: ${wholeBranchBase && currentReviewedCommit !== "not recorded" ? `${wholeBranchBase}..${currentReviewedCommit}` : "unavailable until both commits are recorded"}`,
			"Review the assembled feature as one integrated change across the exact base..head boundary.",
		] : []),
		...(evaluation.loop?.state === "rereviewing" ? [
			`Current repair diff: ${rereviewBase && currentReviewedCommit !== "not recorded" ? `${rereviewBase}..${currentReviewedCommit}` : "inspect the bounded repair since the prior reviewed commit"}`,
			"Verify finding closure without reopening unrelated implementation.",
		] : []),
	].join("\n\n");
}
