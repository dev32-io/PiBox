import { createWorkflowBenchHarness } from "./bench-harness.js";
import { ScriptedWorkflowAdapter } from "./scripted-adapter.js";
import type { ScenarioDimension, ScenarioTraceEvent, WorkflowScenarioDefinition, WorkflowScenarioResult } from "./types.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runWorkflowScenario(scenario: WorkflowScenarioDefinition): Promise<WorkflowScenarioResult> {
	const harness = createWorkflowBenchHarness();
	const adapter = new ScriptedWorkflowAdapter(scenario);
	harness.registerAdapter(adapter);
	await harness.startSession();
	let terminal: WorkflowScenarioResult["terminal"] = "timeout";
	try {
		await harness.tools.get("workflow_start").execute(`bench-${scenario.id}`, { ref: adapter.workflowRef }, undefined, undefined, harness.ctx);
		const deadline = Date.now() + (scenario.timeoutMs ?? 2_000);
		let steeringIndex = 0;
		while (Date.now() < deadline) {
			const state = [...harness.entries].reverse().find((entry) => entry.customType === "pibox-workflow" && entry.data.ref === adapter.workflowRef)?.data.state;
			const completed = harness.messages.some((entry) => entry.message?.customType === "pibox-workflow-complete");
			if (completed) { terminal = "complete"; break; }
			if (state === "paused") {
				const steering = scenario.steering?.[steeringIndex];
				if (steering?.when === "paused") {
					steeringIndex++;
					if (["request_changes", "retry", "accept_risk", "skip"].includes(steering.action)) {
						if (!steering.stepId) throw new Error(`Scenario ${scenario.id} checkpoint steering requires stepId`);
						await harness.tools.get("workflow_checkpoint").execute(`steer-${steeringIndex}`, { ref: `${adapter.workflowRef}/evaluation:${steering.stepId}`, action: steering.action, ...(steering.prompt ? { prompt: steering.prompt } : {}) }, undefined, undefined, harness.ctx);
					} else {
						await harness.tools.get("workflow_control").execute(`steer-${steeringIndex}`, { ref: adapter.workflowRef, action: steering.action }, undefined, undefined, harness.ctx);
					}
					if (steering.action === "stop") { terminal = "paused"; break; }
					await wait(5);
					continue;
				}
				terminal = "paused";
				break;
			}
			await wait(5);
		}
	} finally {
		await harness.shutdownSession();
	}

	const trace: ScenarioTraceEvent[] = [...adapter.trace];
	let sequence = trace.at(-1)?.sequence ?? 0;
	for (const entry of harness.messages) {
		const content = String(entry.message?.content ?? "");
		trace.push({ sequence: ++sequence, type: "workflow_message", detail: content, attention: entry.message?.customType === "pibox-workflow-event" && Boolean(entry.options?.triggerTurn) });
	}
	const statuses = adapter.statuses();
	const outcomeFindings: string[] = [];
	if (terminal !== scenario.expect.terminal) outcomeFindings.push(`Terminal state was ${terminal}; expected ${scenario.expect.terminal}.`);
	for (const id of scenario.expect.started ?? []) if (!adapter.starts.has(id)) outcomeFindings.push(`Expected step ${id} was not started.`);
	for (const id of scenario.expect.notStarted ?? []) if (adapter.starts.has(id)) outcomeFindings.push(`Step ${id} started unexpectedly.`);
	for (const id of scenario.expect.completed ?? []) if (statuses[id] !== "done") outcomeFindings.push(`Expected step ${id} to complete; status was ${statuses[id] ?? "missing"}.`);

	const schedulingFindings = adapter.violations.filter((finding) => finding.includes("dependencies"));
	if (scenario.expect.minPeakConcurrency !== undefined && adapter.peakConcurrency < scenario.expect.minPeakConcurrency) schedulingFindings.push(`Peak concurrency ${adapter.peakConcurrency} was below ${scenario.expect.minPeakConcurrency}.`);
	if (scenario.expect.maxPeakConcurrency !== undefined && adapter.peakConcurrency > scenario.expect.maxPeakConcurrency) schedulingFindings.push(`Peak concurrency ${adapter.peakConcurrency} exceeded ${scenario.expect.maxPeakConcurrency}.`);
	const safetyFindings = adapter.violations.filter((finding) => finding.includes("resource claim"));
	const protocolFindings: string[] = [];
	for (const [id, count] of adapter.starts) {
		const expected = scenario.expect.attempts?.[id] ?? 1;
		if (count !== expected) protocolFindings.push(`Step ${id} started ${count} time(s); expected ${expected}.`);
	}
	for (const [id, expected] of Object.entries(scenario.expect.attempts ?? {})) if (!adapter.starts.has(id) && expected !== 0) protocolFindings.push(`Step ${id} started 0 time(s); expected ${expected}.`);
	const controlCount = adapter.trace.filter((event) => event.type === "workflow_control").length;
	const expectedControls = scenario.expect.workflowControls ?? 0;
	const autonomyFindings = controlCount === expectedControls ? [] : [`Workflow used ${controlCount} control action(s); expected ${expectedControls}.`];

	const dimension = (name: ScenarioDimension["name"], weight: number, findings: string[]): ScenarioDimension => ({ name, weight, score: findings.length === 0 ? 100 : Math.max(0, 100 - findings.length * 50), findings });
	const dimensions = [
		dimension("outcome", 25, outcomeFindings),
		dimension("scheduling", 25, schedulingFindings),
		dimension("safety", 25, safetyFindings),
		dimension("autonomy", 15, autonomyFindings),
		dimension("protocol", 10, protocolFindings),
	];
	const findings = dimensions.flatMap((entry) => entry.findings);
	const score = Math.round(dimensions.reduce((sum, entry) => sum + entry.score * entry.weight, 0) / dimensions.reduce((sum, entry) => sum + entry.weight, 0));
	return { scenarioId: scenario.id, passed: findings.length === 0, score, terminal, peakConcurrency: adapter.peakConcurrency, stepStatuses: statuses, dimensions, findings, trace };
}
