import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractStructuredJson } from "../../json.js";
import type { ParseOutcome, PromptBenchmarkSuite, PromptCondition, PromptScenario } from "../../types.js";
import { scoreE2EScenario, type E2EBenchmarkOutput } from "./scorer.js";

const promptFile = (name: string) => readFileSync(fileURLToPath(new URL(`./prompts/${name}`, import.meta.url)), "utf8").trim();
const shapingBaseline = promptFile("baseline-shaping.md");
const planningBaseline = promptFile("baseline-planning.md");
const outsideInCandidate = promptFile("candidate-outside-in.md");

function phase(scenario: PromptScenario): "shaping" | "planning" {
	return scenario.metadata?.phase === "planning" ? "planning" : "shaping";
}

const baseline: PromptCondition = {
	id: "current-baseline",
	role: "baseline",
	title: "Current relevant PiBox instruction",
	version: "1.0.0",
	description: "Frozen faithful excerpt of the current shaping or planning E2E behavior.",
	render(scenario) {
		const selectedPhase = phase(scenario);
		return {
			variantId: `current-baseline@1.0.0:${selectedPhase}`,
			instruction: selectedPhase === "planning" ? planningBaseline : shapingBaseline,
			sourceRefs: selectedPhase === "planning" ? ["skills/plan-delivery/SKILL.md"] : ["skills/shape-story/SKILL.md"],
		};
	},
};

const candidate: PromptCondition = {
	id: "outside-in-candidate",
	role: "candidate",
	title: "Compact obligation-first outside-in candidate",
	version: "1.0.0",
	description: "Current behavior plus the compact evidence-backed outside-in derivation and planning amendment gate.",
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
		id: "calendar-shaping-replay",
		title: "Calendar shaping replay",
		description: "Derive a small matrix across calendar actors, surfaces, transitions, recurrence, failures, and privacy.",
		metadata: { phase: "shaping", sourceIds: ["SPEC-CAL-1", "SPEC-CAL-2", "SPEC-CAL-3", "SPEC-CAL-4", "DESIGN-CAL-1", "SCOPE"], requiredConcepts: ["web", "android", "ios", "create", "update", "delete", "recurrence", "timezone", "loading", "error", "privacy"], requiredRisks: ["permission", "privacy", "recurrence", "timezone", "failure"], expectedPlatforms: ["web", "android", "ios"], maxCases: 12 },
		fixture: `Fictional product: Northstar family calendar.\n\nSources:\n- SPEC-CAL-1: An adult can create, view, update, and delete their events on web. Android and iOS can create and view; mobile edit/delete parity is a product question.\n- SPEC-CAL-2: A covering query returns every recurring occurrence overlapping the requested time window, including all-day and timezone-boundary occurrences.\n- SPEC-CAL-3: Private event title and notes are visible only to the owner; household viewers see only “Busy”.\n- SPEC-CAL-4: All surfaces show a loading state and a recoverable error when calendar sync fails.\n- DESIGN-CAL-1: Web uses HTTPS UI; native apps use their own driver. A calendar API and persisted occurrence state can corroborate hidden recurrence/privacy invariants.\n- SCOPE: Calendar behavior only. Notification delivery and external calendar import are excluded.\n\nShape a conservative E2E matrix for user review. Do not decide the unresolved mobile parity question.`,
	},
	{
		id: "calendar-planning-reconciliation",
		title: "Calendar planning reconciliation with contradiction",
		description: "Reconcile repository evidence and a seeded approved-matrix contradiction without silent mutation.",
		metadata: { phase: "planning", sourceIds: ["AC-005", "AC-009", "REPO-1", "REPO-2", "REPO-3"], contradictionRequired: true, requiredConcepts: ["covering", "week", "update", "delete", "android", "ios", "amendment"], requiredRisks: ["contradiction", "platform", "state transition"], expectedPlatforms: ["web", "android", "ios"], maxCases: 10 },
		fixture: `Fictional approved contract:\n- AC-005: A covering query returns every recurring occurrence that overlaps its requested time window; it does not return occurrences outside that window.\n- AC-009: Web users can create, update, and delete events.\n- Approved journey: An adult creates an event on web and sees it in week view.\n- Approved journey: A ten-occurrence daily series shows all ten occurrences in one selected seven-day week view.\n- Approved journey: The mobile app shows a newly created event. Platform is not named.\n\nRepository evidence:\n- REPO-1: The ten daily occurrences span ten consecutive dates. Only seven fall inside any selected seven-day week; the other three are outside that selected week. The week view intentionally clips to its selected seven-day window, so showing all ten in one week is impossible and would violate AC-005 covering-window semantics.\n- REPO-2: Existing web drivers cover create and read only; update and delete are affected user paths with stable selectors.\n- REPO-3: Android has a working Maestro driver. The required iOS simulator driver exists and is available, but its selectors differ.\n\nReconcile the E2E cases against repository reality. Add missing affected journeys and surface the product contradiction for review. Do not create runtime evaluation resources.`,
	},
	{
		id: "backend-migration-restraint",
		title: "Backend-only migration restraint",
		description: "Select operational migration proof while excluding irrelevant UI/platform combinations.",
		metadata: { phase: "shaping", sourceIds: ["MIG-1", "MIG-2", "MIG-3", "OPS-1", "SCOPE"], requiredConcepts: ["migration", "rollback", "compatibility", "restart", "data"], requiredRisks: ["destructive", "recovery", "compatibility"], forbiddenConcepts: ["viewport matrix", "android", "ios", "browser"], expectedPlatforms: [], compatibilityWindow: "two-release", productionEnforcementUnsupported: true, maxCases: 5 },
		fixture: `Fictional service: Harbor ledger.\n\n- MIG-1: Rename nullable column ledger.memo to ledger.note without changing the public API response field “memo” during a two-release compatibility window.\n- MIG-2: Existing rows, including null and unicode values, must survive forward migration and rollback.\n- MIG-3: A process restart during the migration must stop safely and permit an idempotent retry.\n- OPS-1: The migration runs only against a disposable local database snapshot; never production.\n- SCOPE: Database migration and API compatibility only. No user interface or mobile client changes.\n\nShape the smallest useful outside-in/operational matrix.`,
	},
	{
		id: "household-permissions-privacy",
		title: "Household permissions and privacy",
		description: "Cover materially different actors, permission decisions, early denial, and absence of leaked details.",
		metadata: { phase: "shaping", sourceIds: ["PERM-1", "PERM-2", "PRIV-1", "SAFE-1"], requiredConcepts: ["adult", "child", "guest", "allow", "cancel", "deny", "prompt", "store", "privacy"], requiredRisks: ["authorization", "privacy"], expectedPlatforms: ["web"], maxCases: 8, authorizationCritical: true },
		fixture: `Fictional product: Hearth chores on web.\n\n- PERM-1: An adult may request a paid chore purchase. A confirmation dialog shows item and price; Allow creates one order, Cancel creates none.\n- PERM-2: A child or guest is prohibited. Denial occurs before the purchase policy prompt and before any store call.\n- PRIV-1: Child and guest responses, UI, logs, and network payloads must not reveal the adult payment token, full order details, or another household member’s private note.\n- SAFE-1: E2E uses a fake local store and disposable household.\n\nShape a risk-selected matrix; do not combine actors whose authority changes the behavior.`,
	},
	{
		id: "cross-surface-transition",
		title: "Cross-surface state transition",
		description: "Follow one stateful journey across agent, web, and mobile instead of enumerating APIs.",
		metadata: { phase: "shaping", sourceIds: ["FLOW-1", "FLOW-2", "FLOW-3", "FLOW-4", "SCOPE"], requiredConcepts: ["agent", "web", "mobile", "create", "edit", "observe", "delete", "propagation"], requiredRisks: ["state transition", "cross-surface", "consistency"], expectedPlatforms: ["agent", "web", "mobile"], maxCases: 6 },
		fixture: `Fictional product: Relay shopping list.\n\n- FLOW-1: A household adult asks the assistant agent to create “oats”; the web list shows it without reload.\n- FLOW-2: The adult edits quantity to 2 on web; Android and iOS clients eventually show quantity 2 with one canonical item identity.\n- FLOW-3: The adult deletes the item on mobile; agent and web reads no longer return it.\n- FLOW-4: If propagation disconnects after the web edit, reconnect converges to the persisted quantity without a duplicate.\n- SCOPE: One disposable household and one list. Styling and unrelated list sorting are excluded.\n\nShape a minimal journey matrix that follows state across surfaces.`,
	},
	{
		id: "unavailable-required-platform",
		title: "Unavailable required platform handling",
		description: "Keep an unavailable required platform visible and blocked rather than claiming pass or omitting it.",
		metadata: { phase: "planning", sourceIds: ["AC-MOB-1", "REPO-MOB-1", "REPO-MOB-2"], unavailablePlatform: "ios", infrastructureBlockOnly: true, requiredConcepts: ["android", "ios", "blocked", "driver", "environment"], requiredRisks: ["platform", "feasibility"], expectedPlatforms: ["android", "ios"], maxCases: 6 },
		fixture: `Fictional approved contract:\n- AC-MOB-1: Exporting a trip must work on both Android and iOS, and each platform must show its system share sheet.\n\nRepository/environment evidence:\n- REPO-MOB-1: Android emulator and tagged Maestro flow are available.\n- REPO-MOB-2: The iOS implementation is affected and required, but this execution environment has no Xcode, iOS simulator, or remote iOS driver. Static compilation evidence alone cannot establish the share-sheet journey. This is an execution-infrastructure limitation, not evidence that approved product behavior or scope must change.\n\nPlan the verification cases. Android proof may proceed; iOS must remain explicit and blocked pending an executable iOS environment. Do not propose a product/matrix amendment unless expected behavior or scope changes; none is evidenced here. Do not weaken the requirement, omit iOS, or report an unexecuted platform as passed.`,
	},
];

const OUTPUT_CONTRACT = `Return exactly one JSON object and no Markdown. Use this neutral matrix envelope:\n{
  "summary": "short rationale",
  "cases": [{
    "id":"stable case ID", "classification":"golden-path|edge|failure|recovery",
    "actor":"actor/system", "entrySurface":"outward surface", "startingState":"pre-state",
    "actions":["action/event"], "visibleOutcomes":["observable result"], "finalInvariant":"final state",
    "requirementRefs":["fixture source ID"], "technicalEvidence":["corroboration if needed"],
    "setupCleanup":["bounded setup/cleanup"], "safety":["constraint"], "platforms":["applicable platform"],
    "status":"planned|blocked|not-applicable", "blockedReason":"only when blocked"
  }],
  "questions": ["unresolved question"],
  "exclusions": [{"scope":"excluded dimension","rationale":"why","sourceRefs":["fixture source ID"]}],
  "instructionArtifacts": {}
}\nUse empty arrays/objects when sections do not apply. The optional instructionArtifacts object is free-form space for structures specifically required by the instruction condition; no keys or candidate method are prescribed. Since this is authoring/planning rather than execution, never use a passed status.`;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0);
function validateOutput(value: unknown): string[] {
	const errors: string[] = [];
	if (!isRecord(value)) return ["Top-level output must be an object."];
	if (typeof value.summary !== "string") errors.push("summary must be a string.");
	for (const field of ["cases", "questions", "exclusions"]) if (!Array.isArray(value[field])) errors.push(`${field} must be an array.`);
	if (value.instructionArtifacts !== undefined && !isRecord(value.instructionArtifacts)) errors.push("instructionArtifacts must be an object when present.");
	const validateUnique = (items: unknown[], field: string) => {
		const ids = new Set<string>();
		items.forEach((item, index) => { if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) errors.push(`${field}[${index}].id must be a non-empty string.`); else if (ids.has(item.id)) errors.push(`${field} IDs must be unique: ${item.id}.`); else ids.add(item.id); });
		return ids;
	};
	const cases = Array.isArray(value.cases) ? value.cases : [];
	validateUnique(cases, "cases");
	cases.forEach((item, index) => {
		if (!isRecord(item)) { errors.push(`cases[${index}] must be an object.`); return; }
		for (const field of ["id", "classification", "actor", "entrySurface", "startingState", "finalInvariant", "status"]) if (typeof item[field] !== "string" || !(item[field] as string).trim()) errors.push(`cases[${index}].${field} must be a non-empty string.`);
		for (const field of ["actions", "visibleOutcomes", "requirementRefs", "technicalEvidence", "setupCleanup", "safety", "platforms"]) if (!strings(item[field]) && !(Array.isArray(item[field]) && item[field].length === 0)) errors.push(`cases[${index}].${field} must contain only non-empty strings.`);
		if (!["golden-path", "edge", "failure", "recovery"].includes(String(item.classification))) errors.push(`cases[${index}].classification is unsupported.`);
		if (!["planned", "blocked", "not-applicable"].includes(String(item.status))) errors.push(`cases[${index}].status is unsupported.`);
		if (item.status === "blocked" && (typeof item.blockedReason !== "string" || !item.blockedReason.trim())) errors.push(`cases[${index}].blockedReason is required for blocked status.`);
	});
	if (Array.isArray(value.questions) && !strings(value.questions) && value.questions.length) errors.push("questions must contain only non-empty strings.");
	const exclusions = Array.isArray(value.exclusions) ? value.exclusions : [];
	exclusions.forEach((item, index) => { if (!isRecord(item) || typeof item.scope !== "string" || typeof item.rationale !== "string" || !strings(item.sourceRefs)) errors.push(`exclusions[${index}] must have scope, rationale, and non-empty sourceRefs.`); });
	return errors;
}

export const e2ePromptBenchmarkSuite: PromptBenchmarkSuite<E2EBenchmarkOutput> = {
	id: "e2e-outside-in",
	title: "Outside-in E2E Prompt Benchmark",
	version: "1.2.0",
	scorerVersion: "e2e-scorer@1.2.0",
	description: "Behavioral comparison of current and candidate E2E matrix derivation/reconciliation instructions.",
	baselineConditionId: "current-baseline",
	conditions: [baseline, candidate],
	scenarios,
	buildPrompt(scenario, condition) {
		const rendered = condition.render(scenario);
		return {
			...rendered,
			prompt: `You are completing a bounded prompt benchmark. Do not use tools or inspect any repository. Treat only the delimited fictional fixture as evidence.\n\n<instruction-condition id="${condition.id}" version="${condition.version}" variant="${rendered.variantId}">\n${rendered.instruction}\n</instruction-condition>\n\n<fictional-fixture id="${scenario.id}">\n${scenario.fixture}\n</fictional-fixture>\n\n${OUTPUT_CONTRACT}\n\nPerform one bounded self-check against the instruction, then emit only the final JSON object.`,
		};
	},
	parse(rawResponse) {
		const extracted = extractStructuredJson(rawResponse);
		if (extracted.strategy !== "direct") {
			const diagnostic = extracted.value === undefined ? "" : ` A nested JSON fragment was recovered for diagnostics via ${extracted.strategy} extraction, but it is not the required exact top-level object.`;
			return { ...extracted, syntaxValid: false, schemaValid: false, errors: [`Response must be exactly one syntactically valid top-level JSON object.${diagnostic}`, ...extracted.errors] } as ParseOutcome<E2EBenchmarkOutput>;
		}
		const schemaErrors = validateOutput(extracted.value);
		return { ...extracted, schemaValid: schemaErrors.length === 0, errors: schemaErrors, value: extracted.value as E2EBenchmarkOutput };
	},
	score: scoreE2EScenario,
};
