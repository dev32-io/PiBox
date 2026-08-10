import { HarnessError } from "./errors.js";

export type NarrativeArtifactType = "intent" | "spec" | "design" | "decision";
export type SemanticSections = Record<string, unknown>;

const PLACEHOLDER = /^(?:n\/?a|none|tbd|todo|placeholder|coming soon)[.!]?$/i;

const PROFILES: Record<NarrativeArtifactType, { required: string[]; optional: string[] }> = {
	intent: { required: ["problem", "desiredOutcome", "scopeIncluded", "successSignals"], optional: ["scopeExcluded", "constraints", "assumptions", "openQuestions"] },
	spec: { required: ["context", "requiredBehaviors", "acceptanceCriteria"], optional: ["actors", "constraints", "edgeCases", "assumptions", "outOfScope", "openQuestions"] },
	design: { required: ["designGoal", "chosenApproach", "verificationBoundaries"], optional: ["componentsAndInterfaces", "dataAndControlFlow", "failureAndRecovery", "securityAndPrivacy", "compatibilityAndMigration", "alternativesConsidered", "openQuestions"] },
	decision: { required: ["decision", "context", "rationale", "consequences"], optional: ["alternativesConsidered", "revisitWhen"] },
};

const HEADINGS: Record<string, string> = {
	problem: "Problem", desiredOutcome: "Desired Outcome", scopeIncluded: "Scope — Included", scopeExcluded: "Scope — Excluded", successSignals: "Success Signals",
	context: "Context", actors: "Actors", requiredBehaviors: "Required Behaviors", acceptanceCriteria: "Acceptance Criteria", constraints: "Constraints", edgeCases: "Edge Cases", assumptions: "Assumptions", outOfScope: "Out of Scope", openQuestions: "Open Questions",
	designGoal: "Design Goal", chosenApproach: "Chosen Approach", componentsAndInterfaces: "Components and Interfaces", dataAndControlFlow: "Data and Control Flow", failureAndRecovery: "Failure and Recovery", securityAndPrivacy: "Security and Privacy", compatibilityAndMigration: "Compatibility and Migration", verificationBoundaries: "Verification Boundaries", alternativesConsidered: "Alternatives Considered",
	decision: "Decision", rationale: "Rationale", consequences: "Consequences", revisitWhen: "Revisit When",
};

export function isSubstantive(value: unknown): boolean {
	if (typeof value === "string") {
		const visible = value.replace(/<!--[\s\S]*?-->/g, "").trim();
		return Boolean(visible) && !PLACEHOLDER.test(visible);
	}
	if (Array.isArray(value)) return value.length > 0 && value.every(isSubstantive);
	if (value && typeof value === "object") return Object.values(value).length > 0 && Object.values(value).every(isSubstantive);
	return false;
}

function renderValue(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (Array.isArray(value)) return value.map((entry) => `- ${typeof entry === "string" ? entry.trim() : renderObject(entry)}`).join("\n");
	return renderObject(value);
}

function renderObject(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) return String(value);
	return Object.entries(value).map(([key, entry]) => `**${key.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase())}:** ${typeof entry === "string" ? entry : JSON.stringify(entry)}`).join("; ");
}

export function renderArtifact(type: NarrativeArtifactType, title: string, sections: SemanticSections): string {
	const profile = PROFILES[type];
	const allowed = new Set([...profile.required, ...profile.optional, "additionalSections"]);
	for (const key of Object.keys(sections)) if (!allowed.has(key)) throw new HarnessError("INVALID_ARTIFACT", `${type} has unknown semantic field: ${key}`);
	for (const key of profile.required) if (!isSubstantive(sections[key])) throw new HarnessError("INVALID_ARTIFACT", `${type} requires substantive ${key}`);
	for (const [key, value] of Object.entries(sections)) {
		if (key !== "additionalSections" && value !== undefined && !isSubstantive(value)) throw new HarnessError("INVALID_ARTIFACT", `${type} field ${key} is empty or placeholder content`);
	}
	const lines = [`# ${title.trim()}`, ""];
	for (const key of [...profile.required, ...profile.optional]) {
		if (sections[key] === undefined) continue;
		lines.push(`## ${HEADINGS[key]}`, "", renderValue(sections[key]), "");
	}
	const additional = sections.additionalSections;
	if (additional !== undefined) {
		if (!Array.isArray(additional)) throw new HarnessError("INVALID_ARTIFACT", `${type} additionalSections must be an array`);
		const reserved = new Set(Object.values(HEADINGS).map((heading) => heading.toLowerCase()));
		for (const entry of additional) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new HarnessError("INVALID_ARTIFACT", `${type} additional section is invalid`);
			const { title: heading, content } = entry as { title?: unknown; content?: unknown };
			if (!isSubstantive(heading) || !isSubstantive(content)) throw new HarnessError("INVALID_ARTIFACT", `${type} additional section requires substantive title and content`);
			if (reserved.has(String(heading).trim().toLowerCase())) throw new HarnessError("INVALID_ARTIFACT", `${type} additional section collides with reserved heading: ${heading}`);
			lines.push(`## ${String(heading).trim()}`, "", String(content).trim(), "");
		}
	}
	return `${lines.join("\n").trim()}\n`;
}

export function renderEvaluationReport(input: {
	id: string;
	boundary: unknown;
	criteria?: string[];
	observations: string;
	evidence: Array<{ command?: string; result: string; description?: string }>;
	findings: Array<{ id: string; severity: string; status: string; summary: string }>;
	verdict: string;
	residualRisks?: string[];
}): string {
	const evidence = input.evidence.length ? input.evidence.map((entry, index) => `- **EV-${String(index + 1).padStart(3, "0")}:** ${entry.description ?? entry.command ?? "Recorded evidence"} — ${entry.result}`).join("\n") : "None recorded.";
	const findings = input.findings.length ? input.findings.map((finding) => `- **${finding.id}** (${finding.severity}, ${finding.status}): ${finding.summary}`).join("\n") : "None recorded.";
	return `# Evaluation Report: ${input.id}\n\n## Boundary\n\n${JSON.stringify(input.boundary)}\n\n## Criteria Evaluated\n\n${input.criteria?.length ? input.criteria.map((criterion) => `- ${criterion}`).join("\n") : "No qualified criteria declared."}\n\n## Observations\n\n${input.observations.trim()}\n\n## Evidence\n\n${evidence}\n\n## Findings\n\n${findings}\n\n## Verdict\n\n${input.verdict}\n\n## Residual Risk\n\n${input.residualRisks?.length ? input.residualRisks.map((risk) => `- ${risk}`).join("\n") : "None recorded."}\n`;
}

export function acceptanceCriterionIds(sections: SemanticSections): string[] {
	const criteria = sections.acceptanceCriteria;
	if (!Array.isArray(criteria)) return [];
	const ids = criteria.map((criterion) => typeof criterion === "object" && criterion !== null && "id" in criterion ? String(criterion.id) : "");
	if (ids.some((id) => !/^AC-\d{3}$/.test(id))) throw new HarnessError("INVALID_ARTIFACT", "Acceptance criterion IDs must match AC-NNN");
	if (new Set(ids).size !== ids.length) throw new HarnessError("INVALID_ARTIFACT", "Acceptance criterion IDs must be unique within a specification");
	return ids;
}
