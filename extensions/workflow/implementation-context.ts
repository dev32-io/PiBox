import type { TaskManifest } from "./types.js";
import { WorkItemStore } from "./work-items.js";

function body(markdown: string): string {
	return markdown.trim().replace(/^# .+\n+/, "");
}

/** Build the small authoritative context that every task attempt keeps in its system prompt. */
export async function buildTaskPersistentContext(store: WorkItemStore, workItemId: string, task: TaskManifest): Promise<string> {
	const item = await store.read(workItemId);
	const contract = await store.readTaskContract(workItemId, task.id);
	const referenced = [...new Set([...task.references.specs, ...task.references.designs, ...task.references.decisions])];
	const sections = [
		"# Persistent Implementation Context",
		"",
		"This is the authoritative context for the current contribution attempt. Use `task_clarify` only when a concrete uncertainty requires broader context from the current work item.",
		"",
		"## Work Item",
		"",
		item.title,
		"",
		"## Assignment",
		"",
		`${task.id} — ${task.title}`,
		"",
		`Expected contribution state: ${task.assembly.intermediateState}; execution stage: ${task.assembly.stageId ?? task.assembly.integrationUnit}.`,
		"",
		"## Task Brief",
		"",
		body(contract.brief),
		"",
		"## Acceptance Contract",
		"",
		body(contract.acceptance),
	];

	if (referenced.length === 0) {
		const intent = await store.readArtifact(workItemId, "intent");
		sections.push("", "## Work-Item Intent", "", body(intent.content));
	} else {
		for (const id of referenced) {
			const artifact = await store.readArtifact(workItemId, id);
			sections.push("", `## Referenced ${artifact.metadata.type}: ${id}`, "", body(artifact.content));
		}
	}

	sections.push(
		"",
		"## Required Checks",
		"",
		...(task.verification.taskChecks.length ? task.verification.taskChecks.map((check) => `- ${check}`) : ["- None assigned at this boundary."]),
	);
	return `${sections.join("\n").trim()}\n`;
}
