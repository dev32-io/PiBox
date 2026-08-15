import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workflows from "../workflow-runtime/index.js";
import { WORKFLOW_ADAPTER_DISCOVERY_EVENT, type WorkflowAdapter } from "../workflow-runtime/api.js";

export interface WorkflowBenchHarness {
	pi: ExtensionAPI;
	tools: Map<string, any>;
	handlers: Map<string, (...args: any[]) => any>;
	messages: Array<{ message: any; options: any }>;
	entries: Array<{ type: "custom"; customType: string; data: any }>;
	ctx: any;
	registerAdapter(adapter: WorkflowAdapter): void;
	startSession(): Promise<void>;
	shutdownSession(): Promise<void>;
}

/** Minimal Pi host used to exercise the real workflow-runtime extension. */
export function createWorkflowBenchHarness(): WorkflowBenchHarness {
	const tools = new Map<string, any>();
	const handlers = new Map<string, (...args: any[]) => any>();
	const bus = new Map<string, Array<(data: unknown) => void>>();
	const messages: WorkflowBenchHarness["messages"] = [];
	const entries: WorkflowBenchHarness["entries"] = [];
	let activeTools: string[] = [];
	const pi = {
		registerTool(definition: any) { tools.set(definition.name, definition); },
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		events: {
			on(name: string, handler: (data: unknown) => void) { const current = bus.get(name) ?? []; current.push(handler); bus.set(name, current); },
			emit(name: string, data: unknown) { for (const handler of bus.get(name) ?? []) handler(data); },
		},
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
		sendMessage(message: unknown, options: unknown) { messages.push({ message, options }); },
		getActiveTools() { return activeTools; },
		setActiveTools(names: string[]) { activeTools = names; },
	} as unknown as ExtensionAPI;
	workflows(pi);
	const ctx: any = {
		hasUI: false,
		ui: {
			theme: { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text },
			setWidget() {},
		},
		sessionManager: { getEntries: () => entries },
	};
	return {
		pi, tools, handlers, messages, entries, ctx,
		registerAdapter(adapter) { pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter)); },
		async startSession() { await handlers.get("session_start")?.({}, ctx); },
		async shutdownSession() { await handlers.get("session_shutdown")?.({}, ctx); },
	};
}
