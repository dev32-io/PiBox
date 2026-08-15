import assert from "node:assert/strict";
import test from "node:test";
import { coreScenarios } from "../scenarios/core.js";
import { runWorkflowScenario } from "../scenario-runner.js";

for (const scenario of coreScenarios) {
	test(`workflow benchmark: ${scenario.id}`, async () => {
		const result = await runWorkflowScenario(scenario);
		assert.equal(result.passed, true, `${result.findings.join("\n")}\nTrace:\n${JSON.stringify(result.trace, null, 2)}`);
		assert.equal(result.score, 100);
	});
}
