import assert from "node:assert/strict";
import test from "node:test";
import { classifyFailure } from "../failure-classifier.js";

test("prefers structured capacity and authentication evidence", () => {
	assert.deepEqual(classifyFailure({ httpStatus: 429, headers: { "retry-after": "60" }, message: "too many requests" }), {
		class: "rate_limited",
		retryAfter: "60",
		capacityRelated: true,
	});
	assert.equal(classifyFailure({ httpStatus: 429, message: "weekly subscription quota exhausted" }).class, "subscription_exhausted");
	assert.equal(classifyFailure({ httpStatus: 401, message: "anything" }).class, "authentication_required");
});

test("classifies recovery-relevant process failures", () => {
	assert.equal(classifyFailure({ message: "context window exceeded" }).class, "context_overflow");
	assert.equal(classifyFailure({ message: "ECONNRESET" }).class, "network_interrupted");
	assert.equal(classifyFailure({ aborted: true }).class, "agent_aborted");
	assert.equal(classifyFailure({ missingProtocol: true }).class, "protocol_failed");
	assert.equal(classifyFailure({ exitCode: 2 }).class, "process_crashed");
});
