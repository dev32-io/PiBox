import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceCriterionIds, isSubstantive, renderArtifact } from "../artifact-contracts.js";

const spec = {
	context: "Harness artifacts need stable structure.",
	requiredBehaviors: ["Render semantic values as readable Markdown."],
	acceptanceCriteria: [{ id: "AC-001", statement: "Required sections are present." }],
	outOfScope: ["Project-owned documentation."],
};

test("renders a structured schema-v2 E2E matrix with exact case fields", () => {
	const content = renderArtifact("e2e-matrix", "Checkout E2E Matrix", {
		scope: ["Checkout touched area"],
		cases: [{ id: "E2E-001", classification: "golden-path", journey: "Customer completes checkout", setup: ["Seed valid cart"], actions: ["Submit checkout"], expectedOutcomes: ["Order confirmation is shown"], evidence: ["Confirmation screenshot and order id"], safety: ["Use disposable data"] }],
	});
	assert.match(content, /## Cases[\s\S]+E2E-001[\s\S]+golden-path/);
	assert.match(content, /Expected Outcomes/);
});

test("renders schema-v2 semantic sections in stable Markdown", () => {
	const content = renderArtifact("spec", "Artifact contract", spec);
	assert.match(content, /^# Artifact contract/);
	assert.match(content, /## Context[\s\S]+## Required Behaviors[\s\S]+## Acceptance Criteria/);
	assert.deepEqual(acceptanceCriterionIds(spec), ["AC-001"]);
});

test("rejects missing, placeholder, duplicate, and reserved additional content", () => {
	assert.equal(isSubstantive("<!-- hidden -->"), false);
	assert.equal(isSubstantive("TBD"), false);
	assert.throws(() => renderArtifact("spec", "Missing", { ...spec, context: "N/A" }));
	assert.throws(() => acceptanceCriterionIds({ acceptanceCriteria: [{ id: "AC-001" }, { id: "AC-001" }] }));
	assert.throws(() => renderArtifact("spec", "Collision", { ...spec, additionalSections: [{ title: "Context", content: "Duplicate" }] }));
});

test("omits absent optional sections and permits substantive additions", () => {
	const content = renderArtifact("decision", "Choose rendering", {
		decision: "Render Markdown from typed values.",
		context: "Formatting is mechanical.",
		rationale: "Capabilities enforce mechanical truth.",
		consequences: [{ kind: "benefit", statement: "Stable structure" }],
		additionalSections: [{ title: "Implementation Note", content: "Keep legacy reads." }],
	});
	assert.doesNotMatch(content, /Alternatives Considered/);
	assert.match(content, /## Implementation Note/);
});
