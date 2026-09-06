import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isSubagentRuntime } from "../core/runtime-role.js";
import type { LogicalAgentSnapshot, SubagentService } from "../subagent/api.js";
import { getSubagentProcessInstanceId } from "../subagent/process-instance.js";
import { resolveSubagentServiceForConsumer, type SubagentCapability } from "../subagent/registry.js";
import { DEFAULT_KEEP_AWAKE_ENABLED, KEEP_AWAKE_ENTRY_TYPE, loadKeepAwakeDefault, restoreKeepAwakeEnabled } from "./config.js";
import { KeepAwakeController } from "./controller.js";

export interface KeepAwakeDependencies {
	env?: NodeJS.ProcessEnv;
	loadDefault?: (cwd: string) => boolean;
	resolveSubagents?: (sessionId: string) => SubagentCapability | undefined;
	createController?: (onFailure: (message: string) => void) => Pick<KeepAwakeController, "setActive" | "retry" | "close" | "status">;
}

/** Standalone, main-session-only power policy. No prompts, tools, or footer state. */
export default function keepAwake(pi: ExtensionAPI, dependencies: KeepAwakeDependencies = {}): void {
	if (isSubagentRuntime(dependencies.env ?? process.env)) return;
	const loadDefault = dependencies.loadDefault ?? loadKeepAwakeDefault;
	const resolveSubagents = dependencies.resolveSubagents ?? ((sessionId) => resolveSubagentServiceForConsumer({ sessionId, processInstanceId: getSubagentProcessInstanceId() }));
	let ctx: ExtensionContext | undefined;
	let controller: ReturnType<NonNullable<KeepAwakeDependencies["createController"]>> | undefined;
	let defaultEnabled = DEFAULT_KEEP_AWAKE_ENABLED;
	let enabled = defaultEnabled;
	let mainActive = false;
	let childrenActive = false;
	let warned = false;
	let service: SubagentService | undefined;
	let unsubscribe: (() => void) | undefined;

	const warn = (message: string) => {
		if (warned || !ctx) return;
		warned = true;
		try {
			const text = `Keep awake unavailable: ${message}. Agent execution is unaffected.`;
			if (ctx.hasUI) ctx.ui.notify(text, "warning");
			else console.error(text);
		} catch { /* Optional power management must not affect agent execution. */ }
	};
	const reconcile = () => { controller?.setActive(enabled && (mainActive || childrenActive)); };
	const updateChildren = (agents: readonly LogicalAgentSnapshot[]) => {
		childrenActive = agents.some((agent) => agent.state === "launching" || agent.state === "running" || agent.state === "stopping");
		reconcile();
	};
	const detach = () => {
		unsubscribe?.();
		unsubscribe = undefined;
		service = undefined;
		childrenActive = false;
	};
	const attachSubagents = () => {
		if (!ctx) return;
		try {
			const capability = resolveSubagents(ctx.sessionManager.getSessionId());
			if (capability?.service === service) return;
			detach();
			if (capability) {
				const { owner, service: current } = capability;
				service = current;
				const subscription = current.subscribe(owner, current.replay(owner).snapshot.cursor, () => {
					if (service !== current) return;
					try { updateChildren(current.inspect(owner)); }
					catch (error) { warn(String(error)); }
				});
				unsubscribe = () => subscription.unsubscribe();
				updateChildren(subscription.initial.snapshot.agents);
			} else reconcile();
		} catch (error) { detach(); reconcile(); warn(String(error)); }
	};
	const stop = async () => {
		detach();
		mainActive = false;
		const previous = controller;
		controller = undefined;
		await previous?.close();
	};

	pi.registerCommand("keep-awake", {
		description: "Enable, disable, or inspect session keep-awake while agents work (macOS)",
		getArgumentCompletions: (prefix) => ["on", "off", "status"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, commandCtx) => {
			const action = args.trim().toLowerCase() || "status";
			if (!["on", "off", "status"].includes(action)) {
				commandCtx.ui.notify("Usage: /keep-awake [on|off|status]", "warning");
				return;
			}
			if (action !== "status") {
				enabled = action === "on";
				pi.appendEntry(KEEP_AWAKE_ENTRY_TYPE, { schemaVersion: 1, enabled });
				// Reconcile first so retry never revives a now-disabled or idle demand.
				reconcile();
				if (enabled) controller?.retry();
			}
			const status = controller?.status ?? "idle";
			const detail = status === "unsupported" ? "unsupported on this platform (no-op)"
				: !enabled ? "disabled" : status === "failed" ? "unavailable; /keep-awake on retries" : status;
			commandCtx.ui.notify(`Keep awake: ${enabled ? "on" : "off"} — ${detail}.`, "info");
		},
	});

	pi.on("session_start", async (_event, sessionCtx) => {
		await stop();
		ctx = sessionCtx;
		warned = false;
		defaultEnabled = loadDefault(ctx.cwd);
		enabled = restoreKeepAwakeEnabled(ctx, defaultEnabled);
		controller = dependencies.createController?.(warn) ?? new KeepAwakeController({ onFailure: warn });
		// The manifest loads this extension after SubagentService's startup binding.
		// Its atomic initial snapshot includes children surviving a same-process reload.
		attachSubagents();
	});
	pi.on("session_tree", (_event, sessionCtx) => {
		ctx = sessionCtx;
		enabled = restoreKeepAwakeEnabled(ctx, defaultEnabled);
		attachSubagents();
		reconcile();
	});
	pi.on("agent_start", () => { mainActive = true; attachSubagents(); reconcile(); });
	// agent_end is intentionally not used: retries/compaction/follow-ups may remain.
	pi.on("agent_settled", () => { mainActive = false; reconcile(); });
	pi.on("session_shutdown", async () => { await stop(); ctx = undefined; });
}
