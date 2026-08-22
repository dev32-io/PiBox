import assert from "node:assert/strict";
import test from "node:test";
import { validateManagedEvaluationReport } from "../evaluation-integrity.js";

test("managed evaluation verdict cannot contradict its merge line", () => {
	assert.doesNotThrow(() => validateManagedEvaluationReport("MERGE: YES\n\nReady.", "pass"));
	assert.doesNotThrow(() => validateManagedEvaluationReport("MERGE: YES_WITH_RISK\n\nMinor risk.", "pass"));
	assert.doesNotThrow(() => validateManagedEvaluationReport("MERGE: NO\n\nBlocking defect.", "fail"));
	assert.throws(() => validateManagedEvaluationReport("MERGE: NO\n\nBut marked pass.", "pass"), /cannot report MERGE: NO/i);
	assert.throws(() => validateManagedEvaluationReport("MERGE: YES\n\nBut marked fail.", "fail"), /must report MERGE: NO/i);
	assert.throws(() => validateManagedEvaluationReport("No merge line", "pass"), /must begin with an exact MERGE verdict line/i);
});
