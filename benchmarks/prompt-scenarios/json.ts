import type { ParseOutcome } from "./types.js";

function parseCandidate(candidate: string): { value?: unknown; error?: string } {
	try { return { value: JSON.parse(candidate) }; }
	catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

function fencedCandidates(raw: string): string[] {
	return [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]!.trim()).filter(Boolean);
}

/** Find balanced JSON objects/arrays while respecting quoted braces. */
function balancedCandidates(raw: string): string[] {
	const candidates: string[] = [];
	for (let start = 0; start < raw.length; start += 1) {
		if (raw[start] !== "{" && raw[start] !== "[") continue;
		const stack: string[] = [];
		let quoted = false;
		let escaped = false;
		for (let index = start; index < raw.length; index += 1) {
			const char = raw[index]!;
			if (quoted) {
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === '"') quoted = false;
				continue;
			}
			if (char === '"') { quoted = true; continue; }
			if (char === "{" || char === "[") stack.push(char);
			else if (char === "}" || char === "]") {
				const expected = char === "}" ? "{" : "[";
				if (stack.pop() !== expected) break;
				if (stack.length === 0) {
					candidates.push(raw.slice(start, index + 1));
					break;
				}
			}
		}
	}
	return candidates;
}

export function extractStructuredJson(raw: string): ParseOutcome<unknown> {
	const direct = parseCandidate(raw.trim());
	if (direct.value !== undefined) return { syntaxValid: true, schemaValid: true, strategy: "direct", extracted: raw.trim(), value: direct.value, errors: [] };
	for (const [strategy, candidates] of [["fenced", fencedCandidates(raw)], ["balanced", balancedCandidates(raw)]] as const) {
		for (const candidate of candidates) {
			const parsed = parseCandidate(candidate);
			if (parsed.value !== undefined) return { syntaxValid: true, schemaValid: true, strategy, extracted: candidate, value: parsed.value, errors: [] };
		}
	}
	return {
		syntaxValid: false,
		schemaValid: false,
		strategy: "none",
		errors: [`No valid JSON object or array found${direct.error ? `: ${direct.error}` : ""}`],
	};
}
