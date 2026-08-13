import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStrictToolSchemas } from "../strict-tool-schema.js";

test("normalizes non-object function parameter roots for strict local servers", () => {
	const payload = {
		model: "local-model",
		tools: [
			{
				type: "function",
				function: {
					name: "optional-object",
					description: "Accepts an optional object.",
					parameters: {
						type: ["object", "null"],
						properties: { path: { type: "string" } },
						required: ["path"],
					},
				},
			},
		],
	};

	const normalized = normalizeStrictToolSchemas(payload) as typeof payload;
	assert.equal(normalized.tools[0]?.function.parameters.type, "object");
	assert.deepEqual(normalized.tools[0]?.function.parameters.properties, payload.tools[0]?.function.parameters.properties);
	assert.deepEqual(normalized.tools[0]?.function.parameters.required, ["path"]);
	assert.deepEqual(payload.tools[0]?.function.parameters.type, ["object", "null"]);
});

test("adds an empty properties object when strict servers require one", () => {
	const payload = { tools: [{ type: "function", function: { name: "no-args", parameters: { type: "object" } } }] };
	const normalized = normalizeStrictToolSchemas(payload) as {
		tools: Array<{ function: { parameters: { type: string; properties?: unknown } } }>;
	};
	assert.deepEqual(normalized.tools[0]?.function.parameters.properties, {});
	assert.equal("properties" in payload.tools[0]!.function.parameters, false);
});

test("leaves ordinary object schemas and payloads without tools unchanged", () => {
	const schema = { type: "object", properties: { query: { type: "string" } } };
	const payload = { tools: [{ type: "function", function: { name: "search", parameters: schema } }] };
	assert.equal(normalizeStrictToolSchemas(payload), payload);
	const noTools = { model: "local-model" };
	assert.equal(normalizeStrictToolSchemas(noTools), noTools);
});
