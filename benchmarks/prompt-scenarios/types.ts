import type { ModelTier } from "../../extensions/workflow/types.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ConditionRole = "baseline" | "candidate";

export interface PromptScenario { id: string; title: string; description: string; fixture: string; metadata?: Record<string, JsonValue> }
export interface PromptCondition {
	id: string; role: ConditionRole; title: string; version: string; description: string;
	render(scenario: PromptScenario): { variantId: string; instruction: string; sourceRefs: string[] };
}
export interface ParseOutcome<T = unknown> { syntaxValid: boolean; schemaValid: boolean; strategy: "direct" | "fenced" | "balanced" | "none"; extracted?: string; value?: T; errors: string[] }
export interface BenchmarkAssertion { id: string; kind: "schema" | "hard-failure" | "behavior" | "metric"; passed: boolean; message: string; evidence: string[] }
export interface RubricDimension { id: string; label: string; score: 0 | 1 | 2; maxScore: 2; rationale: string; evidence: string[] }
export interface AutomaticScore { passed: boolean; threshold: number; total: number; maxTotal: number; normalized: number; hardFailures: string[]; assertions: BenchmarkAssertion[]; dimensions: RubricDimension[] }
export interface PromptBenchmarkSuite<T = unknown> {
	id: string; title: string; version: string; scorerVersion: string; description: string; baselineConditionId: string;
	conditions: PromptCondition[]; scenarios: PromptScenario[];
	buildPrompt(scenario: PromptScenario, condition: PromptCondition): { variantId: string; instruction: string; sourceRefs: string[]; prompt: string };
	parse(rawResponse: string): ParseOutcome<T>;
	score(scenario: PromptScenario, parsed: ParseOutcome<T>): AutomaticScore;
}
export type ResolutionAttemptStatus = "model_missing" | "effort_unsupported" | "selected";
export interface ProviderExtensionSelection { provider: string; kind: "builtin" | "trusted-repository-extension"; path?: string }
export interface ResolvedSubjectRoute {
	tier: ModelTier; configuredRoute: string; provider: string; model: string; effort: string; fallbackIndex: number;
	resolutionAttempts: Array<{ configuredRoute: string; status: ResolutionAttemptStatus; supportedEfforts?: string[]; availabilityCommand: string; providerExtension: ProviderExtensionSelection }>;
	providerExtension: ProviderExtensionSelection;
}
export interface SubjectRunRequest { route: ResolvedSubjectRoute; prompt: string; outputDirectory: string; timeoutMs: number }
export interface SubjectRunResult { exitCode: number; provider: string; model: string; effort: string; text: string; stderr: string; events: unknown[] }
export interface PromptSubjectRunner { run(request: SubjectRunRequest): Promise<SubjectRunResult> }
export interface HumanCuration {
	verdict?: "pass" | "fail"; annotator?: string; updatedAt?: string; notes: string[];
	assertionOverrides?: Array<{ assertionId: string; passed: boolean; rationale: string }>;
}
export interface ScenarioRunRecord {
	schemaVersion: 1; runKey: string; suite: { id: string; version: string }; scenario: { id: string; title: string };
	condition: { id: string; role: ConditionRole; version: string; variantId: string; sourceRefs: string[] }; repetition: number; route: ResolvedSubjectRoute;
	prompt: { sha256: string; path: string }; startedAt: string; completedAt: string; durationMs: number; status: "completed" | "runner-error";
	exitCode?: number; artifacts: { request: string; response: string; events: string; stderr: string; errors: string };
	parse: ParseOutcome; automatic: AutomaticScore; scoring: { scorerVersion: string; revision: "original" }; curation: HumanCuration;
	metrics: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}
export interface PromptBenchmarkManifest {
	schemaVersion: 1; runId: string; status: "planned" | "running" | "complete" | "failed"; startedAt: string; completedAt?: string;
	repositoryRoot: string; outputDirectory: string; suite: { id: string; title: string; version: string; scorerVersion: string; baselineConditionId: string };
	selection: { tier: ModelTier; conditions: string[]; scenarios: string[]; repetitions: number; concurrency: number; timeoutMs: number; totalCalls: number };
	config: { digest: string; sources: string[] }; route?: ResolvedSubjectRoute; resolutionError?: string; routeResolutionAttempts?: ResolvedSubjectRoute["resolutionAttempts"]; plannedRunKeys: string[]; completedRunKeys: string[];
}
export interface PromptBenchmarkReport {
	schemaVersion: 1; runId: string; suite: PromptBenchmarkManifest["suite"]; generatedAt: string; manifestPath: string; scoringRevision?: { id: string; scorerVersion: string }; route?: ResolvedSubjectRoute; runs: ScenarioRunRecord[];
	summary: { total: number; automaticPassed: number; effectivePassed: number; runnerErrors: number; byCondition: Array<{ conditionId: string; role: ConditionRole; runs: number; meanAutomaticScore: number; automaticPassed: number; effectivePassed: number }>; comparisons: Array<{ scenarioId: string; baselineConditionId: string; candidateConditionId: string; automaticScoreDelta: number }> };
}
