import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { renderWorkflowEventMessage, workflowEventHeadline } from "../workflow-event-display.js";

const theme = {
	fg: (_token: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as Theme;

const details = {
	workflowRef: "work-item:checkout",
	title: "Stage review completed",
	detail: "The reviewer returned a bounded report.",
	attention: false,
	kind: "evaluation",
	fromStatus: "reviewing",
	toStatus: "done",
	nextAction: "Read the canonical report.",
};

function lines(expanded: boolean): string[] {
	return renderWorkflowEventMessage(
		{ content: "context packet", details },
		{ expanded, outputPad: 1 },
		theme,
	).render(180).map((line) => stripTerminalSequences(line).trimEnd());
}

test("collapsed workflow event renders one concise preview title", () => {
	assert.equal(workflowEventHeadline(details), "Workflow event · Evaluation · reviewing → done — Stage review completed");
	assert.deepEqual(lines(false), [" ◆ Workflow event · Evaluation · reviewing → done — Stage review completed"]);
});

test("ctrl+o expanded state reveals the complete workflow event details", () => {
	const rendered = lines(true);
	assert.equal(rendered[0], " ◆ Workflow event · Evaluation · reviewing → done — Stage review completed");
	assert.match(rendered.join("\n"), /   \{\n     "workflowRef": "work-item:checkout"/);
	assert.match(rendered.join("\n"), /     "nextAction": "Read the canonical report\."/);
	assert.match(rendered.join("\n"), /   \}/);
});
