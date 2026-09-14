import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describeHarnessError, HarnessError } from "./errors.js";
import { discoverRepository } from "./repository.js";
import { WorkItemStore } from "./work-items.js";
import { isLedgerWriterAction, writeLedgerSubmission } from "./ledger-submission.js";
import { isSubagentRuntime } from "../subagent/tool-policy.js";
import { parseE2e } from "./authored-markdown.js";
import { setE2eRequiredCasesProvider } from "../e2e-workspace/workspace.js";

const MAX_CLARIFICATION_BYTES = 16 * 1024;
const DEFAULT_LINE_COUNT = 200;
const MAX_LINE_COUNT = 200;
const DEFAULT_CONTEXT_LINES = 4;
const MAX_CONTEXT_LINES = 12;
const DEFAULT_MATCHES = 8;
const MAX_MATCHES = 8;

const sectionSchema = Type.Union([Type.Literal("spec"), Type.Literal("design")]);
const readRequestSchema = Type.Object({
	section: sectionSchema,
	startLine: Type.Optional(Type.Integer({ minimum: 1 })),
	lineCount: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LINE_COUNT })),
}, { additionalProperties: false });
const searchRequestSchema = Type.Object({
	section: sectionSchema,
	findText: Type.String({ minLength: 1, maxLength: 256 }),
	contextLines: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_CONTEXT_LINES })),
	maxMatches: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_MATCHES })),
}, { additionalProperties: false });
export type TaskClarificationRequest =
	| { section: "spec" | "design"; startLine?: number; lineCount?: number }
	| { section: "spec" | "design"; findText: string; contextLines?: number; maxMatches?: number };

const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: null });

function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let bytes = 0;
	let output = "";
	for (const character of value) {
		const width = Buffer.byteLength(character, "utf8");
		if (bytes + width > maxBytes) break;
		output += character;
		bytes += width;
	}
	return output;
}

function boundedOutput(header: string[], content: string): string {
	const prefix = `${header.join("\n")}\n---\n`;
	const marker = "\n[… output truncated at the 16 KiB task clarification limit]";
	const available = Math.max(0, MAX_CLARIFICATION_BYTES - Buffer.byteLength(prefix, "utf8"));
	if (Buffer.byteLength(content, "utf8") <= available) return `${prefix}${content}`;
	const bodyBudget = Math.max(0, available - Buffer.byteLength(marker, "utf8"));
	return `${prefix}${truncateUtf8(content, bodyBudget)}${marker}`;
}

function readLines(section: "spec" | "design", value: string, request: Extract<TaskClarificationRequest, { startLine?: number }>): string {
	const lines = value.split("\n");
	const startLine = request.startLine ?? 1;
	const lineCount = request.lineCount ?? DEFAULT_LINE_COUNT;
	if (startLine > lines.length) throw new HarnessError("INVALID_ARTIFACT", `${section} has ${lines.length} lines; startLine ${startLine} is out of range`);
	const endLine = Math.min(lines.length, startLine + lineCount - 1);
	const content = lines.slice(startLine - 1, endLine).join("\n");
	return boundedOutput([
		`section: ${section}`,
		`lines: ${startLine}-${endLine} of ${lines.length}`,
		`moreLines: ${endLine < lines.length ? "true" : "false"}`,
	], content);
}

function searchLines(section: "spec" | "design", value: string, request: Extract<TaskClarificationRequest, { findText: string }>): string {
	if (!request.findText.trim()) throw new HarnessError("INVALID_ARTIFACT", "task_clarify findText must contain a non-whitespace literal");
	if (/\r|\n/.test(request.findText)) throw new HarnessError("INVALID_ARTIFACT", "task_clarify findText must be a single-line literal");
	const lines = value.split("\n");
	const needle = request.findText.toLowerCase();
	const matchingLines = lines.flatMap((line, index) => line.toLowerCase().includes(needle) ? [index] : []);
	const maxMatches = request.maxMatches ?? DEFAULT_MATCHES;
	const selected = matchingLines.slice(0, maxMatches);
	const context = request.contextLines ?? DEFAULT_CONTEXT_LINES;
	const ranges: Array<{ start: number; end: number }> = [];
	for (const index of selected) {
		const start = Math.max(0, index - context);
		const end = Math.min(lines.length - 1, index + context);
		const previous = ranges.at(-1);
		if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end);
		else ranges.push({ start, end });
	}
	const content = ranges.length
		? ranges.map((range) => [`[lines ${range.start + 1}-${range.end + 1}]`, lines.slice(range.start, range.end + 1).join("\n")].join("\n")).join("\n\n")
		: "No matching lines.";
	return boundedOutput([
		`section: ${section}`,
		`findText: ${JSON.stringify(request.findText)}`,
		`matchingLines: ${matchingLines.length}`,
		`shownMatches: ${selected.length}`,
		`moreMatches: ${matchingLines.length > selected.length ? "true" : "false"}`,
	], content);
}

export async function readTaskClarification(store: WorkItemStore, storyId: string, request: TaskClarificationRequest): Promise<string> {
	if (request.section !== "spec" && request.section !== "design") throw new HarnessError("INVALID_ARTIFACT", "task_clarify accepts only the story spec or design field");
	const value = (await store.readStory(storyId))[request.section];
	return "findText" in request ? searchLines(request.section, value, request) : readLines(request.section, value, request);
}

export function isTargetTaskProcess(): boolean {
	return Boolean(process.env.PIBOX_WORKFLOW_STORY_ID && process.env.PIBOX_WORKFLOW_TASK_ID && process.env.PIBOX_WORKFLOW_ATTEMPT_TOKEN);
}

const TASK_LEDGER_ACTIONS = new Set(["task-launch", "task-repair"]);

function ledgerAttemptIdentity(): { storyId: string; action: string; attemptToken: string; taskId?: string } {
	if (!isSubagentRuntime(process.env)) throw new HarnessError("CAPABILITY_DENIED", "workflow_ledger requires managed subagent runtime identity");
	const storyId = process.env.PIBOX_WORKFLOW_STORY_ID;
	const action = process.env.PIBOX_WORKFLOW_ACTION;
	const attemptToken = process.env.PIBOX_WORKFLOW_ATTEMPT_TOKEN;
	if (!storyId || !action || !attemptToken || !isLedgerWriterAction(action)) throw new HarnessError("CAPABILITY_DENIED", "workflow_ledger requires an eligible managed workflow writer attempt");
	const taskId = process.env.PIBOX_WORKFLOW_TASK_ID;
	if (TASK_LEDGER_ACTIONS.has(action) && !taskId) throw new HarnessError("CAPABILITY_DENIED", `workflow_ledger ${action} requires managed task identity`);
	return { storyId, action, attemptToken, ...(taskId ? { taskId } : {}) };
}

export function isLedgerWriterProcess(): boolean {
	try { ledgerAttemptIdentity(); return true; }
	catch { return false; }
}

function isManagedE2eProcess(): boolean {
	return isSubagentRuntime(process.env) && process.env.PIBOX_WORKFLOW_ACTION === "e2e"
		&& Boolean(process.env.PIBOX_WORKFLOW_STORY_ID && process.env.PIBOX_WORKFLOW_ATTEMPT_TOKEN);
}

async function targetTaskStore(ctx: ExtensionContext): Promise<{ store: WorkItemStore; storyId: string }> {
	const storyId = process.env.PIBOX_WORKFLOW_STORY_ID;
	const taskId = process.env.PIBOX_WORKFLOW_TASK_ID;
	if (!storyId || !taskId || !isTargetTaskProcess()) throw new HarnessError("CAPABILITY_DENIED", "Task clarification requires a current managed target task attempt");
	const identity = await discoverRepository(ctx.cwd);
	const store = new WorkItemStore(identity.root);
	await store.readAuthoredTask(storyId, taskId);
	return { store, storyId };
}

export function registerWorkerCapabilities(pi: ExtensionAPI): void {
	if (isManagedE2eProcess()) setE2eRequiredCasesProvider(async () => {
		const storyId = process.env.PIBOX_WORKFLOW_STORY_ID!;
		const repository = await discoverRepository(process.cwd());
		return parseE2e((await new WorkItemStore(repository.root).readStory(storyId)).e2e).cases.map(({ id }) => id);
	});

	if (isTargetTaskProcess()) pi.registerTool({
		name: "task_clarify",
		label: "Task Clarification",
		description: "Exceptionally search or read a bounded line range from the free-form story spec or design when the assigned task and repository leave a concrete ambiguity. Search uses a case-insensitive literal and returns bounded matching passages. This tool cannot list or mutate resources.",
		parameters: Type.Union([readRequestSchema, searchRequestSchema]),
		async execute(_id, params, _signal, _update, ctx) {
			try { const target = await targetTaskStore(ctx); return result(await readTaskClarification(target.store, target.storyId, params)); }
			catch (error) { throw new Error(describeHarnessError(error)); }
		},
	});

	if (isLedgerWriterProcess()) pi.registerTool({
		name: "workflow_ledger",
		label: "Queue Workflow Ledger Note",
		description: "Queue one optional non-obvious finding with supporting evidence for harness validation and persistence when this managed writer attempt settles.",
		parameters: Type.Object({
			action: Type.Literal("append"),
			entry: Type.String({ minLength: 1 }),
			evidence: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		}, { additionalProperties: false }),
		async execute(_id, params) {
			try {
				ledgerAttemptIdentity();
				if (params.action !== "append") throw new HarnessError("CAPABILITY_DENIED", "workflow_ledger supports append only");
				const reportPath = process.env.PIBOX_SUBAGENT_REPORT_PATH;
				if (!reportPath) throw new HarnessError("CAPABILITY_DENIED", "workflow_ledger requires harness-managed attempt report path");
				await writeLedgerSubmission(reportPath, { summary: params.entry, ...(params.evidence === undefined ? {} : { evidence: params.evidence }) });
				return result("Queued for harness persistence when this attempt settles; not yet persisted.");
			} catch (error) { throw new Error(describeHarnessError(error)); }
		},
	});
}
