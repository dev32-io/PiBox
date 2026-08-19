import type { AutomaticScore, ParseOutcome, PromptScenario } from "../../types.js";

export interface E2EBenchmarkOutput {
	text: string;
}

/**
 * Automatic scoring is intentionally limited to whether the subject returned a
 * non-empty result. E2E quality is judged by independent reviewer subagents.
 */
export function scoreE2EScenario(_scenario: PromptScenario, parsed: ParseOutcome<E2EBenchmarkOutput>): AutomaticScore {
	const valid = parsed.syntaxValid && parsed.schemaValid && Boolean(parsed.value?.text.trim());
	const message = valid ? "Subject returned a non-empty E2E result." : `Subject output failure: ${parsed.errors.join("; ")}`;
	return {
		passed: valid,
		threshold: 100,
		total: valid ? 1 : 0,
		maxTotal: 1,
		normalized: valid ? 100 : 0,
		hardFailures: valid ? [] : [message],
		assertions: [{ id: "output.present", kind: "schema", passed: valid, message, evidence: ["raw-response.txt"] }],
		dimensions: [],
	};
}
