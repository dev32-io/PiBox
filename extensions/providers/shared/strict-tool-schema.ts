type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Local OpenAI-compatible servers such as LM Studio can reject a function
 * schema unless its parameter root has the literal discriminator `type:
 * "object"`. Tool-call arguments are objects in the OpenAI API, so make that
 * root explicit while leaving the tool's nested JSON Schema untouched.
 */
export function normalizeStrictToolSchemas(payload: unknown): unknown {
	if (!isObject(payload) || !Array.isArray(payload.tools)) return payload;

	let changed = false;
	const tools = payload.tools.map((tool) => {
		if (!isObject(tool) || !isObject(tool.function) || !isObject(tool.function.parameters)) return tool;
		const parameters = tool.function.parameters;
		const needsObjectType = parameters.type !== "object";
		const needsProperties = !isObject(parameters.properties);
		if (!needsObjectType && !needsProperties) return tool;
		changed = true;
		return {
			...tool,
			function: {
				...tool.function,
				parameters: {
					...parameters,
					...(needsObjectType ? { type: "object" } : {}),
					...(needsProperties ? { properties: {} } : {}),
				},
			},
		};
	});

	return changed ? { ...payload, tools } : payload;
}
