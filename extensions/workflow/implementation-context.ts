import { stringify } from "yaml";
import { readBuiltInPrompt, renderBuiltInPrompt } from "./prompt-loader.js";
import type { EvaluationManifest, TaskManifest } from "./types.js";
import { renderVerificationCheck } from "./verification-checks.js";
import { WorkItemStore } from "./work-items.js";

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

/** Build the small authoritative context that every task attempt keeps in its system prompt. */
export async function buildTaskPersistentContext(store: WorkItemStore, workItemId: string, task: TaskManifest): Promise<string> {
	const item = await store.read(workItemId);
	const contract = await store.readTaskContract(workItemId, task.id);
	const legacyReferences = task.references;
	const referenced = legacyReferences ? [...new Set([...legacyReferences.specs, ...legacyReferences.designs, ...legacyReferences.decisions])] : [];
	const criteria = qualifiedCriteria(contract.acceptance);
	const planSections: string[] = [];

	// New task contracts are complete assignment packets and deliberately omit
	// references. Preserve the old extraction behavior only for stored legacy
	// tasks; task_clarify remains the explicit escape hatch for extra story context.
	if (legacyReferences) {
		if (referenced.length === 0) {
			const intent = await store.readArtifact(workItemId, "intent");
			planSections.push("## Work-Item Intent", "", body(intent.content));
		} else {
			for (const id of referenced) {
				const artifact = await store.readArtifact(workItemId, id);
				if (artifact.metadata.type === "spec" && criteria.has(id)) {
					const excerpt = criterionExcerpt(artifact.content, criteria.get(id)!);
					if (excerpt) planSections.push(`## Assigned acceptance criteria: ${id}`, "", excerpt);
					continue;
				}
				if (artifact.metadata.type === "design") {
					planSections.push(`## Referenced design: ${id}`, "", readBuiltInPrompt("design-context-pointer"));
					continue;
				}
				planSections.push(`## Referenced ${artifact.metadata.type}: ${id}`, "", body(artifact.content));
			}
		}
	}

	return `${renderBuiltInPrompt("implementation-context", {
		workItem: item.title,
		assignment: `${task.id} — ${task.title}\n\nExpected contribution state: ${task.assembly.intermediateState}; execution stage: ${task.assembly.stageId ?? task.assembly.integrationUnit}.`,
		brief: body(contract.brief),
		acceptance: body(contract.acceptance),
		planContext: planSections.join("\n\n"),
		checks: task.verification.taskChecks.length ? task.verification.taskChecks.map((check) => `- ${check}`).join("\n") : "- None assigned at this boundary.",
	})}\n`;
}

/** Build the bounded authoritative context that every reviewer attempt keeps in its system prompt. */
export async function buildReviewPersistentContext(store: WorkItemStore, workItemId: string, evaluation: EvaluationManifest, reviewedCommit?: string): Promise<string> {
	const item = await store.read(workItemId);
	const stage = evaluation.checkpoint === "stage-review" ? item.executionStages?.find((candidate) => candidate.id === evaluation.stageId) : undefined;
	const taskIds = stage?.tasks ?? (evaluation.scope.task ? [evaluation.scope.task] : item.tasks.map((task) => task.id));
	const tasks: string[] = [];
	for (const taskId of taskIds) {
		const task = await store.readTask(workItemId, taskId);
		const contract = await store.readTaskContract(workItemId, taskId);
		tasks.push([
			`### ${task.id} — ${task.title}`,
			"",
			"#### Manifest",
			"",
			"```yaml",
			stringify(task).trim(),
			"```",
			"",
			"#### Brief",
			"",
			body(contract.brief),
			"",
			"#### Acceptance Contract",
			"",
			body(contract.acceptance),
		].join("\n"));
	}
	const artifacts: string[] = [];
	for (const entry of item.artifacts.filter((artifact) => ["intent", "spec", "design", "decision"].includes(artifact.type) || (evaluation.type === "e2e" && artifact.type === "e2e-matrix"))) {
		const artifact = await store.readArtifact(workItemId, entry.id);
		artifacts.push(`### ${entry.type}: ${entry.id}\n\n${body(artifact.content)}`);
	}
	if (stage) {
		return `${renderBuiltInPrompt("review-context", {
			workItem: `Stage ${stage.id}`,
			evaluation: [
				`Reviewed commit: ${reviewedCommit ?? evaluation.loop?.reviewedCommit ?? "not recorded"}`,
				`Review mode: ${evaluation.loop?.state === "rereviewing" ? "closure-focused re-review" : "initial exhaustive review"}`,
				`Prior findings: ${(evaluation.findings ?? []).map((finding) => `${finding.id} (${finding.severity}, ${finding.status}) — ${finding.summary}`).join("; ") || "None recorded."}`,
				`Manager decision: ${evaluation.loop?.managerPrompt ?? "No prior manager decision recorded."}`,
				`Bounded repair diff: inspect only the repair since the reviewed commit; do not reopen unrelated implementation.`,
				`Stage checks:\n${stage.checks?.map((check) => `- ${renderVerificationCheck(check)}`).join("\n") ?? "- None declared."}`,
				`Review focus:\n${stage.review?.focus?.map((focus) => `- ${focus}`).join("\n") ?? "- General correctness, contract fit, regressions, maintainability, and focused proof."}`,
			].join("\n\n"),
			tasks: tasks.join("\n\n"),
			artifacts: artifacts.join("\n\n") || "No story artifacts are recorded.",
		})}\n`;
	}
	return `${renderBuiltInPrompt("review-context", {
		workItem: `${item.id} — ${item.title}`,
		evaluation: `Reviewed commit: ${reviewedCommit ?? evaluation.loop?.reviewedCommit ?? "not recorded"}\nReview mode: ${evaluation.loop?.state === "rereviewing" ? "closure-focused re-review" : "initial exhaustive review"}\nPrior findings: ${(evaluation.findings ?? []).map((finding) => `${finding.id} (${finding.severity}, ${finding.status}) — ${finding.summary}`).join("; ") || "None recorded."}\nManager decision: ${evaluation.loop?.managerPrompt ?? "No prior manager decision recorded."}\nBounded repair diff: inspect only the repair since the reviewed commit.\n\n\`\`\`yaml\n${stringify(evaluation).trim()}\n\`\`\``,
		tasks: tasks.join("\n\n") || "No task manifest is assigned to this evaluation boundary.",
		artifacts: artifacts.join("\n\n") || "No specification or design artifacts are recorded.",
	})}\n`;
}
