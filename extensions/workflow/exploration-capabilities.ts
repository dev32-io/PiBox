import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { describeHarnessError, HarnessError } from "./errors.js";
import { validateExplorationAssignment, validateExplorationHandoff, type ExplorationAssignment, type ExplorationHandoff } from "./exploration-contracts.js";
import { atomicWriteFile } from "./repository.js";

const result = (text: string, details: unknown = null) => ({ content: [{ type: "text" as const, text }], details });

function scope() {
	const root = process.env.PIBOX_SUBAGENT_ROOT;
	const assignmentPath = process.env.PIBOX_SUBAGENT_ASSIGNMENT_PATH;
	const agentId = process.env.PIBOX_SUBAGENT_ID;
	const attemptId = process.env.PIBOX_SUBAGENT_ATTEMPT_ID;
	if (process.env.PIBOX_SUBAGENT_ROLE !== "explorer" || !root || !assignmentPath || !agentId || !attemptId) throw new HarnessError("CAPABILITY_DENIED", "Exploration capability requires an authorized explorer attempt");
	return { root, assignmentPath, agentId, attemptId };
}

async function context(_ctx: ExtensionContext): Promise<{ scope: ReturnType<typeof scope>; assignment: ExplorationAssignment }> {
	const authorized = scope();
	const assignment = JSON.parse(await readFile(authorized.assignmentPath, "utf8")) as ExplorationAssignment;
	validateExplorationAssignment(assignment);
	return { scope: authorized, assignment };
}

export const isExplorationProcess = () => process.env.PIBOX_SUBAGENT_ROLE === "explorer" && Boolean(process.env.PIBOX_SUBAGENT_ID);

export function registerExplorationCapabilities(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "exploration_context",
		label: "Exploration Context",
		description: "Read the immutable typed exploration assignment for this attempt.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			try { const authorized = await context(ctx); return result(JSON.stringify(authorized.assignment, null, 2), authorized.assignment); }
			catch (error) { throw new Error(describeHarnessError(error)); }
		},
	});

	pi.registerTool({
		name: "exploration_checkpoint",
		label: "Exploration Checkpoint",
		description: "Persist material evidence and the next probe for recovery.",
		parameters: Type.Object({ observations: Type.Array(Type.String()), nextProbe: Type.Optional(Type.String()), uncertainty: Type.Optional(Type.Array(Type.String())) }),
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const authorized = await context(ctx);
				await atomicWriteFile(join(authorized.scope.root, "checkpoint.json"), `${JSON.stringify({ ...params, at: new Date().toISOString() }, null, 2)}\n`, 0o600);
				return result("Exploration checkpoint persisted.");
			} catch (error) { throw new Error(describeHarnessError(error)); }
		},
	});

	pi.registerTool({
		name: "exploration_blocked",
		label: "Exploration Blocked",
		description: "Persist why the requested evidence cannot be obtained and the cheapest next probe.",
		parameters: Type.Object({ summary: Type.String(), evidence: Type.Array(Type.String()), nextProbe: Type.String() }),
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const authorized = await context(ctx);
				await atomicWriteFile(join(authorized.scope.root, "blocked.json"), `${JSON.stringify({ ...params, at: new Date().toISOString() }, null, 2)}\n`, 0o600);
				return result("Exploration blocker persisted; end the attempt without claiming completion.");
			} catch (error) { throw new Error(describeHarnessError(error)); }
		},
	});

	pi.registerTool({
		name: "exploration_complete",
		label: "Complete Exploration",
		description: "Write the required mode-sensitive structured exploration handoff.",
		parameters: Type.Object({
			answer: Type.String(),
			evidence: Type.Array(Type.Object({ path: Type.String(), line: Type.Optional(Type.Number()), symbol: Type.Optional(Type.String()), observation: Type.String() })),
			unknowns: Type.Array(Type.String()),
			observedSystem: Type.Optional(Type.String()), dataFlow: Type.Optional(Type.Array(Type.String())), workingComparison: Type.Optional(Type.String()),
			changeImplications: Type.Optional(Type.Array(Type.String())), hiddenCases: Type.Optional(Type.Array(Type.String())),
			expectedBehavior: Type.Optional(Type.String()), actualBehavior: Type.Optional(Type.String()), reproduction: Type.Optional(Type.String()),
			hypotheses: Type.Optional(Type.Array(Type.Object({ statement: Type.String(), supportingEvidence: Type.Array(Type.String()), conflictingEvidence: Type.Array(Type.String()), confidence: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]) }))),
			proximateCause: Type.Optional(Type.String()), upstreamCondition: Type.Optional(Type.String()), mentalModel: Type.Optional(Type.String()), nextReading: Type.Optional(Type.Array(Type.String())), nextProbe: Type.Optional(Type.String()),
		}, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const authorized = await context(ctx);
				const handoff: ExplorationHandoff = {
					schemaVersion: 1, type: "exploration_complete", agentId: authorized.scope.agentId, attemptId: authorized.scope.attemptId, mode: authorized.assignment.mode,
					...params, completedAt: new Date().toISOString(),
				};
				validateExplorationHandoff(handoff, authorized.assignment);
				await atomicWriteFile(join(authorized.scope.root, "handoff.json"), `${JSON.stringify(handoff, null, 2)}\n`, 0o600);
				return result("Exploration handoff accepted.", handoff);
			} catch (error) { throw new Error(describeHarnessError(error)); }
		},
	});
}
