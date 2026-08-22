import { HarnessError } from "./errors.js";

export type NarrativeArtifactType = "intent" | "spec" | "design" | "decision" | "e2e-matrix" | "taskBrief" | "taskAcceptance";
export type SemanticSections = Record<string, unknown>;

const PLACEHOLDER = /^(?:n\/?a|none|tbd|todo|placeholder|coming soon)[.!]?$/i;

const PROFILES: Record<NarrativeArtifactType, { required: string[]; optional: string[] }> = {
	intent: { required: ["problem", "desiredOutcome", "scopeIncluded", "successSignals"], optional: ["scopeExcluded", "constraints", "assumptions", "openQuestions"] },
	spec: { required: ["context", "requiredBehaviors", "acceptanceCriteria"], optional: ["domainLanguage", "actors", "scenarios", "constraints", "edgeCases", "assumptions", "outOfScope", "openQuestions"] },
	design: { required: ["designGoal", "chosenApproach", "verificationBoundaries"], optional: ["componentsAndInterfaces", "dataAndControlFlow", "failureAndRecovery", "securityAndPrivacy", "compatibilityAndMigration", "alternativesConsidered", "openQuestions"] },
	decision: { required: ["decision", "context", "rationale", "consequences"], optional: ["alternativesConsidered", "revisitWhen"] },
	"e2e-matrix": { required: ["cases"], optional: ["scope", "safety", "notes"] },
	taskBrief: { required: ["contributionGoal", "boundaryIncluded", "requiredWork", "integrationExpectation"], optional: ["context", "boundaryExcluded", "interfacesAndDependencies", "constraints", "risksAndUncertainties"] },
	// Legacy contracts use criterionContributions; new contracts carry direct,
	// self-contained acceptance statements. Deliverables is the common anchor.
	taskAcceptance: { required: ["deliverables"], optional: ["acceptance", "criterionContributions", "boundaryProof", "expectedIntermediateState", "integrationProof"] },
};

const HEADINGS: Record<string, string> = {
	problem: "Problem", desiredOutcome: "Desired Outcome", scopeIncluded: "Scope — Included", scopeExcluded: "Scope — Excluded", successSignals: "Success Signals",
	context: "Context", domainLanguage: "Domain Language", actors: "Actors", requiredBehaviors: "Required Behaviors", acceptanceCriteria: "Acceptance Criteria", scenarios: "Scenarios", constraints: "Constraints", edgeCases: "Edge Cases", assumptions: "Assumptions", outOfScope: "Out of Scope", openQuestions: "Open Questions",
	designGoal: "Design Goal", chosenApproach: "Chosen Approach", componentsAndInterfaces: "Components and Interfaces", dataAndControlFlow: "Data and Control Flow", failureAndRecovery: "Failure and Recovery", securityAndPrivacy: "Security and Privacy", compatibilityAndMigration: "Compatibility and Migration", verificationBoundaries: "Verification Boundaries", alternativesConsidered: "Alternatives Considered",
	decision: "Decision", rationale: "Rationale", consequences: "Consequences", revisitWhen: "Revisit When",
	cases: "Cases", scope: "Scope", safety: "Safety", notes: "Notes",
	contributionGoal: "Contribution Goal", boundaryIncluded: "Boundary — Included", boundaryExcluded: "Boundary — Excluded", requiredWork: "Required Work", interfacesAndDependencies: "Interfaces and Dependencies", integrationExpectation: "Integration Expectation", risksAndUncertainties: "Risks and Uncertainties",
	deliverables: "Deliverables", acceptance: "Acceptance", criterionContributions: "Criterion Contributions", boundaryProof: "Boundary Proof", expectedIntermediateState: "Expected Intermediate State", integrationProof: "Integration Proof",
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

function validateE2EMatrixCases(value: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(value) || value.length === 0) throw new HarnessError("INVALID_ARTIFACT", "e2e-matrix requires at least one substantive case");
	const required = ["id", "classification", "journey", "setup", "actions", "expectedOutcomes", "evidence"];
	const allowed = new Set([...required, "safety"]);
	const ids = new Set<string>();
	return value.map((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new HarnessError("INVALID_ARTIFACT", "Each E2E matrix case must be a mapping");
		const record = entry as Record<string, unknown>;
		for (const key of Object.keys(record)) if (!allowed.has(key)) throw new HarnessError("INVALID_ARTIFACT", `E2E matrix case has unknown field: ${key}`);
		for (const key of required) if (!isSubstantive(record[key])) throw new HarnessError("INVALID_ARTIFACT", `E2E matrix case requires substantive ${key}`);
		const id = String(record.id);
		if (!/^E2E-\d{3}$/.test(id)) throw new HarnessError("INVALID_ARTIFACT", "E2E matrix case IDs must match E2E-NNN");
		if (ids.has(id)) throw new HarnessError("INVALID_ARTIFACT", `Duplicate E2E matrix case ID: ${id}`);
		ids.add(id);
		if (!["golden-path", "edge", "failure", "recovery"].includes(String(record.classification))) throw new HarnessError("INVALID_ARTIFACT", `Invalid E2E matrix classification for ${id}`);
		for (const key of ["setup", "actions", "expectedOutcomes", "evidence", "safety"]) if (record[key] !== undefined && (!Array.isArray(record[key]) || !isSubstantive(record[key]))) throw new HarnessError("INVALID_ARTIFACT", `E2E matrix case ${id} field ${key} must be a substantive list`);
		return record;
	});
}

function renderE2ECases(value: unknown): string {
	return validateE2EMatrixCases(value).map((entry) => {
		const lines = [`### ${entry.id} — ${entry.journey}`, "", `**Classification:** ${entry.classification}`];
		for (const [key, heading] of [["setup", "Setup"], ["actions", "Actions"], ["expectedOutcomes", "Expected Outcomes"], ["evidence", "Evidence"], ["safety", "Safety"]] as const) {
			if (entry[key] !== undefined) lines.push("", `#### ${heading}`, "", renderValue(entry[key]));
		}
		return lines.join("\n");
	}).join("\n\n");
}

export function renderArtifact(type: NarrativeArtifactType, title: string, sections: SemanticSections): string {
	const profile = PROFILES[type];
	const allowed = new Set([...profile.required, ...profile.optional, "additionalSections"]);
	for (const key of Object.keys(sections)) if (!allowed.has(key)) throw new HarnessError("INVALID_ARTIFACT", `${type} has unknown semantic field: ${key}`);
	for (const key of profile.required) if (!isSubstantive(sections[key])) throw new HarnessError("INVALID_ARTIFACT", `${type} requires substantive ${key}`);
	for (const [key, value] of Object.entries(sections)) {
		if (key !== "additionalSections" && value !== undefined && !isSubstantive(value)) throw new HarnessError("INVALID_ARTIFACT", `${type} field ${key} is empty or placeholder content`);
	}
	if (type === "e2e-matrix") validateE2EMatrixCases(sections.cases);
	const lines = [`# ${title.trim()}`, ""];
	for (const key of [...profile.required, ...profile.optional]) {
		if (sections[key] === undefined) continue;
		const body = type === "e2e-matrix" && key === "cases"
			? renderE2ECases(sections[key])
			: key === "acceptanceCriteria" && Array.isArray(sections[key])
				? sections[key].map((criterion) => {
					const value = criterion as { id?: unknown; statement?: unknown };
					return `- **${String(value.id)}:** ${String(value.statement)}`;
				}).join("\n")
				: renderValue(sections[key]);
		lines.push(`## ${HEADINGS[key]}`, "", body, "");
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

export function renderOutcome(input: {
	title: string;
	delivered: string[];
	verification: string[];
	deviations?: string[];
	remainingFindings?: string[];
	residualRisks?: string[];
	followUp?: string[];
}): string {
	if (!isSubstantive(input.delivered) || !isSubstantive(input.verification)) throw new HarnessError("INVALID_ARTIFACT", "Outcome requires delivered and verification content");
	const sections: Array<[string, string[] | undefined]> = [
		["Delivered", input.delivered], ["Verification", input.verification], ["Contract Deviations", input.deviations], ["Remaining Findings", input.remainingFindings], ["Residual Risks", input.residualRisks], ["Follow-up", input.followUp],
	];
	return `# Outcome: ${input.title}\n\n${sections.filter(([, values]) => values?.length).map(([heading, values]) => `## ${heading}\n\n${values?.map((value) => `- ${value}`).join("\n")}`).join("\n\n")}\n`;
}

export function renderEvaluationReport(input: {
	id: string;
	boundary: unknown;
	criteria?: string[];
	observations: string;
	evidence: Array<{ command?: string; result: string; description?: string }>;
	findings: Array<{ id: string; severity: string; status: string; summary: string }>;
	caseResults?: Array<{ caseId: string; status: string; executedActions: string[]; observations: string[]; evidenceRefs: string[] }>;
	verdict: string;
	residualRisks?: string[];
}): string {
	const evidence = input.evidence.length ? input.evidence.map((entry, index) => `- **EV-${String(index + 1).padStart(3, "0")}:** ${entry.description ?? entry.command ?? "Recorded evidence"} — ${entry.result}`).join("\n") : "None recorded.";
	const findings = input.findings.length ? input.findings.map((finding) => `- **${finding.id}** (${finding.severity}, ${finding.status}): ${finding.summary}`).join("\n") : "None recorded.";
	const caseResults = input.caseResults?.length ? input.caseResults.map((result) => `- **${result.caseId}** (${result.status}) — ${result.observations.join(" ") || "No observation recorded."}`).join("\n") : undefined;
	return `# Evaluation Report: ${input.id}\n\n## Boundary\n\n${JSON.stringify(input.boundary)}\n\n## Criteria Evaluated\n\n${input.criteria?.length ? input.criteria.map((criterion) => `- ${criterion}`).join("\n") : "No qualified criteria declared."}\n\n## Observations\n\n${input.observations.trim()}\n\n## Evidence\n\n${evidence}${caseResults ? `\n\n## E2E Case Results\n\n${caseResults}` : ""}\n\n## Findings\n\n${findings}\n\n## Verdict\n\n${input.verdict}\n\n## Residual Risk\n\n${input.residualRisks?.length ? input.residualRisks.map((risk) => `- ${risk}`).join("\n") : "None recorded."}\n`;
}

export function acceptanceCriterionIds(sections: SemanticSections): string[] {
	const criteria = sections.acceptanceCriteria;
	if (!Array.isArray(criteria)) return [];
	const ids = criteria.map((criterion) => typeof criterion === "object" && criterion !== null && "id" in criterion ? String(criterion.id) : "");
	if (ids.some((id) => !/^AC-\d{3}$/.test(id))) throw new HarnessError("INVALID_ARTIFACT", "Acceptance criterion IDs must match AC-NNN");
	if (new Set(ids).size !== ids.length) throw new HarnessError("INVALID_ARTIFACT", "Acceptance criterion IDs must be unique within a specification");
	return ids;
}
