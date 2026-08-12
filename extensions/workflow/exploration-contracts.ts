import { HarnessError } from "./errors.js";

export type ExplorationMode = "lookup" | "map" | "trace" | "impact" | "diagnose" | "explain";
export type ExplorationDepth = "quick" | "standard" | "thorough";

export interface ExplorationAssignment {
	schemaVersion: 1;
	mode: ExplorationMode;
	question: string;
	decisionSupported: string;
	knownEvidence: Array<{ source: string; observation: string }>;
	scope: { start: string[]; exclude?: string[] };
	depth: ExplorationDepth;
	stopConditions: string[];
	requiredOutput: string[];
}

export interface ExplorationHandoff {
	schemaVersion: 1;
	type: "exploration_complete";
	agentId: string;
	attemptId: string;
	mode: ExplorationMode;
	answer: string;
	evidence: Array<{ path: string; line?: number; symbol?: string; observation: string }>;
	unknowns: string[];
	observedSystem?: string;
	dataFlow?: string[];
	workingComparison?: string;
	changeImplications?: string[];
	hiddenCases?: string[];
	expectedBehavior?: string;
	actualBehavior?: string;
	reproduction?: string;
	hypotheses?: Array<{ statement: string; supportingEvidence: string[]; conflictingEvidence: string[]; confidence: "low" | "medium" | "high" }>;
	proximateCause?: string;
	upstreamCondition?: string;
	mentalModel?: string;
	nextReading?: string[];
	nextProbe?: string;
	completedAt: string;
}

const substantive = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;

export function validateExplorationAssignment(value: ExplorationAssignment): void {
	if (value.schemaVersion !== 1) throw new HarnessError("INVALID_ARTIFACT", "Exploration assignment schemaVersion must be 1");
	for (const [name, field] of [["question", value.question], ["decisionSupported", value.decisionSupported]] as const) {
		if (!substantive(field)) throw new HarnessError("INVALID_ARTIFACT", `Exploration assignment requires ${name}`);
	}
	if (!value.scope.start.length || value.scope.start.some((entry) => !substantive(entry))) throw new HarnessError("INVALID_ARTIFACT", "Exploration assignment requires a starting scope");
	if (!value.stopConditions.length || value.stopConditions.some((entry) => !substantive(entry))) throw new HarnessError("INVALID_ARTIFACT", "Exploration assignment requires stop conditions");
	if (!value.requiredOutput.length || value.requiredOutput.some((entry) => !substantive(entry))) throw new HarnessError("INVALID_ARTIFACT", "Exploration assignment requires output expectations");
}

export function validateExplorationHandoff(value: ExplorationHandoff, assignment: ExplorationAssignment): void {
	if (value.schemaVersion !== 1 || value.type !== "exploration_complete" || value.mode !== assignment.mode) throw new HarnessError("INVALID_HANDOFF", "Exploration handoff identity or mode is invalid");
	if (!substantive(value.answer) || value.evidence.length === 0 || value.evidence.some((entry) => !substantive(entry.path) || !substantive(entry.observation))) {
		throw new HarnessError("INVALID_HANDOFF", "Exploration completion requires an answer and cited evidence");
	}
	const require = (condition: boolean, message: string) => { if (!condition) throw new HarnessError("INVALID_HANDOFF", message); };
	switch (assignment.mode) {
		case "map": require(substantive(value.observedSystem), "Map completion requires observedSystem"); break;
		case "trace": require(Boolean(value.dataFlow?.length), "Trace completion requires dataFlow"); break;
		case "impact": require(Boolean(value.changeImplications?.length), "Impact completion requires changeImplications"); break;
		case "diagnose":
			require(substantive(value.expectedBehavior) && substantive(value.actualBehavior) && substantive(value.reproduction), "Diagnostic completion requires expected, actual, and reproduction evidence");
			require(Boolean(value.hypotheses?.length), "Diagnostic completion requires competing or tested hypotheses");
			require(substantive(value.proximateCause) || substantive(value.nextProbe), "Diagnostic completion requires a proximate cause or next probe");
			break;
		case "explain": require(substantive(value.mentalModel) && Boolean(value.nextReading?.length), "Explain completion requires a mental model and next reading"); break;
		case "lookup": break;
	}
}
