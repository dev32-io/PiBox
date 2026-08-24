import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { showInteractiveFooterDialog } from "../tui/interactive-footer/dialog.js";
import { registerInteractiveFooterItem } from "../tui/interactive-footer/registry.js";
import type { InteractiveFooterDialogSpec, InteractiveFooterRegistration } from "../tui/interactive-footer/types.js";
import {
	DEFAULT_FAST_MODE_POLICY,
	FAST_MODE_CHILD_ENV,
	FAST_MODE_ENTRY_TYPE,
	FAST_MODE_POLICY_EVENT,
	FAST_MODE_STATUS_KEY,
	normalizeFastModePolicy,
	projectFastModeStatus,
	resolveFastModeDefaults,
	serializeFastModeStatus,
	withFastServiceTier,
	type FastModePolicy,
	type FastModeSettings,
	type SubagentFastLimit,
} from "./policy.js";

export const FAST_MODE_EXTENSION_PATH = fileURLToPath(import.meta.url);

const MAIN_SETTING = "main";
const SUBAGENT_SETTING = "subagents";
const MAIN_ON = "On";
const MAIN_OFF = "Off";
const SUBAGENT_LABELS: Record<SubagentFastLimit, string> = {
	off: "Off",
	low: "Low only",
	medium: "Up to Medium",
	high: "Up to High",
	max: "All tiers",
};
const SUBAGENT_VALUES = Object.values(SUBAGENT_LABELS);

function isChildProcess(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.PIBOX_SUBAGENT_ID) || env[FAST_MODE_CHILD_ENV] === "1" || env[FAST_MODE_CHILD_ENV] === "0";
}

export function loadGlobalFastModePolicy(cwd: string): FastModePolicy {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false }).getGlobalSettings() as { fastMode?: FastModeSettings };
		return resolveFastModeDefaults(settings.fastMode);
	} catch {
		return { ...DEFAULT_FAST_MODE_POLICY };
	}
}

export function restoreFastModePolicy(
	ctx: ExtensionContext,
	env: NodeJS.ProcessEnv = process.env,
	defaults: FastModePolicy = DEFAULT_FAST_MODE_POLICY,
): FastModePolicy {
	if (isChildProcess(env)) return { main: env[FAST_MODE_CHILD_ENV] === "1", subagents: "off" };
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== FAST_MODE_ENTRY_TYPE) continue;
		const restored = normalizeFastModePolicy(entry.data);
		if (restored) return restored;
	}
	return { ...defaults };
}

function subagentLimitForLabel(label: string): SubagentFastLimit | undefined {
	return (Object.entries(SUBAGENT_LABELS) as Array<[SubagentFastLimit, string]>).find(([, candidate]) => candidate === label)?.[0];
}

export function applyFastModeSetting(policy: FastModePolicy, id: string, value: string): FastModePolicy | undefined {
	if (id === MAIN_SETTING && (value === MAIN_ON || value === MAIN_OFF)) return { ...policy, main: value === MAIN_ON };
	if (id === SUBAGENT_SETTING) {
		const limit = subagentLimitForLabel(value);
		if (limit) return { ...policy, subagents: limit };
	}
	return undefined;
}

export default function fastMode(
	pi: ExtensionAPI,
	env: NodeJS.ProcessEnv = process.env,
	loadDefaults: (cwd: string) => FastModePolicy = loadGlobalFastModePolicy,
): void {
	let policy: FastModePolicy = { ...DEFAULT_FAST_MODE_POLICY };
	let sessionCtx: ExtensionContext | undefined;
	let childProcess = false;
	let interactiveRegistration: InteractiveFooterRegistration | undefined;

	const publishStatus = () => {
		if (!sessionCtx?.hasUI) return;
		sessionCtx.ui.setStatus(FAST_MODE_STATUS_KEY, serializeFastModeStatus(projectFastModeStatus(policy, sessionCtx.model)));
	};

	const applyPolicy = (next: FastModePolicy, persist: boolean) => {
		policy = { ...next };
		// Extensions have isolated module caches. Publish the authoritative policy
		// over Pi's shared event bus instead of depending on runtime.ts identity.
		pi.events.emit(FAST_MODE_POLICY_EVENT, { ...policy });
		if (persist && !childProcess) pi.appendEntry(FAST_MODE_ENTRY_TYPE, policy);
		publishStatus();
		interactiveRegistration?.changed();
	};

	const dialogSpec = (): InteractiveFooterDialogSpec => ({
		title: "Fast mode",
		description: "Requests Fast mode when supported; the provider may downgrade it and additional ChatGPT credits may be used.",
		rows: [
			{
				kind: "setting",
				id: MAIN_SETTING,
				label: "Main session",
				value: () => policy.main ? MAIN_ON : MAIN_OFF,
				values: [MAIN_OFF, MAIN_ON],
				setValue(value) {
					const next = applyFastModeSetting(policy, MAIN_SETTING, value);
					if (next) applyPolicy(next, true);
				},
			},
			{
				kind: "setting",
				id: SUBAGENT_SETTING,
				label: "Subagents",
				value: () => SUBAGENT_LABELS[policy.subagents],
				values: SUBAGENT_VALUES,
				setValue(value) {
					const next = applyFastModeSetting(policy, SUBAGENT_SETTING, value);
					if (next) applyPolicy(next, true);
				},
			},
		],
	});

	const restore = (ctx: ExtensionContext) => {
		sessionCtx = ctx;
		childProcess = isChildProcess(env);
		const defaults = childProcess ? DEFAULT_FAST_MODE_POLICY : loadDefaults(ctx.cwd);
		interactiveRegistration?.unregister();
		interactiveRegistration = registerInteractiveFooterItem({
			id: "fast-mode",
			section: "settings",
			order: 40,
			status: () => {
				const status = projectFastModeStatus(policy, sessionCtx?.model);
				const scopes: string[] = [];
				if (status.mainEnabled) scopes.push("Main");
				if (status.subagents !== "off") scopes.push(`Sub≤${status.subagents === "medium" ? "Med" : status.subagents[0]!.toUpperCase() + status.subagents.slice(1)}`);
				return { label: "Fast", value: scopes.length ? scopes.join("+") : "Off", valueTone: scopes.length ? "warning" : "dim", hidden: scopes.length === 0 && !status.mainAvailable };
			},
			dialog: dialogSpec,
		});
		applyPolicy(restoreFastModePolicy(ctx, env, defaults), false);
	};

	pi.registerCommand("fast", {
		description: "Configure session-scoped ChatGPT Fast mode",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /fast", "error");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/fast requires TUI mode", "error");
				return;
			}
			await showInteractiveFooterDialog(ctx, dialogSpec());
		},
	});

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("model_select", () => publishStatus());
	pi.on("before_provider_request", (event, ctx) => withFastServiceTier(event.payload, policy.main, ctx.model));
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(FAST_MODE_STATUS_KEY, undefined);
		sessionCtx = undefined;
		childProcess = false;
		policy = { ...DEFAULT_FAST_MODE_POLICY };
		interactiveRegistration?.unregister();
		interactiveRegistration = undefined;
		pi.events.emit(FAST_MODE_POLICY_EVENT, { ...policy });
	});
}
