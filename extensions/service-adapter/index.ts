import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createComposeServiceController } from "./compose.js";
import { getService, listServiceDetails, listServices, operateService, publishService, registerService, serviceStatusKey } from "./registry.js";
import type { ServiceController, ServiceDescriptor, ServiceSnapshot } from "./types.js";

const parameters = Type.Object({
	action: StringEnum(["status", "start", "stop", "update"] as const),
	service: Type.Optional(Type.String({ description: "Service id. Omit for status of every service." })),
});

function unavailableController(name: string, healthUrl: string, reason: string): ServiceController {
	return {
		async health() {
			try {
				const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3_000) });
				return response.ok ? { state: "running", detail: new URL(healthUrl).host } : { state: "unhealthy", detail: `HTTP ${response.status}` };
			} catch { return { state: "stopped" }; }
		},
		async start() { throw new Error(`${name} is not configured: ${reason}`); },
		async stop() { throw new Error(`${name} is not configured: ${reason}`); },
		async update() { throw new Error(`${name} is not configured: ${reason}`); },
	};
}

function composeController(pi: ExtensionAPI, descriptor: ServiceDescriptor, composeDirectory: string, healthUrl: string, prepare?: () => Promise<void>, updateStrategy: "pull" | "build" = "pull"): ServiceController {
	const composeFile = join(composeDirectory, "compose.yaml");
	if (!existsSync(composeFile)) return unavailableController(descriptor.name, healthUrl, `missing ${composeFile}`);
	return createComposeServiceController(pi, {
		id: descriptor.id,
		composeFile,
		projectDirectory: composeDirectory,
		healthUrl,
		lockRoot: join(homedir(), ".pi", "pibox", "locks"),
		...(prepare ? { prepare } : {}),
		updateStrategy,
	});
}

function healthEndpoint(baseUrl: string, path: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	return normalized.endsWith(path) ? normalized : `${normalized}${path}`;
}

function describe(snapshot: ServiceSnapshot): string {
	return [snapshot.state, snapshot.detail, snapshot.error].filter(Boolean).join(" · ");
}

function summarizeServices(): string {
	return listServices().map(({ descriptor, snapshot }) => `${descriptor.id}: ${describe(snapshot)} [internal=${descriptor.internal}, stayAlive=${descriptor.stayAlive}, singleton=${descriptor.singleton}, perSession=${descriptor.perSession}]`).join("\n");
}

export default function serviceAdapter(pi: ExtensionAPI): void {
	const bundledServicesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../services");
	const dataRoot = join(homedir(), ".pi", "pibox", "services");
	const prepareMem0 = async () => {
		const serviceDirectory = join(dataRoot, "mem0");
		await Promise.all([mkdir(join(serviceDirectory, "history"), { recursive: true, mode: 0o700 }), mkdir(join(serviceDirectory, "postgres"), { recursive: true, mode: 0o700 })]);
		const apiKeyPath = join(serviceDirectory, "api-key");
		if (!existsSync(apiKeyPath)) await writeFile(apiKeyPath, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
	};
	const prepareSearxng = async () => {
		const configDirectory = join(dataRoot, "searxng", "config");
		await Promise.all([mkdir(configDirectory, { recursive: true, mode: 0o700 }), mkdir(join(dataRoot, "searxng", "cache"), { recursive: true, mode: 0o700 })]);
		const settingsPath = join(configDirectory, "settings.yml");
		if (!existsSync(settingsPath)) {
			const template = await readFile(join(bundledServicesDirectory, "searxng", "settings.template.yml"), "utf8");
			await writeFile(settingsPath, template.replace("__PIBOX_SEARXNG_SECRET__", randomBytes(32).toString("hex")), { mode: 0o600 });
		}
	};
	const mem0: ServiceDescriptor = { id: "mem0", name: "Mem0", order: 10, internal: true, stayAlive: true, singleton: true, perSession: false };
	const searxng: ServiceDescriptor = { id: "searxng", name: "SearXNG", order: 20, internal: true, stayAlive: true, singleton: true, perSession: false };
	const unregister = [
		registerService(mem0, composeController(pi, mem0, resolve(process.env.PIBOX_MEM0_SERVICE_DIR ?? join(bundledServicesDirectory, "mem0")), healthEndpoint(process.env.PIBOX_MEM0_URL ?? "http://127.0.0.1:6001", "/health"), prepareMem0, "build")),
		registerService(searxng, composeController(pi, searxng, resolve(process.env.PIBOX_SEARXNG_SERVICE_DIR ?? join(bundledServicesDirectory, "searxng")), process.env.PIBOX_SEARXNG_URL ?? "http://127.0.0.1:6000/", prepareSearxng)),
	];

	const run = async (action: "start" | "stop" | "health" | "update", id: string, ctx: ExtensionContext, signal?: AbortSignal) => {
		if (action === "update") {
			if (!ctx.hasUI || ctx.mode !== "tui" || !await ctx.ui.confirm(`Update ${getService(id)?.descriptor.name ?? id}?`, "This will pull a new image and recreate the shared service after a health check. Continue?")) {
				throw new Error("Service update was not approved.");
			}
		}
		return operateService(id, action, { ctx, ...(signal ? { signal } : {}) });
	};

	pi.registerTool({
		name: "service_adapter",
		label: "Service Adapter",
		description: "Inspect or control PiBox-managed local services. Updates always require explicit interactive approval.",
		promptSnippet: "Inspect, start, or stop PiBox-managed local services",
		promptGuidelines: ["Start shared services lazily when a dependent operation needs them. Never update a service without the user's explicit approval."],
		parameters,
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			if (input.action === "status" && !input.service) {
				await Promise.allSettled(listServices().map(({ descriptor }) => run("health", descriptor.id, ctx, signal)));
				return { content: [{ type: "text", text: summarizeServices() || "No services are registered." }], details: { services: listServiceDetails() } };
			}
			if (!input.service) throw new Error("service is required for this action.");
			const snapshot = await run(input.action === "status" ? "health" : input.action, input.service, ctx, signal);
			return { content: [{ type: "text", text: `${input.service}: ${describe(snapshot)}` }], details: { service: input.service, ...snapshot } };
		},
	});

	pi.registerCommand("services", {
		description: "Show or control local services: [status|start|stop|update] [service]",
		handler: async (args, ctx) => {
			const [requested = "status", id] = args.trim().split(/\s+/);
			const action = requested === "status" ? "health" : requested;
			if (!id && action === "health") {
				await Promise.allSettled(listServices().map(({ descriptor }) => run("health", descriptor.id, ctx)));
				ctx.ui.notify(summarizeServices() || "No services are registered.", "info");
				return;
			}
			if (!id || !["start", "stop", "update", "health"].includes(action)) {
				ctx.ui.notify("Usage: /services [status|start|stop|update] [service]", "error");
				return;
			}
			try {
				const snapshot = await run(action as "start" | "stop" | "health" | "update", id, ctx);
				ctx.ui.notify(`${id}: ${describe(snapshot)}`, snapshot.state === "running" || snapshot.state === "stopped" ? "info" : "warning");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		for (const service of listServices()) publishService(ctx, service);
		for (const service of listServices().filter(({ descriptor }) => !descriptor.perSession)) void run("health", service.descriptor.id, ctx).catch(() => {});
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) for (const service of listServices()) ctx.ui.setStatus(serviceStatusKey(service.descriptor), undefined);
		for (const remove of unregister) remove();
	});
}
