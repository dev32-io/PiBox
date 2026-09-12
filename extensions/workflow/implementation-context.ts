import { renderBuiltInPrompt } from "./prompt-loader.js";
import type { AuthoredExecutionStage, AuthoredTaskDocument, StoryDocument, VerificationCheckSpec } from "./types.js";
import { renderVerificationCheck } from "./verification-checks.js";
import { WorkItemStore } from "./work-items.js";
import type { LedgerEntry, StructuredFinding } from "./story-runtime-store.js";

export interface AttemptCoordinates { baseCommit?: string; branch?: string; worktree?: string; headCommit?: string }
export type ManagedContextRole = "stage-reviewer" | "stage-fixer" | "final-reviewer" | "e2e";
export interface RolePersistentContextInput { role: ManagedContextRole; story: StoryDocument; tasks?: readonly AuthoredTaskDocument[]; stage?: AuthoredExecutionStage }
export interface RoleAttemptContextInput extends AttemptCoordinates { failure?: string; findings?: readonly StructuredFinding[]; ledger?: readonly LedgerEntry[]; previousReviewedCommit?: string }

function renderTaskContract(task: AuthoredTaskDocument): string {
	return [`### ${task.id} — ${task.title}`, "", "#### Description", "", task.description, "", "#### Scope", "", task.scope, "", "#### Delivery", "", task.delivery].join("\n");
}

export async function buildTaskPersistentContext(store: WorkItemStore, workItemId: string, task: Pick<AuthoredTaskDocument, "id">): Promise<string> {
	const authored = await store.readAuthoredTask(workItemId, task.id);
	return `${renderBuiltInPrompt("implementation-context", { task: `${authored.id} — ${authored.title}`, description: authored.description, scope: authored.scope, delivery: authored.delivery })}\n`;
}

function renderChecks(checks: readonly VerificationCheckSpec[]): string { return checks.length ? checks.map((check) => `- ${renderVerificationCheck(check)}`).join("\n") : "- None declared."; }

export function buildRolePersistentContext(input: RolePersistentContextInput): string {
	let boundary: string;
	if (input.role === "e2e") boundary = ["## Complete E2E Contract", "", input.story.e2e].join("\n");
	else {
		const storyContext = ["## Story Specification", "", input.story.spec, "", "## Story Design", "", input.story.design].join("\n");
		const taskContext = (input.tasks ?? []).map(renderTaskContract).join("\n\n") || "No task contracts are assigned to this boundary.";
		const stageContext = input.role === "stage-reviewer" && input.stage ? [`## Stage ${input.stage.id}`, "", "### Harness-Owned Checks", "", renderChecks(input.stage.checks), "", "### Review Focus", "", input.stage.review?.focus || "General correctness and contract fit within this stage."].join("\n") : "";
		boundary = [storyContext, "## Scoped Task Contracts", "", taskContext, stageContext].filter(Boolean).join("\n\n");
	}
	return `${renderBuiltInPrompt("review-context", { role: input.role, boundary })}\n`;
}

export function buildRoleAttemptContext(input: RoleAttemptContextInput): string {
	const coordinates = [input.baseCommit ? `Base commit: ${input.baseCommit}` : undefined, input.headCommit ? `Head commit: ${input.headCommit}` : undefined, input.branch ? `Branch: ${input.branch}` : undefined, input.worktree ? `Worktree: ${input.worktree}` : undefined].filter((line): line is string => Boolean(line));
	const ledger = input.ledger?.length ? ["## Relevant Curated Ledger", "", ...input.ledger.map((entry) => `- ${entry.summary}${entry.evidence?.length ? ` (evidence: ${entry.evidence.join(", ")})` : ""}`)] : [];
	return ["## Current Attempt", "", ...coordinates, ...(input.baseCommit && input.headCommit ? [`Execution diff: ${input.baseCommit}..${input.headCommit}`] : []), ...(input.previousReviewedCommit && input.headCommit ? [`Current repair diff: ${input.previousReviewedCommit}..${input.headCommit}`] : []), ...(input.failure ? ["", "## Latest Failure", "", input.failure] : []), ...(input.findings?.length ? ["", "## Current Structured Findings", "", ...input.findings.map((finding) => `- ${finding.id} [${finding.severity}/${finding.code}] ${finding.summary}${finding.path ? ` — ${finding.path}${finding.line ? `:${finding.line}` : ""}` : ""}`)] : []), "", ...ledger].join("\n").trimEnd();
}
