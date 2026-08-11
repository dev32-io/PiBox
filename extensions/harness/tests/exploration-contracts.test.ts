import assert from "node:assert/strict";
import test from "node:test";
import { validateExplorationAssignment, validateExplorationHandoff, type ExplorationAssignment, type ExplorationHandoff } from "../exploration-contracts.js";

const assignment = (mode: ExplorationAssignment["mode"]): ExplorationAssignment => ({
	schemaVersion: 1, mode, question: "Where does the value originate?", decisionSupported: "Choose the repair boundary", knownEvidence: [], scope: { start: ["src"] }, depth: "standard", stopConditions: ["Origin is cited"], requiredOutput: ["Answer with evidence"],
});

const handoff = (mode: ExplorationAssignment["mode"]): ExplorationHandoff => ({
	schemaVersion: 1, type: "exploration_complete", agentId: "agent", attemptId: "attempt", mode, answer: "The value originates in loadConfig.", evidence: [{ path: "src/config.ts", line: 12, symbol: "loadConfig", observation: "Reads the value." }], unknowns: [], completedAt: new Date().toISOString(),
});

test("validates substantive typed exploration assignments", () => {
	validateExplorationAssignment(assignment("lookup"));
	assert.throws(() => validateExplorationAssignment({ ...assignment("lookup"), decisionSupported: "" }), /decisionSupported/);
	assert.throws(() => validateExplorationAssignment({ ...assignment("lookup"), scope: { start: [] } }), /starting scope/);
});

test("enforces mode-sensitive exploration completion", () => {
	assert.throws(() => validateExplorationHandoff(handoff("map"), assignment("map")), /observedSystem/);
	validateExplorationHandoff({ ...handoff("map"), observedSystem: "index.ts loads config.ts" }, assignment("map"));
	assert.throws(() => validateExplorationHandoff(handoff("trace"), assignment("trace")), /dataFlow/);
	validateExplorationHandoff({ ...handoff("trace"), dataFlow: ["input -> loadConfig -> runtime"] }, assignment("trace"));
	assert.throws(() => validateExplorationHandoff(handoff("impact"), assignment("impact")), /changeImplications/);
	validateExplorationHandoff({ ...handoff("impact"), changeImplications: ["Update callers"] }, assignment("impact"));
	assert.throws(() => validateExplorationHandoff(handoff("explain"), assignment("explain")), /mental model/);
	validateExplorationHandoff({ ...handoff("explain"), mentalModel: "Configuration overlays defaults.", nextReading: ["src/config.ts"] }, assignment("explain"));
});

test("requires diagnostic evidence before claiming a cause", () => {
	const diagnostic = assignment("diagnose");
	assert.throws(() => validateExplorationHandoff(handoff("diagnose"), diagnostic), /expected, actual, and reproduction/);
	validateExplorationHandoff({ ...handoff("diagnose"), expectedBehavior: "one charge", actualBehavior: "two charges", reproduction: "confirmed with two clicks", hypotheses: [{ statement: "duplicate requests", supportingEvidence: ["two traces"], conflictingEvidence: [], confidence: "high" }], proximateCause: "two POST requests", upstreamCondition: "enabled action remains available" }, diagnostic);
});
