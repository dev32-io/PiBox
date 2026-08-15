import { generateDiffString } from "@earendil-works/pi-coding-agent";

export interface ResourceDisplayDiff {
	action: "create" | "update" | "delete";
	ref: string;
	diff: string;
}

const DISPLAY_ONLY_METADATA_KEYS = new Set([
	"revision",
	"createdAt",
	"updatedAt",
	"planningRevision",
	"commit",
]);

function displayValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(displayValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([key]) => !DISPLAY_ONLY_METADATA_KEYS.has(key))
			.map(([key, entry]) => [key, displayValue(entry)]),
	);
}

function serialized(value: unknown): string {
	if (value === undefined) return "";
	return `${JSON.stringify(displayValue(value), null, 2)}\n`;
}

export function resourceDisplayDiff(action: ResourceDisplayDiff["action"], ref: string, before: unknown, after: unknown): ResourceDisplayDiff {
	return {
		action,
		ref,
		diff: generateDiffString(serialized(before), serialized(after)).diff,
	};
}
