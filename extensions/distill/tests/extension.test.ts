import assert from "node:assert/strict";
import test from "node:test";
import distillExtension from "../index.js";

function harness() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	const sent: string[] = [];
	const bus = new Map<string, Array<(value: unknown) => void>>();
	const pi = {
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(name: string, handler: any) { handlers.set(name, handler); },
		sendUserMessage(content: string) { sent.push(content); },
		events: {
			on(name: string, handler: (value: unknown) => void) { const list = bus.get(name) ?? []; list.push(handler); bus.set(name, list); },
			emit(name: string, value: unknown) { for (const handler of bus.get(name) ?? []) handler(value); },
		},
	} as any;
	distillExtension(pi);
	return { tools, commands, handlers, sent, pi };
}

test("registers the backend-independent distillation surface", () => {
	const h = harness();
	assert.deepEqual([...h.tools.keys()], ["distill_prepare", "distill_collect", "distill_read", "distill_record", "distill_compare", "distill_instruction_check"]);
	assert.equal(h.commands.has("distill"), true);
	assert.deepEqual([...h.handlers.keys()], ["session_start", "session_shutdown"]);
});

test("the /distill command enters the skill with the user's natural-language scope", async () => {
	const h = harness();
	await h.commands.get("distill").handler("what changed since v1.0 for failure modes", {});
	assert.equal(h.sent.length, 1);
	assert.match(h.sent[0] ?? "", /what changed since v1\.0 for failure modes/);
	assert.match(h.sent[0] ?? "", /Do not call `distill_collect` until the user confirms/);
	assert.match(h.sent[0] ?? "", /example, explanation, history, summary, descriptive fact/);
});
