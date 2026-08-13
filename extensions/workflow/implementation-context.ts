import type { TaskManifest } from "./types.js";
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
	const referenced = [...new Set([...task.references.specs, ...task.references.designs, ...task.references.decisions])];
	const criteria = qualifiedCriteria(contract.acceptance);
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
			if (artifact.metadata.type === "spec" && criteria.has(id)) {
				const excerpt = criterionExcerpt(artifact.content, criteria.get(id)!);
				if (excerpt) sections.push("", `## Assigned acceptance criteria: ${id}`, "", excerpt);
				continue;
			}
			if (artifact.metadata.type === "design") {
				sections.push("", `## Referenced design: ${id}`, "", "The task brief contains the assigned design boundary. Use `task_clarify` to read this broader design only when a concrete uncertainty remains.");
				continue;
			}
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
