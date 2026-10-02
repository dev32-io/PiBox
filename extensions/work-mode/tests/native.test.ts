import assert from "node:assert/strict";
import test from "node:test";
import { getCurrentTools } from "@earendil-works/pi-ai";
import workModeExtension from "../index.js";
import workflowExtension from "../../workflow/index.js";
import workflowRuntimeExtension from "../../workflow-runtime/index.js";
import { WORKFLOW_TOOL_NAMES } from "../tool-groups.js";
import { nativeSession } from "./support/native-session.js";

// Register production tools; no workflow tool executes or discovers repositories.
test("native direct workflow registrations disappear from codemode after leaving Workflow and return on reentry", { timeout: 30_000 }, async () => {
	let registry: Array<{ name: string; exposure?: string }> = [];
	const h = await nativeSession([workflowRuntimeExtension, workflowExtension, workModeExtension, (pi) => {
		pi.on("session_start", () => { registry = pi.getAllTools(); });
	}]);
	try {
		await h.session.bindExtensions({ mode: "print", uiContext: {
			confirm: async () => true, notify() {}, setStatus() {}, setWidget() {},
		} as any });
		for (const name of WORKFLOW_TOOL_NAMES) assert.equal(registry.find((tool) => tool.name === name)?.exposure, "direct", name);
		for (const mode of ["orchestrator", "workflow", "agent", "workflow", "orchestrator"]) {
			await h.session.prompt(`/mode ${mode}`);
			const exposed = mode === "workflow";
			for (const name of WORKFLOW_TOOL_NAMES) assert.equal(h.session.getActiveToolNames().includes(name), exposed, `${mode}: ${name}`);
			const requests = await h.call("codemode", { code: "text({all:ALL_TOOLS,search:await searchTools('workflow_status'),describe:(await describeTool('workflow_status'))??null,callable:typeof tools.workflow_status});" });
			assert.equal(requests.length, 2);
			const result = [...requests[1]!.messages].reverse().find((message) => message.role === "toolResult");
			assert.ok(result && !result.isError, JSON.stringify(result));
			const output = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
			const discovery = JSON.parse(output.slice(output.indexOf("{")));
			for (const name of WORKFLOW_TOOL_NAMES) assert.equal(discovery.all.some((tool: { name: string }) => tool.name === name), exposed, `${mode}: ALL_TOOLS ${name}`);
			assert.equal(discovery.search.some((tool: { name: string }) => tool.name === "workflow_status"), exposed, `${mode}: searchTools`);
			assert.equal(discovery.describe !== null, exposed, `${mode}: describeTool`);
			assert.equal(discovery.callable, exposed ? "function" : "undefined", `${mode}: tools`);
			const schemas = getCurrentTools(requests[0]!.messages);
			if (!exposed) {
				for (const name of WORKFLOW_TOOL_NAMES) assert.ok(!JSON.stringify(schemas).includes(name), `${mode}: provider tool definitions omit ${name}`);
			}
		}
	} finally { await h.close(); }
});
