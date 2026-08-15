import assert from "node:assert/strict";
import test from "node:test";
import { recoverySafetyScenarios } from "../recovery-safety.js";

for (const scenario of recoverySafetyScenarios) {
	test(`workflow recovery benchmark: ${scenario.name}`, async () => {
		const result = await scenario();
		assert.equal(result.passed, true, result.findings.join("\n"));
		assert.equal(result.score, 100);
	});
}
