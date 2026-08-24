import { extractStructuredJson } from "../../json.js";
import type { AutomaticScore, ParseOutcome, PromptScenario, RubricDimension } from "../../types.js";

export interface PlannerTaskOutput {
	id: string;
	goal: string;
	covers: string[];
	dependsOn: string[];
	stageId: string;
}

export interface PlannerStageOutput {
	id: string;
	mode: "sequential" | "concurrent";
	tasks: string[];
	review: "required" | "skip";
}

export interface PlannerBenchmarkOutput {
	tasks: PlannerTaskOutput[];
	stages: PlannerStageOutput[];
	rationale: string;
}

interface PlannerExpectations {
	requiredSteps: string[];
	together?: string[][];
	separate?: string[][];
	concurrent?: string[][];
	ordered?: string[][];
	notConcurrent?: string[][];
	minTasks?: number;
	maxTasks?: number;
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);

export function parsePlannerOutput(raw: string): ParseOutcome<PlannerBenchmarkOutput> {
	const extracted = extractStructuredJson(raw);
	if (!extracted.syntaxValid) return extracted as ParseOutcome<PlannerBenchmarkOutput>;
	const value = extracted.value as Partial<PlannerBenchmarkOutput> | undefined;
	const errors: string[] = [];
	if (!value || typeof value !== "object") errors.push("Output must be one JSON object.");
	const tasks = Array.isArray(value?.tasks) ? value.tasks : [];
	const stages = Array.isArray(value?.stages) ? value.stages : [];
	if (!tasks.length) errors.push("tasks must be a non-empty array.");
	if (!stages.length) errors.push("stages must be a non-empty array.");
	for (const [index, task] of tasks.entries()) {
		if (!task || typeof task !== "object") { errors.push(`tasks[${index}] must be an object.`); continue; }
		if (typeof task.id !== "string" || !task.id) errors.push(`tasks[${index}].id is required.`);
		if (typeof task.goal !== "string" || !task.goal) errors.push(`tasks[${index}].goal is required.`);
		if (!strings(task.covers)) errors.push(`tasks[${index}].covers must be a non-empty string array.`);
		if (!Array.isArray(task.dependsOn) || !task.dependsOn.every((entry) => typeof entry === "string" && entry.length > 0)) errors.push(`tasks[${index}].dependsOn must be a string array.`);
		if (typeof task.stageId !== "string" || !task.stageId) errors.push(`tasks[${index}].stageId is required.`);
	}
	for (const [index, stage] of stages.entries()) {
		if (!stage || typeof stage !== "object") { errors.push(`stages[${index}] must be an object.`); continue; }
		if (typeof stage.id !== "string" || !stage.id) errors.push(`stages[${index}].id is required.`);
		if (stage.mode !== "sequential" && stage.mode !== "concurrent") errors.push(`stages[${index}].mode must be sequential or concurrent.`);
		if (!strings(stage.tasks)) errors.push(`stages[${index}].tasks must be a non-empty string array.`);
		if (stage.review !== "required" && stage.review !== "skip") errors.push(`stages[${index}].review must be required or skip.`);
	}
	if (typeof value?.rationale !== "string" || !value.rationale.trim()) errors.push("rationale is required.");
	return {
		syntaxValid: true,
		schemaValid: errors.length === 0,
		strategy: extracted.strategy,
		...(extracted.extracted !== undefined ? { extracted: extracted.extracted } : {}),
		...(errors.length ? {} : { value: value as PlannerBenchmarkOutput }),
		errors,
	};
}

const ratioScore = (passed: number, total: number): 0 | 1 | 2 => total === 0 || passed === total ? 2 : passed * 2 >= total ? 1 : 0;
const dimension = (id: string, label: string, passed: number, total: number, evidence: string[]): RubricDimension => ({ id, label, score: ratioScore(passed, total), maxScore: 2, rationale: `${passed}/${total} checks satisfied.`, evidence });

export function scorePlannerScenario(scenario: PromptScenario, parsed: ParseOutcome<PlannerBenchmarkOutput>): AutomaticScore {
	if (!parsed.syntaxValid || !parsed.schemaValid || !parsed.value) {
		const message = `Planner output schema failure: ${parsed.errors.join("; ")}`;
		return { passed: false, threshold: 80, total: 0, maxTotal: 10, normalized: 0, hardFailures: [message], assertions: [{ id: "output.schema", kind: "hard-failure", passed: false, message, evidence: ["raw-response.txt"] }], dimensions: [] };
	}
	const output = parsed.value;
	const expectations = scenario.metadata?.expectations as unknown as PlannerExpectations;
	const taskById = new Map(output.tasks.map((task) => [task.id, task]));
	const stageById = new Map(output.stages.map((stage) => [stage.id, stage]));
	const taskForStep = new Map<string, PlannerTaskOutput[]>();
	for (const task of output.tasks) for (const step of task.covers) taskForStep.set(step, [...(taskForStep.get(step) ?? []), task]);
	const stageIndex = new Map(output.stages.map((stage, index) => [stage.id, index]));
	const stageForStep = (step: string) => { const task = taskForStep.get(step)?.[0]; return task ? stageById.get(task.stageId) : undefined; };
	const sameTask = (steps: string[]) => { const ids = steps.map((step) => taskForStep.get(step)?.[0]?.id); return ids.every(Boolean) && new Set(ids).size === 1; };
	const differentTasks = (steps: string[]) => { const ids = steps.map((step) => taskForStep.get(step)?.[0]?.id); return ids.every(Boolean) && new Set(ids).size === ids.length; };
	const sameConcurrentStage = (steps: string[]) => { const tasks = steps.map((step) => taskForStep.get(step)?.[0]); if (tasks.some((task) => !task) || new Set(tasks.map((task) => task!.id)).size !== tasks.length) return false; const stages = tasks.map((task) => stageById.get(task!.stageId)); return stages.every(Boolean) && new Set(stages.map((stage) => stage!.id)).size === 1 && stages[0]!.mode === "concurrent"; };
	const ordered = ([before, after]: string[]) => { const first = taskForStep.get(before!)?.[0]; const second = taskForStep.get(after!)?.[0]; if (!first || !second || first.id === second.id) return false; const firstStage = stageById.get(first.stageId); const secondStage = stageById.get(second.stageId); if (!firstStage || !secondStage) return false; const left = stageIndex.get(firstStage.id)!; const right = stageIndex.get(secondStage.id)!; if (left < right) return true; return left === right && firstStage.mode === "sequential" && firstStage.tasks.indexOf(first.id) < firstStage.tasks.indexOf(second.id); };
	const notConcurrent = (steps: string[]) => !sameConcurrentStage(steps);

	const coverageChecks = expectations.requiredSteps.map((step) => (taskForStep.get(step)?.length ?? 0) === 1);
	const boundaryChecks = [...(expectations.together ?? []).map(sameTask), ...(expectations.separate ?? []).map(differentTasks)];
	const concurrencyChecks = [...(expectations.concurrent ?? []).map(sameConcurrentStage), ...(expectations.notConcurrent ?? []).map(notConcurrent)];
	const orderingChecks = (expectations.ordered ?? []).map(ordered);
	const taskIds = new Set(output.tasks.map((task) => task.id));
	const stageMembership = output.tasks.every((task) => stageById.get(task.stageId)?.tasks.includes(task.id)) && output.stages.every((stage) => stage.tasks.every((id) => taskById.has(id))) && output.tasks.every((task) => task.dependsOn.every((id) => taskIds.has(id)));
	const countFits = output.tasks.length >= (expectations.minTasks ?? 1) && output.tasks.length <= (expectations.maxTasks ?? Number.MAX_SAFE_INTEGER);
	const structureChecks = [stageMembership, countFits];
	const dimensions = [
		dimension("coverage", "Exact ownership of required work", coverageChecks.filter(Boolean).length, coverageChecks.length, expectations.requiredSteps),
		dimension("boundaries", "Coherent fresh-agent boundaries", boundaryChecks.filter(Boolean).length, boundaryChecks.length, ["tasks[].covers"]),
		dimension("concurrency", "Safe concurrent task fan-out", concurrencyChecks.filter(Boolean).length, concurrencyChecks.length, ["stages[].mode", "stages[].tasks"]),
		dimension("ordering", "Durable-output stage ordering", orderingChecks.filter(Boolean).length, orderingChecks.length, ["tasks[].stageId", "tasks[].dependsOn"]),
		dimension("structure", "Task size and topology integrity", structureChecks.filter(Boolean).length, structureChecks.length, [`task count ${output.tasks.length}`]),
	];
	const total = dimensions.reduce((sum, entry) => sum + entry.score, 0);
	const maxTotal = dimensions.reduce((sum, entry) => sum + entry.maxScore, 0);
	const normalized = Math.round((total / maxTotal) * 100);
	const duplicateIds = taskById.size !== output.tasks.length || stageById.size !== output.stages.length;
	const hardFailures = duplicateIds ? ["Task and stage IDs must be unique."] : [];
	return {
		passed: !hardFailures.length && normalized >= 80,
		threshold: 80,
		total,
		maxTotal,
		normalized,
		hardFailures,
		assertions: [{ id: "output.schema", kind: "schema", passed: true, message: "Planner returned the required JSON plan sketch.", evidence: ["raw-response.txt"] }],
		dimensions,
	};
}
