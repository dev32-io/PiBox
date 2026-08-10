export const ACTIVITY_VERBS = [
	"Analyzing",
	"Tracing",
	"Mapping",
	"Resolving",
	"Synthesizing",
	"Verifying",
	"Refining",
	"Reviewing",
] as const;

export function nextVerb(current: string, random = Math.random): string {
	let candidate = current;
	while (candidate === current) candidate = ACTIVITY_VERBS[Math.floor(random() * ACTIVITY_VERBS.length)] ?? ACTIVITY_VERBS[0];
	return candidate;
}
