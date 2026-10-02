import { fileURLToPath } from "node:url";
import { createCodemodeExtension, createMcpExtension, createToolSearchExtension, type BeforeAgentStartEvent, type BeforeAgentStartEventResult, type ExtensionAPI, type ExtensionContext, type ExtensionHandler, type ToolCallEvent, type ToolCallEventResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isMcpTool } from "./mcp-capabilities.js";

export interface McpIdentity { server: string; tool: string }
const KEY = Symbol.for("pibox.native-mcp.identities");
type Host = typeof globalThis & { [KEY]?: { identities: Map<string, McpIdentity>; ready(signal?: AbortSignal): Promise<void> } };
type DiscoveryHandler = ExtensionHandler<ToolCallEvent, ToolCallEventResult>;

export function nativeMcpIdentity(name: string): McpIdentity | undefined {
	return (globalThis as Host)[KEY]?.identities.get(name);
}

export function nativeMcpExtensionPaths(): string[] {
	return (globalThis as Host)[KEY] ? [fileURLToPath(import.meta.url)] : [];
}

/** No-op for non-native integrations; native snapshots must await the audited discovery barrier. */
export async function awaitNativeMcpReady(signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	await (globalThis as Host)[KEY]?.ready(signal);
	signal?.throwIfAborted();
}

/** Optional manifest entry after adapter removal. Owns no configuration or transport. */
export default async function nativeMcp(pi: ExtensionAPI): Promise<void> {
	const identities = new Map<string, McpIdentity>();
	const indirect = new Set<string>();
	const withdraw = new Map<string, () => void>();
	let context: ExtensionContext | undefined;
	let discovery: DiscoveryHandler | undefined;
	let initial = true;
	let failure: Error | undefined;
	// Lifecycle throws are only diagnostics: Pi catches them and may still prompt.
	// Withdraw native capabilities and fence dispatch, including late registrations.
	// Failure stays latched until a fresh extension reload; ordinary tools are unaffected.
	const disable = (error: unknown): Error => {
		if (failure) return failure;
		failure = new Error(`Native MCP disabled until reload: ${error instanceof Error ? error.message : String(error)}`);
		identities.clear();
		for (const hide of withdraw.values()) hide();
		return failure;
	};
	const schemas = new Map<string, ToolDefinition["parameters"]>();
	const state = { identities, async ready(signal?: AbortSignal): Promise<void> {
		if (failure) throw failure;
		// This is NOT a documented readiness API. Audited 0.99.2 tool_call waits for
		// all pending servers on ALL_TOOLS/tool_search, honoring ctx.signal. No tool
		// executes here. Re-audit on upgrade; never silently snapshot before discovery.
		if (!discovery || !context) throw new Error("Native MCP readiness requires native discovery and an active session");
		const tool = pi.getAllTools().find((tool) => schemas.has(tool.name) && tool.parameters === schemas.get(tool.name));
		if (!tool) throw disable(new Error("Native MCP readiness requires native codemode or tool_search"));
		const current = context;
		try {
			const result = await discovery({ type: "tool_call", toolCallId: "pibox-mcp-readiness", toolName: tool.name, input: { code: "ALL_TOOLS", query: "" } }, { ...current, signal });
			signal?.throwIfAborted();
			if (result?.block) throw new Error(result.reason ?? "Native MCP discovery blocked");
		} catch (error) {
			// A cancelled parent snapshot must not poison concurrent launches or a new session.
			if (!signal?.aborted && (globalThis as Host)[KEY] === state && context === current) throw disable(error);
			throw error;
		}
		if ((globalThis as Host)[KEY] !== state || context !== current) throw new Error("Native MCP session changed during discovery");
		if (failure) throw failure;
	} };
	(globalThis as Host)[KEY] = state;
	pi.on("tool_call", (event) => {
		if (failure && isMcpTool({ name: event.toolName })) return { block: true, reason: failure.message };
	});
	// Fence waiters before native shutdown closes connections (including on reload).
	pi.on("session_shutdown", () => {
		context = undefined;
		if ((globalThis as Host)[KEY] === state) delete (globalThis as Host)[KEY];
	});
	// Pi 0.99.2 recognizes its discovery tools by schema reference, not name. Obtain
	// those references through exported factories without registering or executing tools.
	const capture: ExtensionAPI = { ...pi, registerTool: (tool) => { schemas.set(tool.name, tool.parameters); } };
	await createCodemodeExtension()(capture);
	await createToolSearchExtension()(capture);
	await createMcpExtension()({
		...pi,
		on(event, handler) {
			if (event === "tool_call") {
				if (discovery) throw new Error("Unexpected native MCP discovery handlers; re-audit integration");
				discovery = handler as DiscoveryHandler;
			}
			if (event === "before_agent_start") {
				const before = handler as ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;
				return pi.on(event, async (event, ctx) => {
					try {
						if (process.env.PIBOX_MCP_ENABLED !== "0") await state.ready(ctx.signal);
						const result = await before(event, ctx);
						if (failure) throw failure;
						// --tools also activates exact names. Restore native exposure only
						// after verified readiness, without changing its hard capability bound.
						if (initial && process.env.PIBOX_MCP_ENABLED !== "0") {
							if (process.env.PIBOX_MCP_ENABLED !== undefined && process.env.PIBOX_SUBAGENT_ALL_TOOLS !== "1") {
								pi.setActiveTools(pi.getActiveTools().filter((name) => !indirect.has(name)));
							}
							initial = false;
						}
						return result;
					} catch (error) {
						throw disable(error);
					} finally {
						// Remove before Pi records the initial prompt or any historical delta.
						if (failure || process.env.PIBOX_MCP_ENABLED === "0") delete event.systemPromptOptions.sections.mcp_servers;
					}
				});
			}
			// Forward overloaded public registrations unchanged.
			return pi.on(event as "tool_call", handler as DiscoveryHandler);
		},
		registerTool(definition) {
			withdraw.set(definition.name, () => pi.registerTool({ ...definition, exposure: "hidden" }));
			identities.delete(definition.name);
			if (failure) { withdraw.get(definition.name)!(); return; }
			if (definition.exposure && definition.exposure !== "direct" && definition.exposure !== "model-only") indirect.add(definition.name);
			else indirect.delete(definition.name);
			// Audited native labels retain raw server/tool names, including slash tools.
			// Namespace is normalized separately; never reverse a sanitized/hash name.
			const slash = definition.label.indexOf("/");
			const server = definition.label.slice(0, slash);
			if (slash > 0 && /^[A-Za-z0-9_-]+$/.test(server)
				&& definition.namespace?.name === `mcp__${server.replaceAll("-", "_")}` && definition.label.length > slash + 1) {
				identities.set(definition.name, { server, tool: definition.label.slice(slash + 1) });
			}
			pi.registerTool(definition);
		},
	});
	pi.on("session_start", (_event, ctx) => { context = ctx; });
}
