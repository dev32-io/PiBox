import type { WorkflowStepStatus } from "../workflow-runtime/api.js";

export type ScriptedStepOutcome = "complete" | "fail" | "block" | "cancel";

export interface ScriptedStepDefinition {
	id: string;
	title?: string;
	kind?: "task" | "merge" | "evaluation";
	dependsOn?: string[];
	parallelism?: "allowed" | "serial";
	resourceClaims?: string[];
	outcome?: ScriptedStepOutcome;
	/** Outcome per process attempt; the final value repeats when attempts exceed the list. */
	outcomes?: ScriptedStepOutcome[];
	delayMs?: number;
}

export interface WorkflowScenarioExpectation {
	terminal: "complete" | "paused";
	started?: string[];
	notStarted?: string[];
	completed?: string[];
	minPeakConcurrency?: number;
	maxPeakConcurrency?: number;
	attempts?: Record<string, number>;
	workflowControls?: number;
}

export interface WorkflowScenarioDefinition {
	id: string;
	title: string;
	description: string;
	categories: string[];
	steps: ScriptedStepDefinition[];
	steering?: Array<{
		when: "paused";
		action: "resume" | "stop" | "request_changes" | "approve";
		stepId?: string;
		prompt?: string;
		acceptedRisks?: Array<{ findingId: string; rationale: string }>;
	}>;
	expect: WorkflowScenarioExpectation;
	timeoutMs?: number;
}

export type ScenarioTraceEvent =
	| { sequence: number; type: "workflow_prepared" | "workflow_control"; detail: string }
	| { sequence: number; type: "step_started" | "step_completed" | "step_failed" | "step_blocked" | "step_cancelled"; stepId: string; active: string[] }
	| { sequence: number; type: "workflow_message"; detail: string; attention: boolean };

export interface ScenarioDimension {
	name: "outcome" | "scheduling" | "safety" | "autonomy" | "protocol";
	weight: number;
	score: number;
	findings: string[];
}

export interface WorkflowScenarioResult {
	scenarioId: string;
	passed: boolean;
	score: number;
	terminal: "complete" | "paused" | "timeout";
	peakConcurrency: number;
	stepStatuses: Record<string, WorkflowStepStatus>;
	dimensions: ScenarioDimension[];
	findings: string[];
	trace: ScenarioTraceEvent[];
}

export interface ModelRunObservation {
	scenarioId: string;
	model: string;
	effort: string;
	completed: boolean;
	requiredGatesPassed: boolean;
	protocolViolations: string[];
	safetyViolations: string[];
	expectedClarifications: number;
	relevantClarifications: number;
	irrelevantClarifications: number;
	orchestratorInterventions: number;
	expectedInterventions: number;
	userEscalations: number;
	expectedUserEscalations: number;
	recoveryRequired: boolean;
	recovered: boolean;
	verificationPassed: boolean;
	evidenceComplete: boolean;
	toolCalls: number;
	processAttempts: number;
	inputTokens?: number;
	outputTokens?: number;
}

export interface ModelRunScore {
	scenarioId: string;
	model: string;
	effort: string;
	score: number;
	passed: boolean;
	dimensions: Array<{ name: "outcome" | "protocol" | "autonomy" | "clarification" | "safety" | "verification"; weight: number; score: number; findings: string[] }>;
	metrics: {
		toolCalls: number;
		processAttempts: number;
		orchestratorInterventions: number;
		userEscalations: number;
		clarificationPrecision: number;
		inputTokens?: number;
		outputTokens?: number;
	};
}
