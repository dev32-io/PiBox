import type { WorkflowScenarioDefinition } from "../types.js";

export const mixedTopologyScenario: WorkflowScenarioDefinition = {
	id: "mixed-topology",
	title: "Serial, parallel, and assembly stages",
	description: "A serial foundation unlocks two independent contributions which must both finish before serial assembly.",
	categories: ["topology", "parallelism", "autonomy"],
	steps: [
		{ id: "foundation", parallelism: "serial", resourceClaims: ["feature-branch"], delayMs: 5 },
		{ id: "api", dependsOn: ["foundation"], resourceClaims: ["src/api"], delayMs: 25 },
		{ id: "ui", dependsOn: ["foundation"], resourceClaims: ["src/ui"], delayMs: 20 },
		{ id: "assembly", kind: "merge", dependsOn: ["api", "ui"], parallelism: "serial", resourceClaims: ["feature-branch"], delayMs: 5 },
		{ id: "e2e", kind: "evaluation", dependsOn: ["assembly"], resourceClaims: [], delayMs: 5 },
	],
	expect: { terminal: "complete", started: ["foundation", "api", "ui", "assembly", "e2e"], completed: ["foundation", "api", "ui", "assembly", "e2e"], minPeakConcurrency: 2, maxPeakConcurrency: 2 },
};

export const resourceCollisionScenario: WorkflowScenarioDefinition = {
	id: "resource-collision",
	title: "Resource claims serialize otherwise parallel work",
	description: "Two ready steps claim the same resource and must never overlap.",
	categories: ["topology", "resource-claims", "safety"],
	steps: [
		{ id: "left", resourceClaims: ["shared-schema"], delayMs: 20 },
		{ id: "right", resourceClaims: ["shared-schema"], delayMs: 20 },
	],
	expect: { terminal: "complete", started: ["left", "right"], completed: ["left", "right"], minPeakConcurrency: 1, maxPeakConcurrency: 1 },
};

export const blockingFailureScenario: WorkflowScenarioDefinition = {
	id: "blocking-failure",
	title: "Failure pauses without launching dependents",
	description: "A failed contribution must pause once and preserve downstream work for intervention.",
	categories: ["failure", "pause", "safety"],
	steps: [
		{ id: "implement", outcome: "fail", delayMs: 5 },
		{ id: "dependent", dependsOn: ["implement"], delayMs: 5 },
	],
	expect: { terminal: "paused", started: ["implement"], notStarted: ["dependent"], attempts: { implement: 1 } },
};

export const resumeAfterRepairScenario: WorkflowScenarioDefinition = {
	id: "resume-after-repair",
	title: "A stopped attempt resumes under explicit steering",
	description: "The first implementation attempt fails, the workflow is explicitly resumed, and the fresh attempt completes before its dependent.",
	categories: ["failure", "steering", "recovery"],
	steps: [
		{ id: "implement", outcomes: ["fail", "complete"], delayMs: 5 },
		{ id: "verify", kind: "evaluation", dependsOn: ["implement"], delayMs: 5 },
	],
	steering: [{ when: "paused", action: "resume" }],
	expect: { terminal: "complete", started: ["implement", "verify"], completed: ["implement", "verify"], attempts: { implement: 2, verify: 1 }, workflowControls: 1, maxPeakConcurrency: 1 },
};

export const reviewRepairScenario: WorkflowScenarioDefinition = {
	id: "review-repair-loop",
	title: "Blocking review receives focused changes and re-review",
	description: "A failed review pauses at an actionable checkpoint, receives a focused repair prompt, and passes on the retained second review attempt.",
	categories: ["evaluation", "repair", "checkpoint"],
	steps: [
		{ id: "implement", delayMs: 5 },
		{ id: "final-review", kind: "evaluation", dependsOn: ["implement"], outcomes: ["fail", "complete"], delayMs: 5 },
	],
	steering: [{ when: "paused", action: "request_changes", stepId: "final-review", prompt: "Correct the blocking behavior and re-run focused proof." }],
	expect: { terminal: "complete", completed: ["implement", "final-review"], attempts: { implement: 1, "final-review": 2 }, workflowControls: 1, maxPeakConcurrency: 1 },
};

export const acceptResidualRiskScenario: WorkflowScenarioDefinition = {
	id: "accept-residual-risk",
	title: "Manager accepts a justified non-blocking finding",
	description: "A review checkpoint can be completed by an explicit risk decision without launching an unchanged retry.",
	categories: ["evaluation", "risk", "checkpoint"],
	steps: [
		{ id: "implement", delayMs: 5 },
		{ id: "final-review", kind: "evaluation", dependsOn: ["implement"], outcome: "fail", delayMs: 5 },
	],
	steering: [{ when: "paused", action: "accept_risk", stepId: "final-review", prompt: "Accept the documented low-severity cosmetic limitation." }],
	expect: { terminal: "complete", completed: ["implement", "final-review"], attempts: { implement: 1, "final-review": 1 }, workflowControls: 1, maxPeakConcurrency: 1 },
};

export const coreScenarios = [mixedTopologyScenario, resourceCollisionScenario, blockingFailureScenario, resumeAfterRepairScenario, reviewRepairScenario, acceptResidualRiskScenario];
