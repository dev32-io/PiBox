import assert from "node:assert/strict";
import test from "node:test";
import { gitSafetyScenarios } from "../git-safety.js";

for (const scenario of gitSafetyScenarios) {
	test(`workflow Git benchmark: ${scenario.name}`, async () => {
		const result = await scenario();
		assert.equal(result.passed, true, result.findings.join("\n"));
		assert.equal(result.score, 100);
	});
}
