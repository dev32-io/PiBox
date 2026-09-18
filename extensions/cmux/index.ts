import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSubagentRuntime } from "../core/runtime-role.js";
import type { LogicalAgentSnapshot, SubagentEvent } from "../subagent/api.js";
import type { SubagentDisplayEvent } from "../subagent/display.js";
import { getSubagentProcessInstanceId } from "../subagent/process-instance.js";
import { resolveSubagentServiceForConsumer, type SubagentCapability } from "../subagent/registry.js";
import { CmuxCli, CmuxPaneAdapter, SocketViewerTransport, type CmuxClient, type ViewerTransport } from "./cmux.js";

export interface CmuxDependencies {
	env?: NodeJS.ProcessEnv;
	resolveSubagents?: (sessionId: string) => SubagentCapability | undefined;
	createClient?: () => CmuxClient;
	createViewers?: () => Promise<ViewerTransport>;
}

/** Optional main-session live view. It observes only; child ownership stays with SubagentService. */
export default function cmuxExtension(pi: ExtensionAPI, dependencies: CmuxDependencies = {}): void {
	const env = dependencies.env ?? process.env;
	if (isSubagentRuntime(env) || env.PIBOX_CMUX_PANES === "0" || !env.CMUX_WORKSPACE_ID || !env.CMUX_SURFACE_ID) return;
	const resolveSubagents = dependencies.resolveSubagents ?? ((sessionId) => resolveSubagentServiceForConsumer({ sessionId, processInstanceId: getSubagentProcessInstanceId() }));
	let runtime: { adapter: CmuxPaneAdapter; unsubscribe: () => void } | undefined;
	let generation = 0;

	const stop = async () => {
		generation++;
		const current = runtime;
		runtime = undefined;
		current?.unsubscribe();
		await current?.adapter.shutdown().catch(() => undefined);
	};

	pi.on("session_start", async (_event, ctx) => {
		await stop();
		const startGeneration = generation;
		let viewers: ViewerTransport | undefined;
		let adapter: CmuxPaneAdapter | undefined;
		const unsubscribers: Array<() => void> = [];
		try {
			const capability = resolveSubagents(ctx.sessionManager.getSessionId());
			if (!capability) return;
			const client = dependencies.createClient?.() ?? new CmuxCli();
			const panes = await client.listPanes();
			if (startGeneration !== generation || !panes.some((pane) => pane.surfaceIds.includes(env.CMUX_SURFACE_ID!))) return;
			const subscribeDisplay = capability.service.subscribeDisplay;
			viewers = await (dependencies.createViewers?.() ?? SocketViewerTransport.create());
			if (startGeneration !== generation) return void await viewers.shutdown().catch(() => undefined);
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
			runtime = { adapter, unsubscribe: () => { for (const unsubscribe of unsubscribers.splice(0)) unsubscribe(); } };
		} catch {
			for (const unsubscribe of unsubscribers.splice(0)) { try { unsubscribe(); } catch { /* best effort */ } }
			if (adapter) await adapter.shutdown().catch(() => undefined);
			else await viewers?.shutdown().catch(() => undefined);
		}
	});

	pi.on("session_shutdown", stop);
}
