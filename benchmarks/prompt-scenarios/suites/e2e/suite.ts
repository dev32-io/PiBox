import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PromptBenchmarkSuite, PromptCondition, PromptScenario } from "../../types.js";
import { scoreE2EScenario, type E2EBenchmarkOutput } from "./scorer.js";

const promptFile = (name: string) => readFileSync(fileURLToPath(new URL(`./prompts/${name}`, import.meta.url)), "utf8").trim();
const shapingBaseline = promptFile("baseline-shaping.md");
const planningBaseline = promptFile("baseline-planning.md");
const outsideInCandidate = promptFile("candidate-outside-in.md");

const phase = (scenario: PromptScenario): "shaping" | "planning" => scenario.metadata?.phase === "planning" ? "planning" : "shaping";

const baseline: PromptCondition = {
	id: "current-baseline",
	role: "baseline",
	title: "Current relevant PiBox instruction",
	version: "1.0.0",
	description: "Frozen current shaping or planning E2E instruction.",
	render(scenario) {
		const selectedPhase = phase(scenario);
		return {
			variantId: `current-baseline@1.0.0:${selectedPhase}`,
			instruction: selectedPhase === "planning" ? planningBaseline : shapingBaseline,
			sourceRefs: [selectedPhase === "planning" ? "skills/plan-delivery/SKILL.md" : "skills/shape-story/SKILL.md"],
		};
	},
};

const candidate: PromptCondition = {
	id: "outside-in-candidate",
	role: "candidate",
	title: "Compact outside-in candidate",
	version: "1.0.0",
	description: "Current instruction plus the compact outside-in guidance.",
	render(scenario) {
		const selectedPhase = phase(scenario);
		return {
			variantId: `outside-in-candidate@1.0.0:${selectedPhase}`,
			instruction: `${selectedPhase === "planning" ? planningBaseline : shapingBaseline}\n\n${outsideInCandidate}`,
			sourceRefs: [selectedPhase === "planning" ? "skills/plan-delivery/SKILL.md" : "skills/shape-story/SKILL.md", "benchmarks/prompt-scenarios/suites/e2e/prompts/candidate-outside-in.md"],
		};
	},
};

const scenarios: PromptScenario[] = [
	{
		id: "web-upload-recovery",
		title: "Web upload recovery",
		description: "A small visible journey with validation and retry behavior.",
		metadata: { phase: "shaping" },
		fixture: `Product request: On the web profile page, a signed-in user uploads a JPG avatar and sees the new thumbnail. Unsupported file types are rejected before upload. If storage fails, the selected file remains available and Retry can complete the upload. Tests use fake local storage; mobile apps and image editing are out of scope. Shape a small E2E matrix for user review.`,
	},
	{
		id: "household-delete-permission",
		title: "Household delete permission",
		description: "A focused authorization and privacy boundary.",
		metadata: { phase: "shaping" },
		fixture: `Product request: In the web household notebook, an owner may delete a private note after confirmation. An editor cannot delete it and must not see the private title in the denial response, logs, or network payload. Tests use a disposable household. Mobile clients and note editing are out of scope. Shape a small E2E matrix for user review.`,
	},
	{
		id: "backend-migration-restraint",
		title: "Backend migration restraint",
		description: "A backend-only change where UI journeys would be irrelevant.",
		metadata: { phase: "shaping" },
		fixture: `Product request: Rename nullable database column ledger.memo to ledger.note while the API continues returning “memo” for two releases. Existing null and Unicode values must survive migration and rollback. A restart during migration must allow a safe retry. Verification uses a disposable local database; there are no UI or mobile changes. Shape the smallest useful verification matrix.`,
	},
	{
		id: "cross-surface-task-planning",
		title: "Cross-surface task planning",
		description: "A concise approved journey plus repository proof seams.",
		metadata: { phase: "planning" },
		fixture: `Approved behavior: A user marks a task complete on web and the same task becomes complete on Android without duplication. If sync disconnects after the web action, reconnect converges to the persisted state. Repository context: web and Android drivers are available; the task API can corroborate canonical identity; iOS is unchanged. Reconcile the E2E cases and proof approach. Do not create runtime evaluation resources.`,
	},
	{
		id: "unavailable-ios-planning",
		title: "Unavailable iOS planning",
		description: "A required platform whose executable environment is unavailable.",
		metadata: { phase: "planning" },
		fixture: `Approved behavior: Exporting a trip on Android and iOS opens each platform's system share sheet. Repository context: the Android emulator and driver are available. The iOS implementation is affected, but this environment has no Xcode, simulator, or remote iOS driver; static compilation cannot prove the share-sheet journey. Plan the E2E cases without weakening the requirement or reporting unexecuted behavior as passed.`,
	},
];

const OUTPUT_GUIDANCE = `Return a concise Markdown E2E matrix. Use whatever compact structure best follows the instruction. Make each case understandable as a journey with setup, actions, observable outcomes, evidence or safety notes where useful, and blocked status/reason when proof cannot run. Include questions and exclusions only when they matter. This is authoring/planning, not execution: do not claim that a case passed.`;

export const e2ePromptBenchmarkSuite: PromptBenchmarkSuite<E2EBenchmarkOutput> = {
	id: "e2e-outside-in",
	title: "Outside-in E2E Prompt Benchmark",
	version: "2.0.0",
	scorerVersion: "reviewer-only@2.0.0",
	description: "Small scenario comparison reviewed qualitatively by independent subagents.",
	baselineConditionId: "current-baseline",
	conditions: [baseline, candidate],
	scenarios,
	buildPrompt(scenario, condition) {
		const rendered = condition.render(scenario);
		return {
			...rendered,
			prompt: `You are completing one bounded prompt benchmark. Do not use tools or inspect a repository. Use only the scenario below.\n\n<instruction-condition>\n${rendered.instruction}\n</instruction-condition>\n\n<scenario>\n${scenario.fixture}\n</scenario>\n\n${OUTPUT_GUIDANCE}`,
		};
	},
	parse(rawResponse) {
		const text = rawResponse.trim();
		if (!text) return { syntaxValid: false, schemaValid: false, strategy: "none", errors: ["Subject returned no E2E result."] };
		return { syntaxValid: true, schemaValid: true, strategy: "direct", value: { text }, errors: [] };
	},
	score: scoreE2EScenario,
};
