import { HarnessError } from "./errors.js";

export interface StoryAuthoringSections {
	outcome: string;
	scope: string;
	behavior: string;
	acceptance: string;
	approach: string;
	boundariesAndFlow: string;
	failureAndVerification: string;
	e2eScope: string;
	e2eExclusions?: string;
}

export interface AuthoredE2eCase {
	id: string;
	title: string;
	exercise: string;
	oracle: string;
	proof: string;
}

export interface AuthoredE2eDocument {
	scope: string;
	cases: AuthoredE2eCase[];
	exclusions?: string;
}

const E2E_ID = /^E2E-(\d{3})$/;
const BARE_PLACEHOLDER = /^(?:TBD|N\/A|NONE)$/i;
const TODO_PLACEHOLDER = /^TODO$/;
const WRAPPED_PLACEHOLDER = /^(?:\[(?:TBD|TODO|placeholder)[^\]]*\]|<(?:TBD|TODO|placeholder)[^>]*>)$/i;

function clean(value: string): string { return value.trim(); }

function authoredBody(value: string, label: string, reservedLevels: number[]): string {
	const result = clean(value);
	for (const level of reservedLevels) {
		const match = result.match(new RegExp(`^${"#".repeat(level)}\\s+(.+?)\\s*$`, "m"));
		if (match) throw new HarnessError("INVALID_ARTIFACT", `${label} contains reserved level-${level} heading ${"#".repeat(level)} ${match[1]!.trim()}; use a deeper heading or bold text inside this field`);
	}
	return result;
}

function sections(markdown: string, level: 2 | 3): Array<{ heading: string; body: string }> {
	const prefix = "#".repeat(level);
	const heading = new RegExp(`^${prefix}\\s+(.+?)\\s*$`, "gm");
	const matches = [...markdown.matchAll(heading)];
	return matches.map((match, index) => ({
		heading: match[1]!.trim(),
		body: markdown.slice((match.index ?? 0) + match[0].length, matches[index + 1]?.index ?? markdown.length).trim(),
	}));
}

function exactSection(markdown: string, heading: string, source: string): string {
	const found = sections(markdown, 2).filter((entry) => entry.heading.toLowerCase() === heading.toLowerCase());
	if (found.length !== 1 || !found[0]!.body) throw new HarnessError("INVALID_ARTIFACT", `${source} must contain one non-empty ## ${heading} section`);
	return found[0]!.body;
}

function meaningful(value: string, label: string): string {
	const result = clean(value);
	if (!result) throw new HarnessError("INVALID_ARTIFACT", `${label} must be non-empty`);
	const placeholder = result.match(BARE_PLACEHOLDER) ?? result.match(TODO_PLACEHOLDER) ?? result.match(WRAPPED_PLACEHOLDER);
	if (placeholder) throw new HarnessError("INVALID_ARTIFACT", `${label} contains placeholder content: "${placeholder[0]}"`);
	return result;
}

export function renderSpec(input: Pick<StoryAuthoringSections, "outcome" | "scope" | "behavior" | "acceptance">): string {
	return `# Spec\n\n## Outcome\n\n${authoredBody(input.outcome, "Story outcome", [2])}\n\n## Scope\n\n${authoredBody(input.scope, "Story scope", [2])}\n\n## Behavior\n\n${authoredBody(input.behavior, "Story behavior", [2])}\n\n## Acceptance\n\n${authoredBody(input.acceptance, "Story acceptance", [2])}\n`;
}

export function parseSpec(markdown: string): Pick<StoryAuthoringSections, "outcome" | "scope" | "behavior" | "acceptance"> {
	const headings = sections(markdown, 2).map((entry) => entry.heading);
	if (headings.join("\n") !== ["Outcome", "Scope", "Behavior", "Acceptance"].join("\n")) throw new HarnessError("INVALID_ARTIFACT", "Story spec must contain exactly ## Outcome, ## Scope, ## Behavior, and ## Acceptance in that order");
	return {
		outcome: exactSection(markdown, "Outcome", "Story spec"),
		scope: exactSection(markdown, "Scope", "Story spec"),
		behavior: exactSection(markdown, "Behavior", "Story spec"),
		acceptance: exactSection(markdown, "Acceptance", "Story spec"),
	};
}

export function renderDesign(input: Pick<StoryAuthoringSections, "approach" | "boundariesAndFlow" | "failureAndVerification">): string {
	return `# Design\n\n## Approach\n\n${authoredBody(input.approach, "Story approach", [2])}\n\n## Boundaries and Flow\n\n${authoredBody(input.boundariesAndFlow, "Story boundariesAndFlow", [2])}\n\n## Failure and Verification\n\n${authoredBody(input.failureAndVerification, "Story failureAndVerification", [2])}\n`;
}

export function parseDesign(markdown: string): Pick<StoryAuthoringSections, "approach" | "boundariesAndFlow" | "failureAndVerification"> {
	const headings = sections(markdown, 2).map((entry) => entry.heading);
	if (headings.join("\n") !== ["Approach", "Boundaries and Flow", "Failure and Verification"].join("\n")) throw new HarnessError("INVALID_ARTIFACT", "Story design must contain exactly ## Approach, ## Boundaries and Flow, and ## Failure and Verification in that order");
	return {
		approach: exactSection(markdown, "Approach", "Story design"),
		boundariesAndFlow: exactSection(markdown, "Boundaries and Flow", "Story design"),
		failureAndVerification: exactSection(markdown, "Failure and Verification", "Story design"),
	};
}

export function validateE2eId(id: string): void {
	if (!E2E_ID.test(id)) throw new HarnessError("INVALID_ARTIFACT", "E2E case id must use E2E-NNN format");
}

export function renderE2e(input: AuthoredE2eDocument): string {
	const ordered = [...input.cases].sort((left, right) => Number(E2E_ID.exec(left.id)?.[1]) - Number(E2E_ID.exec(right.id)?.[1]));
	const cases = ordered.map((entry) => `## ${entry.id} — ${clean(entry.title)}\n\n### Exercise\n\n${authoredBody(entry.exercise, `${entry.id} exercise`, [2, 3])}\n\n### Oracle\n\n${authoredBody(entry.oracle, `${entry.id} oracle`, [2, 3])}\n\n### Proof\n\n${authoredBody(entry.proof, `${entry.id} proof`, [2, 3])}`).join("\n\n");
	return `# E2E\n\n## Scope\n\n${authoredBody(input.scope, "Story e2eScope", [2])}${cases ? `\n\n${cases}` : ""}${input.exclusions?.trim() ? `\n\n## Exclusions\n\n${authoredBody(input.exclusions, "Story e2eExclusions", [2])}` : ""}\n`;
}

export function parseE2e(markdown: string): AuthoredE2eDocument {
	const top = sections(markdown, 2);
	const scope = top.filter((entry) => entry.heading.toLowerCase() === "scope");
	if (scope.length !== 1 || !scope[0]!.body) throw new HarnessError("INVALID_ARTIFACT", "Story E2E must contain one non-empty ## Scope section");
	const exclusions = top.filter((entry) => entry.heading.toLowerCase() === "exclusions");
	if (exclusions.length > 1) throw new HarnessError("INVALID_ARTIFACT", "Story E2E may contain at most one ## Exclusions section");
	const cases: AuthoredE2eCase[] = [];
	const ids = new Set<string>();
	for (const [index, entry] of top.entries()) {
		if (entry.heading.toLowerCase() === "scope") {
			if (index !== 0) throw new HarnessError("INVALID_ARTIFACT", "Story E2E ## Scope must be the first section");
			continue;
		}
		if (entry.heading.toLowerCase() === "exclusions") {
			if (index !== top.length - 1) throw new HarnessError("INVALID_ARTIFACT", "Story E2E ## Exclusions must be the final section");
			continue;
		}
		const match = /^(E2E-\d{3})\s+[—-]\s+(.+)$/.exec(entry.heading);
		if (!match) throw new HarnessError("INVALID_ARTIFACT", `Story E2E has unsupported section ## ${entry.heading}; cases must use ## E2E-NNN — Title`);
		const id = match[1]!;
		validateE2eId(id);
		if (ids.has(id)) throw new HarnessError("INVALID_ARTIFACT", `Story E2E contains duplicate case ${id}`);
		ids.add(id);
		const nested = sections(entry.body, 3);
		if (nested.map((section) => section.heading).join("\n") !== ["Exercise", "Oracle", "Proof"].join("\n")) throw new HarnessError("INVALID_ARTIFACT", `${id} must contain exactly ### Exercise, ### Oracle, and ### Proof in that order`);
		const field = (name: string) => {
			const found = nested.filter((candidate) => candidate.heading.toLowerCase() === name.toLowerCase());
			if (found.length !== 1 || !found[0]!.body) throw new HarnessError("INVALID_ARTIFACT", `${id} must contain one non-empty ### ${name} section`);
			return found[0]!.body;
		};
		cases.push({ id, title: match[2]!.trim(), exercise: field("Exercise"), oracle: field("Oracle"), proof: field("Proof") });
	}
	return { scope: scope[0]!.body, cases, ...(exclusions[0]?.body ? { exclusions: exclusions[0].body } : {}) };
}

export function compiledStoryIssues(spec: string, design: string, e2e: string): string[] {
	const issues: string[] = [];
	let parsedSpec: ReturnType<typeof parseSpec> | undefined;
	let parsedDesign: ReturnType<typeof parseDesign> | undefined;
	let parsedE2e: ReturnType<typeof parseE2e> | undefined;
	for (const [parse, value, assign] of [
		[parseSpec, spec, (parsed: ReturnType<typeof parseSpec>) => { parsedSpec = parsed; }],
		[parseDesign, design, (parsed: ReturnType<typeof parseDesign>) => { parsedDesign = parsed; }],
		[parseE2e, e2e, (parsed: ReturnType<typeof parseE2e>) => { parsedE2e = parsed; }],
	] as const) {
		try { assign(parse(value) as never); } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
	}
	if (parsedE2e && parsedE2e.cases.length === 0) issues.push("Story E2E must contain at least one authored case");
	const fields = { ...(parsedSpec ?? {}), ...(parsedDesign ?? {}), ...(parsedE2e ? { e2eScope: parsedE2e.scope, ...(parsedE2e.exclusions ? { e2eExclusions: parsedE2e.exclusions } : {}) } : {}) };
	for (const [name, value] of Object.entries(fields)) {
		try { meaningful(value, `Story ${name}`); } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
	}
	for (const entry of parsedE2e?.cases ?? []) for (const [name, value] of Object.entries(entry)) {
		try { meaningful(value, `${entry.id} ${name}`); } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
	}
	return issues;
}

export function validateCompiledStory(spec: string, design: string, e2e: string): { sections: StoryAuthoringSections; cases: AuthoredE2eCase[] } {
	const issues = compiledStoryIssues(spec, design, e2e);
	if (issues.length) throw new HarnessError("INVALID_ARTIFACT", `Story validation failed with ${issues.length} issue${issues.length === 1 ? "" : "s"}:\n${issues.map((issue) => `- ${issue}`).join("\n")}`, { issues });
	const parsedSpec = parseSpec(spec);
	const parsedDesign = parseDesign(design);
	const parsedE2e = parseE2e(e2e);
	return { sections: { ...parsedSpec, ...parsedDesign, e2eScope: parsedE2e.scope, ...(parsedE2e.exclusions ? { e2eExclusions: parsedE2e.exclusions } : {}) }, cases: parsedE2e.cases };
}
