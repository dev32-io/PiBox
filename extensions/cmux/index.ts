import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isSubagentRuntime } from "../core/runtime-role.js";
import type { LogicalAgentSnapshot, SubagentEvent } from "../subagent/api.js";
import type { SubagentDisplayEvent } from "../subagent/display.js";
import { getSubagentProcessInstanceId } from "../subagent/process-instance.js";
import { resolveSubagentServiceForConsumer, type SubagentCapability } from "../subagent/registry.js";
import { CmuxCli, CmuxPaneAdapter, SocketViewerTransport, type CmuxClient, type ViewerTransport } from "./cmux.js";
import { CMUX_PANES_ENTRY_TYPE, DEFAULT_CMUX_PANES_ENABLED, loadCmuxPanesDefault, restoreCmuxPanesEnabled } from "./config.js";

export interface CmuxDependencies {
	env?: NodeJS.ProcessEnv;
	loadDefault?: (cwd: string) => boolean;
	resolveSubagents?: (sessionId: string) => SubagentCapability | undefined;
	createClient?: () => CmuxClient;
	createViewers?: () => Promise<ViewerTransport>;
}

/** Optional main-session live view. It observes only; child ownership stays with SubagentService. */
export default function cmuxExtension(pi: ExtensionAPI, dependencies: CmuxDependencies = {}): void {
	const env = dependencies.env ?? process.env;
	if (isSubagentRuntime(env)) return;
	const available = Boolean(env.CMUX_WORKSPACE_ID && env.CMUX_SURFACE_ID);
	const loadDefault = dependencies.loadDefault ?? loadCmuxPanesDefault;
	const resolveSubagents = dependencies.resolveSubagents ?? ((sessionId) => resolveSubagentServiceForConsumer({ sessionId, processInstanceId: getSubagentProcessInstanceId() }));
	let ctx: ExtensionContext | undefined;
	let runtime: { adapter: CmuxPaneAdapter; unsubscribe: () => void } | undefined;
	let generation = 0;
	let defaultEnabled = DEFAULT_CMUX_PANES_ENABLED;
	let enabled = defaultEnabled;

	const stop = async () => {
		generation++;
		const current = runtime;
		runtime = undefined;
		current?.unsubscribe();
		await current?.adapter.shutdown().catch(() => undefined);
	};

	const start = async () => {
		if (!ctx || !enabled || !available || runtime) return;
		const startGeneration = ++generation;
		let viewers: ViewerTransport | undefined;
		let adapter: CmuxPaneAdapter | undefined;
		const unsubscribers: Array<() => void> = [];
		try {
			const capability = resolveSubagents(ctx.sessionManager.getSessionId());
			if (!capability) return;
			const client = dependencies.createClient?.() ?? new CmuxCli();
			const panes = await client.listPanes();
			if (startGeneration !== generation || !enabled || !panes.some((pane) => pane.surfaceIds.includes(env.CMUX_SURFACE_ID!))) return;
			const subscribeDisplay = capability.service.subscribeDisplay;
			viewers = await (dependencies.createViewers?.() ?? SocketViewerTransport.create());
			if (startGeneration !== generation || !enabled) return void await viewers.shutdown().catch(() => undefined);
			adapter = new CmuxPaneAdapter({ mainSurfaceId: env.CMUX_SURFACE_ID!, client, viewers, limited: !subscribeDisplay });
			if (subscribeDisplay) {
				const display = subscribeDisplay.call(capability.service, capability.owner, (event: SubagentDisplayEvent) => {
					try { adapter!.handleDisplay(event); } catch { /* display observation is best effort. */ }
				});
				unsubscribers.push(() => display.unsubscribe());
			}

			const snapshots = new Map<string, LogicalAgentSnapshot>();
			const remember = (snapshot: LogicalAgentSnapshot) => {
				if (snapshot.attemptId) snapshots.set(`${snapshot.handle.agentId}\0${snapshot.attemptId}`, snapshot);
			};
			const cursor = capability.service.replay(capability.owner).snapshot.cursor;
			const handle = (event: SubagentEvent) => {
				try {
					const key = `${event.agentId}\0${event.attemptId}`;
					let snapshot = snapshots.get(key);
					if (event.type === "attempt_started" && !snapshot) {
						snapshot = capability.service.inspect(capability.owner).find((agent) => agent.handle.agentId === event.agentId && agent.attemptId === event.attemptId);
						if (snapshot) remember(snapshot);
					}
					adapter!.handle(event, snapshot);
				} catch { /* cmux observation never affects agent execution. */ }
			};
			const subscription = capability.service.subscribe(capability.owner, cursor, handle);
			unsubscribers.push(() => subscription.unsubscribe());
			for (const snapshot of subscription.initial.snapshot.agents) remember(snapshot);
			adapter.seed(subscription.initial.snapshot.agents);
			for (const event of subscription.initial.events) handle(event);
			if (startGeneration !== generation || !enabled) throw new Error("cmux panes disabled during startup");
			runtime = { adapter, unsubscribe: () => { for (const unsubscribe of unsubscribers.splice(0)) unsubscribe(); } };
		} catch {
			for (const unsubscribe of unsubscribers.splice(0)) { try { unsubscribe(); } catch { /* best effort */ } }
			if (adapter) await adapter.shutdown().catch(() => undefined);
			else await viewers?.shutdown().catch(() => undefined);
		}
	};

	pi.registerCommand("cmux-panes", {
		description: "Enable, disable, or inspect session cmux subagent panes",
		getArgumentCompletions: (prefix) => ["on", "off", "status"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, commandCtx) => {
			const argument = args.trim().toLowerCase();
			const action = argument || (enabled ? "off" : "on");
			if (!["on", "off", "status"].includes(action)) {
				commandCtx.ui.notify("Usage: /cmux-panes [on|off|status]", "warning");
				return;
			}
			if (action !== "status") {
				enabled = action === "on";
				pi.appendEntry(CMUX_PANES_ENTRY_TYPE, { schemaVersion: 1, enabled });
				if (enabled) await start(); else await stop();
			}
			const detail = !available ? "unavailable outside cmux" : enabled && runtime ? "active" : enabled ? "idle" : "disabled";
			commandCtx.ui.notify(`cmux panes: ${enabled ? "on" : "off"} — ${detail}.`, "info");
		},
	});

	pi.on("session_start", async (_event, sessionCtx) => {
		await stop();
		ctx = sessionCtx;
		defaultEnabled = loadDefault(ctx.cwd);
		enabled = restoreCmuxPanesEnabled(ctx, defaultEnabled);
		await start();
	});
	pi.on("session_tree", async (_event, sessionCtx) => {
		ctx = sessionCtx;
		enabled = restoreCmuxPanesEnabled(ctx, defaultEnabled);
		if (enabled) await start(); else await stop();
	});
	pi.on("session_shutdown", async () => { await stop(); ctx = undefined; });
}
