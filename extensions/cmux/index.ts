import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSubagentRuntime } from "../core/runtime-role.js";
import type { LogicalAgentSnapshot } from "../subagent/api.js";
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

	const stop = async () => {
		const current = runtime;
		runtime = undefined;
		current?.unsubscribe();
		await current?.adapter.shutdown().catch(() => undefined);
	};

	pi.on("session_start", async (_event, ctx) => {
		await stop();
		let viewers: ViewerTransport | undefined;
		let adapter: CmuxPaneAdapter | undefined;
		let unsubscribe: (() => void) | undefined;
		try {
			const capability = resolveSubagents(ctx.sessionManager.getSessionId());
			if (!capability) return;
			viewers = await (dependencies.createViewers?.() ?? SocketViewerTransport.create());
			adapter = new CmuxPaneAdapter({ mainSurfaceId: env.CMUX_SURFACE_ID!, client: dependencies.createClient?.() ?? new CmuxCli(), viewers });
			const snapshots = new Map<string, LogicalAgentSnapshot>();
			const handle = (event: Parameters<CmuxPaneAdapter["handle"]>[0]) => {
				try {
					const snapshot = capability.service.inspect(capability.owner).find((agent) => agent.handle.agentId === event.agentId && agent.attemptId === event.attemptId);
					if (snapshot) snapshots.set(event.agentId, snapshot);
					adapter!.handle(event, snapshot ?? snapshots.get(event.agentId));
				} catch { /* cmux observation never affects agent execution. */ }
			};
			const cursor = capability.service.replay(capability.owner).snapshot.cursor;
			const subscription = capability.service.subscribe(capability.owner, cursor, handle);
			unsubscribe = () => subscription.unsubscribe();
			adapter.seed(subscription.initial.snapshot.agents);
			for (const event of subscription.initial.events) handle(event);
			runtime = { adapter, unsubscribe };
		} catch {
			unsubscribe?.();
			if (adapter) await adapter.shutdown().catch(() => undefined);
			else await viewers?.shutdown().catch(() => undefined);
		}
	});

	pi.on("session_shutdown", stop);
}
