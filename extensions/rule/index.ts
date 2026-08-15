import { existsSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { discoverRules, renderRules, rulesForRead, unconditionalRules, type RuleDiscovery, type RuleDefinition } from "./rules.js";

const ENTRY_TYPE = "pibox-rules-loaded";

type LoadedRulesEntry = {
	ids: string[];
	labels: string[];
	target: string;
	at: string;
};

function textResultBlock(text: string) {
	return { type: "text" as const, text };
}

function displayPath(path: string, projectRoot: string): string {
	const value = relative(projectRoot, path).replaceAll(sep, "/");
	return value && !value.startsWith("../") ? value : path;
}

function canonical(path: string): string {
	try { return existsSync(path) ? realpathSync(path) : path; }
	catch { return path; }
}

export default function rulesExtension(pi: ExtensionAPI): void {
	let discovery: RuleDiscovery | undefined;
	const loaded = new Set<string>();
	const reserved = new Set<string>();
	const pending = new Map<string, { target: string; rules: RuleDefinition[]; directIds: Set<string> }>();

	const restoreLoaded = (ctx: any) => {
		loaded.clear();
		const entries = ctx.sessionManager.buildContextEntries?.() ?? ctx.sessionManager.getBranch?.() ?? [];
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			for (const id of (entry.data as LoadedRulesEntry | undefined)?.ids ?? []) loaded.add(id);
		}
	};

	pi.registerEntryRenderer<LoadedRulesEntry>(ENTRY_TYPE, (entry, _options, theme) => {
		const labels = entry.data?.labels ?? [];
		if (labels.length === 0) return undefined;
		const noun = labels.length === 1 ? "rule" : `${labels.length} rules`;
		const names = labels.length <= 2 ? labels.join(", ") : `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
		return new Text(`${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold(`Loaded ${noun}`))} ${theme.fg("dim", names)}`, 0, 0);
	});

	pi.on("session_start", (_event, ctx) => {
		discovery = discoverRules(ctx.cwd);
		restoreLoaded(ctx);
		if (ctx.hasUI && discovery.diagnostics.length > 0) {
			ctx.ui.notify(`Skipped ${discovery.diagnostics.length} invalid rule file(s).`, "warning");
		}
	});

	pi.on("before_agent_start", (event) => {
		if (!discovery) return;
		const rules = unconditionalRules(discovery);
		if (rules.length === 0) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${renderRules(rules, "Project Rules")}` };
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "read" || !discovery) return;
		const input = event.input as { path?: unknown };
		if (typeof input.path !== "string" || !input.path.trim()) return;
		const unavailable = new Set([...loaded, ...reserved]);
		const target = resolve(ctx.cwd, input.path);
		const canonicalTarget = canonical(target);
		const directRule = discovery.rules.find((rule) => rule.path === canonicalTarget && rule.paths.length > 0 && !unavailable.has(rule.id));
		const rules = [
			...(directRule ? [directRule] : []),
			...rulesForRead(discovery, input.path, ctx.cwd, unavailable).filter((rule) => rule.id !== directRule?.id),
		];
		if (rules.length === 0) return;
		const directIds = new Set(rules.filter((rule) => rule.path === canonicalTarget).map((rule) => rule.id));
		for (const rule of rules) reserved.add(rule.id);
		pending.set(event.toolCallId, { target, rules, directIds });
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "read" || !discovery) return;
		const activation = pending.get(event.toolCallId);
		if (!activation) return;
		pending.delete(event.toolCallId);
		for (const rule of activation.rules) reserved.delete(rule.id);
		if (event.isError) return;
		for (const rule of activation.rules) loaded.add(rule.id);
		const injected = activation.rules.filter((rule) => !activation.directIds.has(rule.id));
		const labels = injected.map((rule) => rule.label);
		pi.appendEntry(ENTRY_TYPE, {
			ids: activation.rules.map((rule) => rule.id),
			labels,
			target: displayPath(activation.target, discovery.projectRoot),
			at: new Date().toISOString(),
		} satisfies LoadedRulesEntry);
		if (injected.length === 0) return;
		const block = renderRules(injected, `Rules loaded for ${displayPath(activation.target, discovery.projectRoot)}`);
		const details = typeof event.details === "object" && event.details !== null && !Array.isArray(event.details)
			? { ...event.details, piboxRules: { ids: injected.map((rule) => rule.id), target: activation.target } }
			: { piboxRules: { ids: injected.map((rule) => rule.id), target: activation.target } };
		return { content: [...event.content, textResultBlock(block)], details };
	});

	pi.on("session_compact", (_event, ctx) => restoreLoaded(ctx));
	pi.on("session_tree", (_event, ctx) => restoreLoaded(ctx));

	pi.on("session_shutdown", () => {
		discovery = undefined;
		loaded.clear();
		reserved.clear();
		pending.clear();
	});
}
