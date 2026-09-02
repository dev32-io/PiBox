import { HarnessError } from "./errors.js";
import { renderBuiltInPrompt } from "./prompt-loader.js";
import type { AuthoredExecutionStage, AuthoredTaskDocument, StoryDocument, VerificationCheckSpec } from "./types.js";
import { renderVerificationCheck } from "./verification-checks.js";
import { WorkItemStore } from "./work-items.js";
import type { LedgerEntry, StructuredFinding } from "./story-runtime-store.js";

export const TASK_CONTEXT_BUDGET_BYTES = 128 * 1024;
export const REVIEW_CONTEXT_BUDGET_BYTES = 512 * 1024;
export interface ContextBudgetOptions { maxBytes?: number }
export interface AttemptCoordinates { baseCommit?: string; branch?: string; worktree?: string; headCommit?: string }
export type ManagedContextRole = "stage-reviewer" | "stage-fixer" | "final-reviewer" | "e2e";
export interface RolePersistentContextInput { role: ManagedContextRole; story: StoryDocument; tasks?: readonly AuthoredTaskDocument[]; stage?: AuthoredExecutionStage }
export interface RoleAttemptContextInput extends AttemptCoordinates { failure?: string; findings?: readonly StructuredFinding[]; ledger?: readonly LedgerEntry[]; previousReviewedCommit?: string }

function boundedContext(kind: "task" | "review", rendered: string, budgetBytes: number): string {
	if (!Number.isInteger(budgetBytes) || budgetBytes < 1) throw new HarnessError("INVALID_ARTIFACT", `${kind} context budget must be a positive byte count`);
	const packet = `${rendered}\n`;
	const bytes = Buffer.byteLength(packet, "utf8");
	if (bytes > budgetBytes) throw new HarnessError("INVALID_ARTIFACT", `${kind} stable context requires ${bytes} bytes, exceeding its explicit ${budgetBytes}-byte budget; binding content was not truncated`, { budgetBytes, actualBytes: bytes });
	return packet;
}

function renderTaskContract(task: AuthoredTaskDocument): string {
	return [`### ${task.id} — ${task.title}`, "", "#### Description", "", task.description, "", "#### Scope", "", task.scope, "", "#### Delivery", "", task.delivery].join("\n");
}

export async function buildTaskPersistentContext(store: WorkItemStore, workItemId: string, task: Pick<AuthoredTaskDocument, "id">, options: ContextBudgetOptions = {}): Promise<string> {
	const authored = await store.readAuthoredTask(workItemId, task.id);
	return boundedContext("task", renderBuiltInPrompt("implementation-context", { task: `${authored.id} — ${authored.title}`, description: authored.description, scope: authored.scope, delivery: authored.delivery }), options.maxBytes ?? TASK_CONTEXT_BUDGET_BYTES);
}

function renderChecks(checks: readonly VerificationCheckSpec[]): string { return checks.length ? checks.map((check) => `- ${renderVerificationCheck(check)}`).join("\n") : "- None declared."; }

export function buildRolePersistentContext(input: RolePersistentContextInput, options: ContextBudgetOptions = {}): string {
	let boundary: string;
	if (input.role === "e2e") boundary = ["## Complete E2E Contract", "", input.story.e2e].join("\n");
	else {
		const storyContext = ["## Story Specification", "", input.story.spec, "", "## Story Design", "", input.story.design].join("\n");
		const taskContext = (input.tasks ?? []).map(renderTaskContract).join("\n\n") || "No task contracts are assigned to this boundary.";
		const stageContext = input.role === "stage-reviewer" && input.stage ? [`## Stage ${input.stage.id}`, "", "### Harness-Owned Checks", "", renderChecks(input.stage.checks), "", "### Review Focus", "", input.stage.review?.focus || "General correctness and contract fit within this stage."].join("\n") : "";
		boundary = [storyContext, "## Scoped Task Contracts", "", taskContext, stageContext].filter(Boolean).join("\n\n");
	}
	return boundedContext("review", renderBuiltInPrompt("review-context", { role: input.role, boundary }), options.maxBytes ?? REVIEW_CONTEXT_BUDGET_BYTES);
}

export function buildRoleAttemptContext(input: RoleAttemptContextInput): string {
	const coordinates = [input.baseCommit ? `Base commit: ${input.baseCommit}` : undefined, input.headCommit ? `Head commit: ${input.headCommit}` : undefined, input.branch ? `Branch: ${input.branch}` : undefined, input.worktree ? `Worktree: ${input.worktree}` : undefined].filter((line): line is string => Boolean(line));
	const ledger = input.ledger?.length ? ["## Relevant Curated Ledger", "", ...input.ledger.map((entry) => `- ${entry.summary}${entry.evidence?.length ? ` (evidence: ${entry.evidence.join(", ")})` : ""}`)] : [];
	return ["## Current Attempt", "", ...coordinates, ...(input.baseCommit && input.headCommit ? [`Execution diff: ${input.baseCommit}..${input.headCommit}`] : []), ...(input.previousReviewedCommit && input.headCommit ? [`Current repair diff: ${input.previousReviewedCommit}..${input.headCommit}`] : []), ...(input.failure ? ["", "## Latest Failure", "", input.failure] : []), ...(input.findings?.length ? ["", "## Current Structured Findings", "", ...input.findings.map((finding) => `- ${finding.id} [${finding.severity}/${finding.code}] ${finding.summary}${finding.path ? ` — ${finding.path}${finding.line ? `:${finding.line}` : ""}` : ""}`)] : []), "", ...ledger].join("\n").trimEnd();
}
