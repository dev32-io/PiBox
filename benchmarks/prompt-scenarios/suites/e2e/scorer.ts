import type { AutomaticScore, BenchmarkAssertion, ParseOutcome, PromptScenario, RubricDimension } from "../../types.js";

export interface E2ECase {
	id?: string;
	classification?: string;
	actor?: string;
	entrySurface?: string;
	startingState?: string;
	actions?: string[];
	visibleOutcomes?: string[];
	finalInvariant?: string;
	requirementRefs?: string[];
	technicalEvidence?: string[];
	setupCleanup?: string[];
	safety?: string[];
	platforms?: string[];
	status?: string;
	blockedReason?: string;
}

export interface E2EBenchmarkOutput {
	summary?: string;
	cases?: E2ECase[];
	questions?: string[];
	exclusions?: Array<{ scope?: string; rationale?: string; sourceRefs?: string[] }>;
	instructionArtifacts?: Record<string, unknown>;
}

const DIMENSION_DEFINITIONS = [
	["outside-in", "Outside-in actor/surface/journey quality"],
	["affected-area", "Affected-area coverage and exclusions"],
	["risk-state", "Risk and state transitions"],
	["platform", "Platform and viewport precision"],
	["oracle-evidence", "Visible oracle plus technical corroboration"],
	["feasibility-safety", "Feasibility and safety"],
	["non-redundancy", "Non-redundancy and minimality"],
	["consistency", "Consistency and contradiction detection"],
	["grounding", "Grounding and traceability"],
	["phase-discipline", "Phase discipline"],
] as const;

const list = (scenario: PromptScenario, key: string): string[] => Array.isArray(scenario.metadata?.[key]) ? scenario.metadata![key] as string[] : [];
const flag = (scenario: PromptScenario, key: string): boolean => scenario.metadata?.[key] === true;
const scalar = (scenario: PromptScenario, key: string): string | undefined => typeof scenario.metadata?.[key] === "string" ? scenario.metadata[key] as string : undefined;
const count = (scenario: PromptScenario, key: string, fallback: number): number => typeof scenario.metadata?.[key] === "number" ? scenario.metadata[key] as number : fallback;
const lowerJson = (value: unknown) => { try { return JSON.stringify(value).toLowerCase(); } catch { return ""; } };
const nonEmpty = (value: unknown): boolean => typeof value === "string" ? value.trim().length > 0 : Array.isArray(value) ? value.some(nonEmpty) : false;
const ratio = (hits: number, total: number) => total === 0 ? 1 : hits / total;
const scoreRatio = (value: number): 0 | 1 | 2 => value >= 0.8 ? 2 : value >= 0.45 ? 1 : 0;

function deepStrings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(deepStrings);
	if (value && typeof value === "object") return Object.values(value).flatMap(deepStrings);
	return [];
}

function semanticArtifactStrings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (typeof value === "boolean" || typeof value === "number") return [String(value)];
	if (Array.isArray(value)) return value.flatMap(semanticArtifactStrings);
	if (!value || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, nested]) => {
		const nestedStrings = semanticArtifactStrings(nested);
		if (nestedStrings.length === 0) return [];
		const semanticLabel = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
		return [semanticLabel, ...nestedStrings];
	});
}

function dimension(id: string, label: string, score: 0 | 1 | 2, rationale: string, evidence: string[]): RubricDimension {
	return { id, label, score, maxScore: 2, rationale, evidence };
}

function assertion(id: string, kind: BenchmarkAssertion["kind"], passed: boolean, message: string, evidence: string[]): BenchmarkAssertion {
	return { id, kind, passed, message, evidence };
}

function invalidStructuredScore(parsed: ParseOutcome<E2EBenchmarkOutput>): AutomaticScore {
	const message = `Structured output failure: ${parsed.errors.join("; ")}`;
	const dimensions = DIMENSION_DEFINITIONS.map(([id, label]) => dimension(id, label, 0, "Not scored because the exact top-level JSON response failed syntax or schema validation.", ["raw-response.txt"]));
	return {
		passed: false,
		threshold: 70,
		total: 0,
		maxTotal: dimensions.length * 2,
		normalized: 0,
		hardFailures: [message],
		assertions: [
			assertion("schema.valid", "schema", false, message, ["raw-response.txt", ...parsed.errors]),
			...dimensions.map((entry) => assertion(`rubric.${entry.id}`, "behavior", false, `${entry.label}: not scored because structured output is invalid.`, entry.evidence)),
		],
		dimensions,
	};
}

const AUTHORIZATION_DENIAL = /\b(?:deny|denied|denial|prohibit|prohibited|prohibition)\b/;
const PRODUCTION_ENFORCEMENT = /\b(?:refus(?:e|es|ed|al)|reject(?:s|ed|ion)?|block(?:s|ed|ing)?|prevent(?:s|ed|ion)?|abort(?:s|ed)?|guard(?:s|ed)?|enforc(?:e|es|ed|ement))\b.{0,60}\bproduction\b|\bproduction\b.{0,60}\b(?:refus(?:e|es|ed|al)|reject(?:s|ed|ion)?|block(?:s|ed|ing)?|prevent(?:s|ed|ion)?|abort(?:s|ed)?|guard(?:s|ed)?|enforc(?:e|es|ed|ement))\b/;
const isQuestionLike = (text: string): boolean => /\?|\b(?:question|unknown|unresolved|confirm whether|verify whether|ask whether)\b/i.test(text);
const isSafetyConstraint = (text: string): boolean => /\b(?:safety|operational) (?:constraint|boundary|guardrail)\b/i.test(text);

function explicitArtifactGapStrings(value: unknown, gapContext = false): string[] {
	if (typeof value === "string") return gapContext || isQuestionLike(value) ? [value] : [];
	if (Array.isArray(value)) return value.flatMap((entry) => explicitArtifactGapStrings(entry, gapContext));
	if (!value || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, nested]) => explicitArtifactGapStrings(nested, gapContext || /question|gap|unknown|unresolved/i.test(key)));
}

export function scoreE2EScenario(scenario: PromptScenario, parsed: ParseOutcome<E2EBenchmarkOutput>): AutomaticScore {
	if (!parsed.syntaxValid || !parsed.schemaValid) return invalidStructuredScore(parsed);

	const output = parsed.value ?? {};
	const cases = Array.isArray(output.cases) ? output.cases : [];
	const questions = Array.isArray(output.questions) ? output.questions : [];
	const exclusions = Array.isArray(output.exclusions) ? output.exclusions : [];
	const artifactValueStrings = deepStrings(output.instructionArtifacts);
	const artifactStrings = semanticArtifactStrings(output.instructionArtifacts);
	const artifactGapStrings = explicitArtifactGapStrings(output.instructionArtifacts);
	const artifactText = artifactStrings.join(" ").toLowerCase();
	const behaviorText = lowerJson(cases.map((entry) => ({ actor: entry.actor, entrySurface: entry.entrySurface, startingState: entry.startingState, actions: entry.actions, visibleOutcomes: entry.visibleOutcomes, finalInvariant: entry.finalInvariant, technicalEvidence: entry.technicalEvidence, platforms: entry.platforms, status: entry.status, blockedReason: entry.blockedReason })));
	const questionAndArtifactText = [...questions, ...artifactStrings].join(" ").toLowerCase();
	const reconciliationText = `${artifactText} ${questions.join(" ").toLowerCase()}`;
	const requiredConcepts = list(scenario, "requiredConcepts");
	const requiredRisks = list(scenario, "requiredRisks");
	const expectedPlatforms = list(scenario, "expectedPlatforms");
	const forbiddenConcepts = list(scenario, "forbiddenConcepts");
	const unavailablePlatform = scalar(scenario, "unavailablePlatform");
	const compatibilityWindow = scalar(scenario, "compatibilityWindow");
	const contradictionRequired = flag(scenario, "contradictionRequired");
	const infrastructureBlockOnly = flag(scenario, "infrastructureBlockOnly");
	const planning = scenario.metadata?.phase === "planning";
	const knownSourceRefs = new Set(list(scenario, "sourceIds"));

	const journeyCases = cases.filter((entry) => nonEmpty(entry.actor) && nonEmpty(entry.entrySurface) && nonEmpty(entry.actions) && nonEmpty(entry.visibleOutcomes));
	const allImplementationProbes = cases.length > 0 && journeyCases.length === 0;
	const contradictionHandled = !contradictionRequired || (/contradic|conflict|infeasib|impossible/.test(reconciliationText)
		&& ["AC-005", "REPO-1"].every((id) => reconciliationText.includes(id.toLowerCase())));
	const amendmentSemantics = /\bamend|\bpropos(?:e|ed|al)\b|\brevis(?:e|ed|ion)\b|\bchange (?:the )?(?:approved )?(?:case|matrix|scope|behavior)/.test(reconciliationText);
	const userReviewRequested = /\buser.{0,30}\b(?:review|approval)\b|\b(?:review|approval).{0,30}\brequir(?:e|ed)\b/.test(reconciliationText);
	const amendmentGate = !contradictionRequired || (contradictionHandled && amendmentSemantics && userReviewRequested);
	const noAmendmentStatement = /\bno (?:product\/matrix |product |matrix )?amendment\b|\bamendment (?:is )?not (?:needed|required)\b/.test(reconciliationText);
	const unsupportedInfrastructureAmendment = infrastructureBlockOnly && amendmentSemantics && !noAmendmentStatement && !artifactValueStrings.filter((text) => /amend|propos|revis|change/i.test(text)).every(isQuestionLike);

	const privacyRequired = flag(scenario, "authorizationCritical");
	const privacyCovered = !privacyRequired || (/child/.test(behaviorText) && /guest/.test(behaviorText) && AUTHORIZATION_DENIAL.test(behaviorText) && /privacy|leak|mask|secret|token/.test(behaviorText));
	const destructiveRequired = requiredRisks.includes("destructive");
	const destructiveCovered = !destructiveRequired || (/rollback|recover|restore|idempotent|safe(?:ly)? stop/.test(behaviorText) && /production|disposable|data/.test(lowerJson(cases)));

	const unavailableCases = unavailablePlatform
		? cases.filter((entry) => (entry.platforms ?? []).some((platform) => platform.toLowerCase() === unavailablePlatform))
		: [];
	const unavailableReportedSafely = !unavailablePlatform || (unavailableCases.length > 0
		&& unavailableCases.every((entry) => entry.status === "blocked" && nonEmpty(entry.blockedReason))
		&& !unavailableCases.some((entry) => entry.status === "passed"));
	const environmentRequested = !unavailablePlatform || /\b(?:request|provide|need|require|pending|run (?:it )?(?:in|on))\b.{0,80}\b(?:executable|xcode|simulator|driver|ios environment|capable environment)\b|\b(?:executable|xcode|simulator|driver|ios environment|capable environment)\b.{0,80}\b(?:request|provide|need|require|pending|available)\b/.test(`${questionAndArtifactText} ${unavailableCases.map((entry) => entry.blockedReason ?? "").join(" ").toLowerCase()}`);
	const unsupportedPass = cases.some((entry) => entry.status === "passed");

	const citedSourceRefs = [
		...cases.flatMap((entry) => entry.requirementRefs ?? []),
		...exclusions.flatMap((entry) => entry.sourceRefs ?? []),
	];
	const unsupportedSourceRefs = [...new Set(citedSourceRefs.filter((ref) => typeof ref !== "string" || !knownSourceRefs.has(ref)))].map(String);

	const qualifierText = `${lowerJson(cases)} ${questions.join(" ").toLowerCase()} ${artifactGapStrings.join(" ").toLowerCase()}`;
	const compatibilityDurationPresent = !compatibilityWindow || /\b(?:two|2)[ -]release(?:s)?\b/.test(qualifierText);
	const productionMechanismClaims = cases.flatMap((entry) => [entry.actions, entry.visibleOutcomes, entry.finalInvariant, entry.technicalEvidence].flatMap((value) => Array.isArray(value) ? value : typeof value === "string" ? [value] : []));
	const inventedProductionEnforcement = flag(scenario, "productionEnforcementUnsupported") && productionMechanismClaims.some((text) => PRODUCTION_ENFORCEMENT.test(text.toLowerCase()) && !isQuestionLike(text) && !isSafetyConstraint(text));

	const hardAssertions = [
		assertion("schema.valid", "schema", true, "Response is exactly one syntactically valid top-level JSON object and satisfies the suite schema.", ["raw-response.txt"]),
		assertion("hard.outside-journey", "hard-failure", !allImplementationProbes, allImplementationProbes ? "Every proposed case is an implementation probe without an external journey." : "At least one external journey exists or no cases were proposed.", ["cases[*].actor", "cases[*].entrySurface", "cases[*].visibleOutcomes"]),
		assertion("hard.contradiction", "hard-failure", contradictionHandled, contradictionHandled ? "Seeded contradiction and its governing evidence were handled when applicable." : "The seeded product contradiction or its governing evidence was missed.", ["instructionArtifacts", "questions", "AC-005", "REPO-1"]),
		assertion("hard.amendment-gate", "hard-failure", amendmentGate, amendmentGate ? "A product/matrix amendment is gated only where the fixture requires one." : "Required contradiction amendment and user review were omitted.", ["instructionArtifacts", "questions"]),
		assertion("hard.no-unnecessary-amendment", "hard-failure", !unsupportedInfrastructureAmendment, unsupportedInfrastructureAmendment ? "An execution-infrastructure block was incorrectly turned into a product/matrix amendment." : "No unsupported product/matrix amendment was inferred from execution-infrastructure availability.", ["instructionArtifacts", "questions", "REPO-MOB-2"]),
		assertion("hard.authorization-privacy", "hard-failure", privacyCovered, privacyCovered ? "Critical authorization/privacy actors and denial semantics are represented." : "Critical authorization/privacy boundary is omitted.", ["PERM-2", "PRIV-1"]),
		assertion("hard.destructive-safety", "hard-failure", destructiveCovered, destructiveCovered ? "Destructive migration/recovery boundary is represented when applicable." : "Critical destructive or recovery boundary is omitted.", ["MIG-2", "MIG-3", "OPS-1"]),
		assertion("hard.required-platform", "hard-failure", unavailableReportedSafely && environmentRequested, unavailableReportedSafely && environmentRequested ? "The unavailable required platform remains explicit and blocked pending executable infrastructure." : "The required platform is missing, unblocked, passed, or does not request an executable environment.", [unavailablePlatform ?? "not applicable", "cases[*].platforms", "cases[*].status", "questions"]),
		assertion("hard.no-false-pass", "hard-failure", !unsupportedPass, unsupportedPass ? "Matrix authoring claimed an unexecuted case passed." : "No unexecuted case is reported as passed.", ["cases[*].status"]),
		assertion("hard.no-unsupported-facts", "hard-failure", unsupportedSourceRefs.length === 0, unsupportedSourceRefs.length ? `Unsupported source references were presented as grounding: ${unsupportedSourceRefs.join(", ")}.` : "No invented source identity was used in stable source-reference fields.", unsupportedSourceRefs),
		assertion("hard.binding-qualifiers", "hard-failure", compatibilityDurationPresent, compatibilityDurationPresent ? "Binding compatibility duration is preserved or not applicable." : "Generic compatibility was named without the binding two-release duration in a case or explicit question/gap.", [compatibilityWindow ?? "not applicable", "MIG-1"]),
		assertion("hard.no-invented-enforcement", "hard-failure", !inventedProductionEnforcement, inventedProductionEnforcement ? "An unstated production-target refusal/enforcement mechanism was invented as expected behavior." : "No unstated production-target enforcement mechanism was asserted outside a question or safety constraint.", ["OPS-1", "cases[*].actions", "cases[*].visibleOutcomes", "cases[*].technicalEvidence"]),
	];

	const outsideRatio = ratio(journeyCases.length, cases.length || 1);
	const conceptHits = requiredConcepts.filter((concept) => behaviorText.includes(concept.toLowerCase()) || (concept === "amendment" && amendmentSemantics));
	const riskHits = requiredRisks.filter((risk) => behaviorText.includes(risk.toLowerCase()) || reconciliationText.includes(risk.toLowerCase()) || (risk === "destructive" && /rollback|data loss|production/.test(lowerJson(cases))));
	const casesWithFinalState = cases.filter((entry) => nonEmpty(entry.startingState) && nonEmpty(entry.finalInvariant)).length;
	const platformHits = expectedPlatforms.filter((platform) => behaviorText.includes(platform.toLowerCase()));
	const caseText = lowerJson(cases);
	const forbiddenHits = forbiddenConcepts.filter((concept) => caseText.includes(concept.toLowerCase()));
	const visibleCases = cases.filter((entry) => nonEmpty(entry.visibleOutcomes)).length;
	const evidenceCases = cases.filter((entry) => nonEmpty(entry.technicalEvidence)).length;
	const evidenceTarget = Math.max(1, Math.min(cases.length, Math.max(1, Math.min(2, requiredRisks.length))));
	const safeCases = cases.filter((entry) => nonEmpty(entry.setupCleanup) && nonEmpty(entry.safety)).length;
	const signatures = cases.map((entry) => `${entry.actor ?? ""}|${entry.entrySurface ?? ""}|${(entry.actions ?? []).join(" ")}`.toLowerCase().replace(/\W+/g, " ").trim());
	const uniqueRatio = ratio(new Set(signatures).size, signatures.length || 1);
	const bounded = cases.length <= count(scenario, "maxCases", 12);
	const sourceRefsConsistent = unsupportedSourceRefs.length === 0 && cases.every((entry) => nonEmpty(entry.requirementRefs));
	const stableGroundingItems = [...cases.map((entry) => entry.requirementRefs), ...exclusions.map((entry) => entry.sourceRefs)];
	const groundingRatio = ratio(stableGroundingItems.filter((refs) => Array.isArray(refs) && refs.length > 0 && refs.every((ref) => knownSourceRefs.has(ref))).length, stableGroundingItems.length || 1);
	const optionalCrosswalkPresent = /\b(?:obligation|traceability|crosswalk|coverage map)\b/.test(artifactText);
	const consistencyScore: 0 | 1 | 2 = contradictionRequired ? (contradictionHandled && amendmentGate ? 2 : contradictionHandled ? 1 : 0) : (sourceRefsConsistent ? 2 : 0);
	const phaseSafe = planning
		? ((!contradictionRequired || amendmentGate) && (!infrastructureBlockOnly || (unavailableReportedSafely && environmentRequested && !unsupportedInfrastructureAmendment)))
		: (!/create (?:an )?evaluation resource|implementation task|task graph/.test(behaviorText) && (questions.length > 0 || artifactStrings.some(isQuestionLike) || !/question|unresolved|ambiguous/.test(scenario.fixture.toLowerCase())));

	const dimensions: RubricDimension[] = [
		dimension("outside-in", "Outside-in actor/surface/journey quality", scoreRatio(outsideRatio), `${journeyCases.length}/${cases.length} cases contain actor, outward surface, actions, and visible outcomes.`, ["cases[*].actor", "cases[*].entrySurface", "cases[*].visibleOutcomes"]),
		dimension("affected-area", "Affected-area coverage and exclusions", scoreRatio((ratio(conceptHits.length, requiredConcepts.length) + (exclusions.length > 0 ? 1 : 0)) / 2), `${conceptHits.length}/${requiredConcepts.length} required behavior concepts are represented; ${exclusions.length} exclusion(s) recorded.`, conceptHits),
		dimension("risk-state", "Risk and state transitions", scoreRatio((ratio(riskHits.length, requiredRisks.length) + ratio(casesWithFinalState, cases.length || 1)) / 2), `${riskHits.length}/${requiredRisks.length} risk triggers and ${casesWithFinalState}/${cases.length} declared start/final states.`, riskHits),
		dimension("platform", "Platform and viewport precision", expectedPlatforms.length === 0 ? (forbiddenHits.length === 0 && exclusions.length > 0 ? 2 : forbiddenHits.length < forbiddenConcepts.length ? 1 : 0) : scoreRatio(ratio(platformHits.length, expectedPlatforms.length)), expectedPlatforms.length === 0 ? `${forbiddenHits.length} irrelevant UI/platform concepts included.` : `${platformHits.length}/${expectedPlatforms.length} required surfaces named.`, expectedPlatforms.length ? platformHits : forbiddenHits),
		dimension("oracle-evidence", "Visible oracle plus technical corroboration", scoreRatio((ratio(visibleCases, cases.length || 1) + ratio(Math.min(evidenceCases, evidenceTarget), evidenceTarget)) / 2), `${visibleCases}/${cases.length} cases have visible outcomes; ${evidenceCases} case(s) name technical corroboration against a risk-based target of ${evidenceTarget}.`, ["cases[*].visibleOutcomes", "cases[*].technicalEvidence"]),
		dimension("feasibility-safety", "Feasibility and safety", scoreRatio(ratio(safeCases, cases.length || 1) * (unavailableReportedSafely && environmentRequested ? 1 : 0)), `${safeCases}/${cases.length} cases define setup/cleanup and safety; unavailable-platform handling=${unavailableReportedSafely && environmentRequested}.`, ["cases[*].setupCleanup", "cases[*].safety", "cases[*].blockedReason", "questions"]),
		dimension("non-redundancy", "Non-redundancy and minimality", scoreRatio((uniqueRatio + (bounded ? 1 : 0)) / 2), `Unique journey signatures=${uniqueRatio.toFixed(2)}; case count ${cases.length}/${count(scenario, "maxCases", 12)} maximum.`, signatures),
		dimension("consistency", "Consistency and contradiction detection", consistencyScore, contradictionRequired ? `Contradiction handled=${contradictionHandled}; amendment gate=${amendmentGate}.` : `Stable case/source references are ${sourceRefsConsistent ? "consistent" : "incomplete"}; optional instruction-specific crosswalk=${optionalCrosswalkPresent ? "semantically present" : "not applicable"}.`, ["cases[*].requirementRefs", "instructionArtifacts"]),
		dimension("grounding", "Grounding and traceability", scoreRatio(groundingRatio), `Stable case/exclusion source-reference coverage=${groundingRatio.toFixed(2)}; optional private crosswalk keys are not required.`, ["cases[*].requirementRefs", "exclusions[*].sourceRefs"]),
		dimension("phase-discipline", "Phase discipline", phaseSafe ? 2 : 0, phaseSafe ? `Output stays within ${planning ? "planning reconciliation" : "story shaping"} authority.` : `Output crosses or bypasses the ${planning ? "planning" : "shaping"} boundary.`, ["cases", "questions", "instructionArtifacts"]),
	];
	const behaviorAssertions = dimensions.map((entry) => assertion(`rubric.${entry.id}`, "behavior", entry.score === 2, `${entry.label}: ${entry.score}/2. ${entry.rationale}`, entry.evidence));
	const total = dimensions.reduce((sum, entry) => sum + entry.score, 0);
	const maxTotal = dimensions.reduce((sum, entry) => sum + entry.maxScore, 0);
	const normalized = Math.round(total / maxTotal * 100);
	const hardFailures = hardAssertions.filter((entry) => !entry.passed).map((entry) => entry.message);
	const threshold = 70;
	return {
		passed: hardFailures.length === 0 && normalized >= threshold,
		threshold,
		total,
		maxTotal,
		normalized,
		hardFailures,
		assertions: [...hardAssertions, ...behaviorAssertions],
		dimensions,
	};
}
