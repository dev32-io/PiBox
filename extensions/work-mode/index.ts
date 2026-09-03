import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isSubagentRuntime } from "../core/runtime-role.js";
import { registerInteractiveFooterItem } from "../tui/interactive-footer/registry.js";
import type { InteractiveFooterRegistration } from "../tui/interactive-footer/types.js";
import {
	branchHasProviderHistory,
	DEFAULT_WORK_MODE,
	requestedStartupMode,
	restoreWorkMode,
	serializeWorkModeStatus,
	WORK_MODE_ENTRY_TYPE,
	WORK_MODE_EVENT,
	WORK_MODE_STATUS_KEY,
	WORK_MODES,
	WORK_MODE_ICONS,
	workModeLabel,
	type PiBoxWorkMode,
	type WorkModeEntry,
} from "./policy.js";
import { installWorkModeRuntime } from "./runtime.js";
import { WORKFLOW_TOOL_NAMES, WORKFLOW_TOOL_NAME_SET } from "./tool-groups.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ORCHESTRATOR_PROMPT = readFileSync(resolve(PACKAGE_ROOT, "prompt/orchestrator-mode.md"), "utf8").trim();
const MODE_DESCRIPTIONS: Record<PiBoxWorkMode, string> = {
	agent: "Direct work with ordinary PiBox capabilities. Scratch is optional and workflow operations are blocked.",
	orchestrator: "Plan- and ledger-driven coordination with deliberate subagent delegation. Workflow operations remain blocked.",
	workflow: "Structured story, plan, stage, review, and E2E delivery. Existing workflow authority gates still apply.",
	designer: "Repository-aware visual design authority with the Designer prompt and handoff skill.",
};

export interface ModeTransitionImpact {
	changesSystemPrompt: boolean;
	changesToolDefinitions: boolean;
	mayMissPromptCache: boolean;
}

function promptFamily(mode: PiBoxWorkMode): "base" | "orchestrator" | "designer" {
	if (mode === "orchestrator") return "orchestrator";
	if (mode === "designer") return "designer";
	return "base";
}

export function modeTransitionImpact(state: WorkModeEntry, target: PiBoxWorkMode): ModeTransitionImpact {
	if (!state.providerMode) return { changesSystemPrompt: false, changesToolDefinitions: false, mayMissPromptCache: false };
	const changesSystemPrompt = promptFamily(state.providerMode) !== promptFamily(target);
	const changesToolDefinitions = !state.workflowToolsExposed && target === "workflow";
	return { changesSystemPrompt, changesToolDefinitions, mayMissPromptCache: changesSystemPrompt || changesToolDefinitions };
}

function formatTokens(value: number): string {
	if (value < 1_000) return String(Math.round(value));
	if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

function cacheWarning(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	const estimate = usage?.tokens === null || usage?.tokens === undefined ? "Current context size is unavailable." : `Current context is approximately ${formatTokens(usage.tokens)} tokens.`;
	return `This switch may cause a large prompt-cache miss on the next model request. ${estimate} The logical conversation is preserved.`;
}

function sameTools(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((name, index) => name === right[index]);
}

export default function workModeExtension(pi: ExtensionAPI): void {
	if (isSubagentRuntime(process.env)) return;

	pi.registerFlag("work-mode", { description: `Start Pi in a PiBox work mode (${WORK_MODES.join(", ")})`, type: "string" });
	pi.registerFlag("profile", { description: "Deprecated alias for --work-mode designer", type: "string" });

	let state: WorkModeEntry = { schemaVersion: 1, mode: DEFAULT_WORK_MODE, workflowToolsExposed: false };
	let sessionCtx: ExtensionContext | undefined;
	let eligibleWorkflowTools: string[] = [];
	let generation = 0;
	let mainAgentActive = false;
	let registration: InteractiveFooterRegistration | undefined;
	let uninstallRuntime: (() => void) | undefined;

	const snapshot = () => ({
		sessionId: sessionCtx?.sessionManager.getSessionId() ?? "unbound",
		mode: state.mode,
		workflowToolsExposed: state.workflowToolsExposed,
		...(state.providerMode ? { providerMode: state.providerMode } : {}),
		generation,
	});
	const publish = (persist: boolean) => {
		generation++;
		if (persist) pi.appendEntry(WORK_MODE_ENTRY_TYPE, state);
		pi.events.emit(WORK_MODE_EVENT, snapshot());
		if (sessionCtx?.hasUI) sessionCtx.ui.setStatus(WORK_MODE_STATUS_KEY, serializeWorkModeStatus(state.mode));
		registration?.changed();
	};
	const fallbackUnavailableDesigner = (ctx: ExtensionContext): boolean => {
		if (state.mode !== "designer" || pi.getActiveTools().includes("subagent_spawn")) return false;
		state = { ...state, mode: "agent" };
		ctx.ui.notify("Designer mode requires the active subagent_spawn tool. Falling back to Agent; adjust the Pi tool allowlist before switching.", "warning");
		return true;
	};
	const applyToolExposure = () => {
		const current = pi.getActiveTools();
		const withoutWorkflow = current.filter((name) => !WORKFLOW_TOOL_NAME_SET.has(name));
		const shouldExpose = state.workflowToolsExposed || state.mode === "workflow";
		const next = shouldExpose
			? [...withoutWorkflow, ...WORKFLOW_TOOL_NAMES.filter((name) => eligibleWorkflowTools.includes(name) && !withoutWorkflow.includes(name))]
			: withoutWorkflow;
		if (!sameTools(current, next)) pi.setActiveTools(next);
	};
	const selectMode = async (next: PiBoxWorkMode, ctx: ExtensionContext) => {
		if (mainAgentActive) throw new Error("Wait for the active agent turn to settle before changing work mode.");
		if (next === state.mode) return;
		if (next === "designer" && !pi.getActiveTools().includes("subagent_spawn")) {
			throw new Error("Designer mode requires the active subagent_spawn tool. Adjust the Pi tool allowlist before switching.");
		}
		state = { ...state, mode: next };
		applyToolExposure();
		publish(true);
		if (ctx.hasUI) ctx.ui.notify(`PiBox mode: ${workModeLabel(next)}`, "info");
	};
	const dialog = (ctx: ExtensionContext) => ({
		kind: "choice" as const,
		title: "PiBox work mode",
		description: "Choose how PiBox should work in this session.",
		value: () => state.mode,
		choices: WORK_MODES.map((mode) => ({
			value: mode,
			label: workModeLabel(mode),
			marker: WORK_MODE_ICONS[mode],
			description: MODE_DESCRIPTIONS[mode],
			...(mode === "designer" ? { disabled: () => !pi.getActiveTools().includes("subagent_spawn") } : {}),
		})),
		notice(selected: string) {
			const mode = selected as PiBoxWorkMode;
			if (mode === state.mode) return undefined;
			if (mode === "designer" && !pi.getActiveTools().includes("subagent_spawn")) {
				return { text: "Designer requires the active subagent_spawn tool.", tone: "error" as const };
			}
			if (modeTransitionImpact(state, mode).mayMissPromptCache) return { text: `⚠ ${cacheWarning(ctx)}`, tone: "warning" as const };
			return undefined;
		},
		confirm: (selected: string) => selectMode(selected as PiBoxWorkMode, ctx),
	});


	pi.registerCommand("mode", {
		description: "Show or change the PiBox work mode",
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			if (!requested || requested === "status") {
				ctx.ui.notify(`PiBox mode: ${workModeLabel(state.mode)}`, "info");
				return;
			}
			if (!(WORK_MODES as readonly string[]).includes(requested)) {
				ctx.ui.notify(`Usage: /mode [${WORK_MODES.join("|")}|status]`, "warning");
				return;
			}
			await ctx.waitForIdle();
			const next = requested as PiBoxWorkMode;
			if (next === state.mode) {
				ctx.ui.notify(`PiBox mode: ${workModeLabel(state.mode)}`, "info");
				return;
			}
			if (modeTransitionImpact(state, next).mayMissPromptCache) {
				const confirmed = await ctx.ui.confirm(`Switch to ${workModeLabel(next)} mode?`, cacheWarning(ctx));
				if (!confirmed) return;
			}
			await selectMode(next, ctx);
		},
	});

	pi.on("session_start", (event, ctx) => {
		sessionCtx = ctx;
		mainAgentActive = false;
		eligibleWorkflowTools = WORKFLOW_TOOL_NAMES.filter((name) => pi.getActiveTools().includes(name));
		state = restoreWorkMode(ctx);
		if (!state.providerMode && branchHasProviderHistory(ctx)) state = { ...state, providerMode: "agent" };
		if (state.providerMode === "workflow" && !state.workflowToolsExposed) state = { ...state, workflowToolsExposed: true };
		const startupOverride = event.reason === "startup" ? requestedStartupMode(pi) : undefined;
		if (startupOverride) state = { ...state, mode: startupOverride };
		const correctedUnavailableDesigner = fallbackUnavailableDesigner(ctx);
		applyToolExposure();
		uninstallRuntime?.();
		uninstallRuntime = installWorkModeRuntime({ snapshot });
		registration?.unregister();
		registration = registerInteractiveFooterItem({
			id: "work-mode",
			section: "identity",
			order: 0,
			status: () => ({ label: "Mode", marker: WORK_MODE_ICONS[state.mode], hidden: true }),
			dialog,
		});
		publish(Boolean(startupOverride) || correctedUnavailableDesigner);
	});

	pi.on("session_tree", (_event, ctx) => {
		sessionCtx = ctx;
		state = restoreWorkMode(ctx);
		if (!state.providerMode && branchHasProviderHistory(ctx)) state = { ...state, providerMode: "agent" };
		const correctedUnavailableDesigner = fallbackUnavailableDesigner(ctx);
		applyToolExposure();
		publish(correctedUnavailableDesigner);
	});
	pi.on("before_provider_request", () => {
		const workflowToolsExposed = state.workflowToolsExposed || state.mode === "workflow";
		if (state.providerMode === state.mode && state.workflowToolsExposed === workflowToolsExposed) return;
		state = { ...state, providerMode: state.mode, workflowToolsExposed };
		applyToolExposure();
		publish(true);
	});
	pi.on("before_agent_start", (event) => {
		if (state.mode === "orchestrator") return { systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATOR_PROMPT}` };
	});
	pi.on("context", (event) => {
		const content = state.mode === "workflow"
			? "[PiBox mode: Workflow] Workflow tools are authorized. Follow the phase-specific PiBox skills and preserve every review and execution gate."
			: `[PiBox mode: ${workModeLabel(state.mode)}] Workflow resource and execution tools are not authorized in this mode.`;
		const messages = event.messages.filter((message: any) => !(message?.role === "custom" && message?.customType === "pibox-work-mode-context"));
		let insertion = messages.length;
		for (let index = messages.length - 1; index >= 0; index--) if ((messages[index] as any)?.role === "user") { insertion = index; break; }
		messages.splice(insertion, 0, { role: "custom", customType: "pibox-work-mode-context", content, display: false, timestamp: Date.now() });
		return { messages };
	});
	pi.on("agent_start", () => { mainAgentActive = true; registration?.changed(); });
	pi.on("agent_settled", () => { mainAgentActive = false; registration?.changed(); });
	pi.on("tool_call", (event) => {
		if (state.mode === "workflow" || !WORKFLOW_TOOL_NAME_SET.has(event.toolName)) return;
		return { block: true, reason: "PiBox Workflow mode is required. Select the Workflow icon in the interactive footer, then retry." };
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(WORK_MODE_STATUS_KEY, undefined);
		registration?.unregister();
		registration = undefined;
		uninstallRuntime?.();
		uninstallRuntime = undefined;
		sessionCtx = undefined;
		eligibleWorkflowTools = [];
		state = { schemaVersion: 1, mode: DEFAULT_WORK_MODE, workflowToolsExposed: false };
		mainAgentActive = false;
	});
}

export { WORK_MODE_ICONS as MODE_ICONS };
