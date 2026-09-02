import { parse } from "yaml";

/** Isolated, read-only parser used only to display historical pre-target artifacts. */
export interface LegacyWorkItemIndex {
	id: string;
	title: string;
	kind: string;
	phase: string;
	state: string;
	planning: { revision: number };
	artifacts: unknown[];
	tasks: unknown[];
	evaluations: unknown[];
}

function mapping(content: string, source: string): Record<string, unknown> {
	const value = parse(content) as unknown;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${source} must contain a mapping`);
	return value as Record<string, unknown>;
}

export function parseLegacyWorkItemIndex(content: string, source: string): LegacyWorkItemIndex {
	const value = mapping(content, source);
	if (typeof value.id !== "string" || typeof value.title !== "string" || typeof value.kind !== "string" || typeof value.phase !== "string" || typeof value.state !== "string") throw new Error(`${source} has invalid historical identity`);
	const planning = value.planning as Record<string, unknown> | undefined;
	if (!Number.isInteger(planning?.revision) || !Array.isArray(value.artifacts) || !Array.isArray(value.tasks) || !Array.isArray(value.evaluations)) throw new Error(`${source} has invalid historical catalogs`);
	return { id: value.id, title: value.title, kind: value.kind, phase: value.phase, state: value.state, planning: { revision: planning!.revision as number }, artifacts: value.artifacts, tasks: value.tasks, evaluations: value.evaluations };
}

export function parseLegacyTaskManifest(content: string, source: string): Record<string, unknown> {
	const value = mapping(content, source);
	if (typeof value.id !== "string" || typeof value.title !== "string" || typeof value.status !== "string" || !Array.isArray(value.dependsOn)) throw new Error(`${source} has invalid historical task identity`);
	return value;
}
