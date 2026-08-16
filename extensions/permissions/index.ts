import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { evaluateToolCall, loadPermissionPolicy } from "./policy.js";
import { renderPermissionMode } from "./display.js";
import { installPermissionRuntime } from "./runtime.js";
import type { LoadedPermissionPolicy, PermissionMode } from "./types.js";

const WORKFLOW_BYPASS_CANCEL = "No — keep permissions enforced";
const WORKFLOW_BYPASS_CONFIRM = "Yes — switch to BYPASS and start workflow";

const STATUS_KEY = "permission-mode";
const ENTRY_TYPE = "pibox-permission-mode";
const MODE_ENV = "PIBOX_PERMISSION_MODE";

function isMode(value: unknown): value is PermissionMode {
	return value === "enforce" || value === "bypass";
}

function restoredMode(ctx: ExtensionContext): PermissionMode {
	if (ctx.mode !== "tui" && isMode(process.env[MODE_ENV])) return process.env[MODE_ENV];
	const manager = ctx.sessionManager as typeof ctx.sessionManager & { getBranch?: () => Array<{ type?: string; customType?: string; data?: unknown }> };
	const entries = manager.getBranch?.() ?? manager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: string; customType?: string; data?: { mode?: unknown } };
		if (entry.type === "custom" && entry.customType === ENTRY_TYPE && isMode(entry.data?.mode)) return entry.data.mode;
	}
	return "enforce";
}

export default function permissions(pi: ExtensionAPI): void {
	let mode: PermissionMode = "enforce";
	let policy: LoadedPermissionPolicy | undefined;
	let sessionCtx: ExtensionContext | undefined;

	const renderStatus = () => {
		if (sessionCtx?.hasUI) sessionCtx.ui.setStatus(STATUS_KEY, mode);
	};

	const setMode = (next: PermissionMode, source: "shortcut" | "command" | "workflow") => {
		if (mode === next) { renderStatus(); return; }
		mode = next;
		process.env[MODE_ENV] = next;
		pi.appendEntry(ENTRY_TYPE, { mode: next, source, changedAt: new Date().toISOString() });
		renderStatus();
		if (sessionCtx?.hasUI) sessionCtx.ui.notify(next === "bypass" ? "Permission mode: BYPASS — repository tool permissions are not enforced." : "Permission mode: ENFORCED", next === "bypass" ? "warning" : "info");
	};

	const uninstallRuntime = installPermissionRuntime({
		getMode: () => mode,
		setMode,
		async confirmWorkflowStart(ctx, ref) {
			// Bypass already represents an explicit session-owner authorization. This
			// is also how approved headless parent sessions pass authority to children.
			if (mode === "bypass") return true;
			if (ctx.mode !== "tui" || !ctx.hasUI) return false;
			const permissionLine = renderPermissionMode("bypass", ctx.ui.theme);
			const choice = await ctx.ui.select(
				`Start unattended workflow?\n\n${permissionLine}\n\nStarting ${ref} will disable repository tool permission enforcement for this session and every spawned subagent. The workflow will run unattended and its agents can execute tools without allow, ask, or deny policy checks.\n\nPiBox workflow authority, Git isolation, managed reviews, and verification remain active.`,
				[
					WORKFLOW_BYPASS_CANCEL,
					WORKFLOW_BYPASS_CONFIRM,
				],
			);
			return choice === WORKFLOW_BYPASS_CONFIRM;
		},
	});

	pi.registerShortcut("shift+tab", {
		description: "Toggle PiBox permission mode",
		handler: async () => setMode(mode === "enforce" ? "bypass" : "enforce", "shortcut"),
	});

	pi.registerCommand("permissions", {
		description: "Show or change PiBox repository permission mode",
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			if (!requested || requested === "status") {
				ctx.ui.notify(`Permission mode: ${mode.toUpperCase()}${policy ? ` · ${policy.path}` : ""}`, mode === "bypass" ? "warning" : "info");
				return;
			}
			if (requested !== "enforce" && requested !== "bypass") {
				ctx.ui.notify("Usage: /permissions [status|enforce|bypass]", "error");
				return;
			}
			setMode(requested, "command");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		policy = loadPermissionPolicy(ctx.cwd);
		mode = restoredMode(ctx);
		process.env[MODE_ENV] = mode;
		renderStatus();
		if (policy.issues.length > 0 && ctx.hasUI) ctx.ui.notify(`Permission policy is invalid and has failed closed: ${policy.issues.join("; ")}`, "error");
	});

	pi.on("tool_call", async (event, ctx) => {
		if (mode === "bypass") return;
		const activePolicy = policy ?? loadPermissionPolicy(ctx.cwd);
		const evaluation = evaluateToolCall(activePolicy, event.toolName, (event.input ?? {}) as Record<string, unknown>, ctx.cwd);
		if (evaluation.decision === "allow") return;
		const rule = evaluation.matchedRule ? ` Rule: ${evaluation.matchedRule}.` : "";
		if (evaluation.decision === "deny") return { block: true, reason: `Permission denied: ${evaluation.summary}.${rule}` };
		if (ctx.mode === "tui" && ctx.hasUI) {
			const approved = await ctx.ui.confirm("Permission required", `${evaluation.summary}${rule}`);
			if (approved) return;
		}
		return { block: true, reason: `Permission required but not granted: ${evaluation.summary}.${rule}` };
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		sessionCtx = undefined;
		policy = undefined;
		uninstallRuntime();
	});
}
