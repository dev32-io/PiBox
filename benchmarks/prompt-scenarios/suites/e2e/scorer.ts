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
	/** Legacy/top-level forms remain parseable so old evidence can be re-scored. */
	obligations?: Array<{ id?: string; text?: string; sourceRefs?: string[] }>;
	obligationCoverage?: Array<{ obligationId?: string; caseIds?: string[]; gapId?: string }>;
	gaps?: Array<{ id?: string; question?: string; sourceRefs?: string[] }>;
	amendments?: Array<{ classification?: string; evidenceRefs?: string[]; impactedRequirementRefs?: string[]; preservesIds?: boolean; proposedDelta?: string; userReviewRequired?: boolean }>;
}

const list = (scenario: PromptScenario, key: string): string[] => Array.isArray(scenario.metadata?.[key]) ? scenario.metadata![key] as string[] : [];
const flag = (scenario: PromptScenario, key: string): boolean => scenario.metadata?.[key] === true;
const scalar = (scenario: PromptScenario, key: string): string | undefined => typeof scenario.metadata?.[key] === "string" ? scenario.metadata[key] as string : undefined;
const count = (scenario: PromptScenario, key: string, fallback: number): number => typeof scenario.metadata?.[key] === "number" ? scenario.metadata[key] as number : fallback;
const lowerJson = (value: unknown) => { try { return JSON.stringify(value).toLowerCase(); } catch { return ""; } };
const section = <T>(output: E2EBenchmarkOutput, key: string): T[] => {
	const artifacts = output.instructionArtifacts;
	const value = artifacts && typeof artifacts === "object" ? artifacts[key] : undefined;
	const fallback = (output as Record<string, unknown>)[key];
	return Array.isArray(value) ? value as T[] : Array.isArray(fallback) ? fallback as T[] : [];
};
const nonEmpty = (value: unknown): boolean => typeof value === "string" ? value.trim().length > 0 : Array.isArray(value) ? value.some(nonEmpty) : false;
const ratio = (hits: number, total: number) => total === 0 ? 1 : hits / total;
const scoreRatio = (value: number): 0 | 1 | 2 => value >= 0.8 ? 2 : value >= 0.45 ? 1 : 0;

function dimension(id: string, label: string, score: 0 | 1 | 2, rationale: string, evidence: string[]): RubricDimension {
	return { id, label, score, maxScore: 2, rationale, evidence };
}

function assertion(id: string, kind: BenchmarkAssertion["kind"], passed: boolean, message: string, evidence: string[]): BenchmarkAssertion {
	return { id, kind, passed, message, evidence };
}

export function scoreE2EScenario(scenario: PromptScenario, parsed: ParseOutcome<E2EBenchmarkOutput>): AutomaticScore {
	const output = parsed.value ?? {};
	const cases = Array.isArray(output.cases) ? output.cases : [];
	const obligations = section<NonNullable<E2EBenchmarkOutput["obligations"]>[number]>(output, "obligations");
	const coverage = section<NonNullable<E2EBenchmarkOutput["obligationCoverage"]>[number]>(output, "obligationCoverage");
	const gaps = section<NonNullable<E2EBenchmarkOutput["gaps"]>[number]>(output, "gaps");
	const exclusions = Array.isArray(output.exclusions) ? output.exclusions : [];
	const amendments = section<NonNullable<E2EBenchmarkOutput["amendments"]>[number]>(output, "amendments");
	const behaviorText = lowerJson({ obligations: obligations.map((entry) => entry.text), cases: cases.map((entry) => ({ actor: entry.actor, entrySurface: entry.entrySurface, startingState: entry.startingState, actions: entry.actions, visibleOutcomes: entry.visibleOutcomes, finalInvariant: entry.finalInvariant, technicalEvidence: entry.technicalEvidence, platforms: entry.platforms })) });
	const amendmentText = lowerJson(amendments);
	const requiredConcepts = list(scenario, "requiredConcepts");
	const requiredRisks = list(scenario, "requiredRisks");
	const expectedPlatforms = list(scenario, "expectedPlatforms");
	const forbiddenConcepts = list(scenario, "forbiddenConcepts");
	const unavailablePlatform = scalar(scenario, "unavailablePlatform");
	const contradictionRequired = flag(scenario, "contradictionRequired");
	const planning = scenario.metadata?.phase === "planning";

	const schemaPassed = parsed.syntaxValid && parsed.schemaValid;
	const journeyCases = cases.filter((entry) => nonEmpty(entry.actor) && nonEmpty(entry.entrySurface) && nonEmpty(entry.actions) && nonEmpty(entry.visibleOutcomes));
	const allImplementationProbes = cases.length > 0 && journeyCases.length === 0;
	const contradictionHandled = !contradictionRequired || (/contradic|conflict|infeasib|stale/.test(amendmentText) && amendments.some((entry) => /contradiction|infeasible/.test(String(entry.classification).toLowerCase())));
	const amendmentRequired = contradictionRequired || Boolean(unavailablePlatform);
	const amendmentGate = !amendmentRequired || amendments.some((entry) => entry.userReviewRequired === true && nonEmpty(entry.evidenceRefs) && nonEmpty(entry.impactedRequirementRefs));
	const privacyRequired = flag(scenario, "authorizationCritical");
	const privacyCovered = !privacyRequired || (/child/.test(behaviorText) && /guest/.test(behaviorText) && /deny|prohibit/.test(behaviorText) && /privacy|leak|mask|secret|token/.test(behaviorText));
	const destructiveRequired = requiredRisks.includes("destructive");
	const destructiveCovered = !destructiveRequired || (/rollback|recover|restore|idempotent|safe(?:ly)? stop/.test(behaviorText) && /production|disposable|data/.test(behaviorText));
	const unavailableCases = unavailablePlatform ? cases.filter((entry) => (entry.platforms ?? []).some((platform) => platform.toLowerCase().includes(unavailablePlatform))) : [];
	const unavailableReportedSafely = !unavailablePlatform || (unavailableCases.length > 0 && unavailableCases.every((entry) => entry.status === "blocked" && nonEmpty(entry.blockedReason)) && !unavailableCases.some((entry) => entry.status === "passed"));
	const unsupportedPass = cases.some((entry) => entry.status === "passed");
	const knownSourceRefs = new Set(list(scenario, "sourceIds"));
	const citedSourceRefs = [
		...obligations.flatMap((entry) => entry.sourceRefs ?? []),
		...cases.flatMap((entry) => entry.requirementRefs ?? []),
		...gaps.flatMap((entry) => entry.sourceRefs ?? []),
		...exclusions.flatMap((entry) => entry.sourceRefs ?? []),
		...amendments.flatMap((entry) => [...(entry.evidenceRefs ?? []), ...(entry.impactedRequirementRefs ?? [])]),
	];
	const unsupportedSourceRefs = [...new Set(citedSourceRefs.filter((ref) => typeof ref !== "string" || !knownSourceRefs.has(ref)))].map(String);
	const structuralCaseIds = new Set(cases.map((entry) => entry.id).filter((id): id is string => typeof id === "string" && id.length > 0));
	const approvedCaseIds = list(scenario, "approvedCaseIds");
	const approvedSourceIds = list(scenario, "approvedSourceIds");
	const preservedApprovedIds = !planning || approvedCaseIds.every((id) => structuralCaseIds.has(id));
	const preservedApprovedSources = !planning || approvedSourceIds.every((id) => cases.some((entry) => (entry.requirementRefs ?? []).includes(id)) || amendments.some((entry) => (entry.impactedRequirementRefs ?? []).includes(id)));

	const hardAssertions = [
		assertion("schema.valid", "schema", schemaPassed, schemaPassed ? "Response is syntactically valid and satisfies the suite schema." : `Structured output failure: ${parsed.errors.join("; ")}`, ["raw-response.txt", ...parsed.errors]),
		assertion("hard.outside-journey", "hard-failure", !allImplementationProbes, allImplementationProbes ? "Every proposed case is an implementation probe without an external journey." : "At least one external journey exists or no cases were parseable.", ["cases[*].actor", "cases[*].entrySurface", "cases[*].visibleOutcomes"]),
		assertion("hard.contradiction", "hard-failure", contradictionHandled, contradictionHandled ? "Seeded contradiction was handled when applicable." : "The seeded contract contradiction was missed.", ["amendments", "AC-005", "E2E-002"]),
		assertion("hard.amendment-gate", "hard-failure", amendmentGate, amendmentGate ? "Required amendment identifies impacted IDs and requests review." : "Required reconciliation was omitted or silently bypassed the amendment gate.", ["amendments[*].impactedRequirementRefs", "amendments[*].userReviewRequired"]),
		assertion("hard.approved-id-preservation", "hard-failure", preservedApprovedIds && preservedApprovedSources, preservedApprovedIds && preservedApprovedSources ? "Approved planning case and requirement IDs remain structurally referenced." : "One or more approved planning case or requirement IDs disappeared from structural fields.", [...approvedCaseIds, ...approvedSourceIds]),
		assertion("hard.authorization-privacy", "hard-failure", privacyCovered, privacyCovered ? "Critical authorization/privacy actors and absence claims are represented." : "Critical authorization/privacy boundary is omitted.", ["PERM-2", "PRIV-1"]),
		assertion("hard.destructive-safety", "hard-failure", destructiveCovered, destructiveCovered ? "Destructive migration/recovery boundary is represented when applicable." : "Critical destructive or recovery boundary is omitted.", ["MIG-2", "MIG-3", "OPS-1"]),
		assertion("hard.required-platform", "hard-failure", unavailableReportedSafely, unavailableReportedSafely ? "Unavailable required platform remains explicit and blocked." : "Unavailable required platform is omitted, unblocked, or reported as passed.", [unavailablePlatform ?? "not applicable", "cases[*].status"]),
		assertion("hard.no-false-pass", "hard-failure", !unsupportedPass, unsupportedPass ? "Matrix authoring claimed an unexecuted case passed." : "No unexecuted case is reported as passed.", ["cases[*].status"]),
		assertion("hard.no-unsupported-facts", "hard-failure", unsupportedSourceRefs.length === 0, unsupportedSourceRefs.length ? `Unsupported source references were presented as grounding: ${unsupportedSourceRefs.join(", ")}.` : "No invented source identity was used to present behavior as grounded fact.", unsupportedSourceRefs),
	];

	const outsideRatio = ratio(journeyCases.length, cases.length || 1);
	const conceptHits = requiredConcepts.filter((concept) => behaviorText.includes(concept.toLowerCase()) || (concept === "amendment" && amendments.length > 0));
	const riskHits = requiredRisks.filter((risk) => behaviorText.includes(risk.toLowerCase()) || amendmentText.includes(risk.toLowerCase()) || (risk === "destructive" && /rollback|data loss|production/.test(behaviorText)));
	const casesWithFinalState = cases.filter((entry) => nonEmpty(entry.startingState) && nonEmpty(entry.finalInvariant)).length;
	const platformHits = expectedPlatforms.filter((platform) => behaviorText.includes(platform.toLowerCase()));
	const caseText = lowerJson(cases);
	// Naming an irrelevant dimension in `exclusions` is desirable; only proposing it as a case is penalized.
	const forbiddenHits = forbiddenConcepts.filter((concept) => caseText.includes(concept.toLowerCase()));
	const visibleCases = cases.filter((entry) => nonEmpty(entry.visibleOutcomes)).length;
	const evidenceCases = cases.filter((entry) => nonEmpty(entry.technicalEvidence)).length;
	const evidenceTarget = Math.max(1, Math.min(cases.length, Math.max(1, Math.min(2, requiredRisks.length))));
	const safeCases = cases.filter((entry) => nonEmpty(entry.setupCleanup) && nonEmpty(entry.safety)).length;
	const signatures = cases.map((entry) => `${entry.actor ?? ""}|${entry.entrySurface ?? ""}|${(entry.actions ?? []).join(" ")}`.toLowerCase().replace(/\W+/g, " ").trim());
	const uniqueRatio = ratio(new Set(signatures).size, signatures.length || 1);
	const bounded = cases.length <= count(scenario, "maxCases", 12);
	const caseIds = cases.map((entry) => entry.id).filter((id): id is string => typeof id === "string" && id.length > 0);
	const obligationIds = obligations.map((entry) => entry.id).filter((id): id is string => typeof id === "string" && id.length > 0);
	const gapIds = gaps.map((entry) => entry.id).filter((id): id is string => typeof id === "string" && id.length > 0);
	const knownCaseIds = new Set(caseIds); const knownObligationIds = new Set(obligationIds); const knownGapIds = new Set(gapIds);
	const counts = new Map<string, number>(); coverage.forEach((entry) => { if (entry.obligationId) counts.set(entry.obligationId, (counts.get(entry.obligationId) ?? 0) + 1); });
	const coverageValid = obligations.length > 0 && knownObligationIds.size === obligations.length && knownCaseIds.size === caseIds.length && knownGapIds.size === gapIds.length && coverage.length === obligations.length && coverage.every((entry) => Boolean(entry.obligationId && knownObligationIds.has(entry.obligationId) && counts.get(entry.obligationId) === 1) && ((Array.isArray(entry.caseIds) && entry.caseIds.length > 0 && !entry.gapId && entry.caseIds.every((id) => knownCaseIds.has(id))) || (!entry.caseIds && Boolean(entry.gapId && knownGapIds.has(entry.gapId)))));
	const groundedItems = [...obligations.map((entry) => entry.sourceRefs), ...cases.map((entry) => entry.requirementRefs), ...gaps.map((entry) => entry.sourceRefs)].filter(Array.isArray);
	const groundingRatio = ratio(groundedItems.filter(nonEmpty).length, groundedItems.length || 1);
	const phaseSafe = planning
		? (!/create (?:an )?evaluation resource|rewrite the approved/.test(behaviorText) && (!amendmentRequired || amendmentGate) && preservedApprovedIds && preservedApprovedSources)
		: (!/implementation task|task graph|create (?:an )?evaluation/.test(behaviorText) && (gaps.length > 0 || (output.questions?.length ?? 0) > 0 || !/question|unresolved|ambiguous/.test(scenario.fixture.toLowerCase())));

	const dimensions: RubricDimension[] = [
		dimension("outside-in", "Outside-in actor/surface/journey quality", scoreRatio(outsideRatio), `${journeyCases.length}/${cases.length} cases contain actor, outward surface, actions, and visible outcomes.`, ["cases[*].actor", "cases[*].entrySurface", "cases[*].visibleOutcomes"]),
		dimension("affected-area", "Affected-area coverage and exclusions", scoreRatio((ratio(conceptHits.length, requiredConcepts.length) + (exclusions.length > 0 ? 1 : 0)) / 2), `${conceptHits.length}/${requiredConcepts.length} required behavior concepts are represented; ${exclusions.length} exclusion(s) recorded.`, conceptHits),
		dimension("risk-state", "Risk and state transitions", scoreRatio((ratio(riskHits.length, requiredRisks.length) + ratio(casesWithFinalState, cases.length || 1)) / 2), `${riskHits.length}/${requiredRisks.length} risk triggers and ${casesWithFinalState}/${cases.length} declared start/final states.`, riskHits),
		dimension("platform", "Platform and viewport precision", expectedPlatforms.length === 0 ? (forbiddenHits.length === 0 && exclusions.length > 0 ? 2 : forbiddenHits.length < forbiddenConcepts.length ? 1 : 0) : scoreRatio(ratio(platformHits.length, expectedPlatforms.length)), expectedPlatforms.length === 0 ? `${forbiddenHits.length} irrelevant UI/platform concepts included.` : `${platformHits.length}/${expectedPlatforms.length} required surfaces named.`, expectedPlatforms.length ? platformHits : forbiddenHits),
		dimension("oracle-evidence", "Visible oracle plus technical corroboration", scoreRatio((ratio(visibleCases, cases.length || 1) + ratio(Math.min(evidenceCases, evidenceTarget), evidenceTarget)) / 2), `${visibleCases}/${cases.length} cases have visible outcomes; ${evidenceCases} case(s) name technical corroboration against a risk-based target of ${evidenceTarget}.`, ["cases[*].visibleOutcomes", "cases[*].technicalEvidence"]),
		dimension("feasibility-safety", "Feasibility and safety", scoreRatio(ratio(safeCases, cases.length || 1) * (unavailableReportedSafely ? 1 : 0)), `${safeCases}/${cases.length} cases define setup/cleanup and safety; unavailable-platform handling=${unavailableReportedSafely}.`, ["cases[*].setupCleanup", "cases[*].safety", "cases[*].blockedReason"]),
		dimension("non-redundancy", "Non-redundancy and minimality", scoreRatio((uniqueRatio + (bounded ? 1 : 0)) / 2), `Unique journey signatures=${uniqueRatio.toFixed(2)}; case count ${cases.length}/${count(scenario, "maxCases", 12)} maximum.`, signatures),
		dimension("consistency", "Consistency and contradiction detection", contradictionRequired ? (contradictionHandled && amendmentGate ? 2 : contradictionHandled ? 1 : 0) : (coverageValid ? 2 : coverage.length > 0 ? 1 : 0), contradictionRequired ? `Contradiction handled=${contradictionHandled}; amendment gate=${amendmentGate}.` : `Obligation coverage references are ${coverageValid ? "consistent" : "incomplete or inconsistent"}.`, ["obligationCoverage", "amendments"]),
		dimension("grounding", "Grounding and traceability", scoreRatio((groundingRatio + (coverageValid ? 1 : 0)) / 2), `Source-reference coverage=${groundingRatio.toFixed(2)}; obligation crosswalk valid=${coverageValid}.`, ["obligations[*].sourceRefs", "cases[*].requirementRefs", "obligationCoverage"]),
		dimension("phase-discipline", "Phase discipline", phaseSafe ? 2 : 0, phaseSafe ? `Output stays within ${planning ? "planning reconciliation" : "story shaping"} authority.` : `Output crosses or bypasses the ${planning ? "planning" : "shaping"} boundary.`, ["amendments", "gaps", "exclusions"]),
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
