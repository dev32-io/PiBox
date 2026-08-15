import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { existsSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createVisualCompanionBackend, type VisualCompanionBackend } from "./backend.mjs";
import { createArchitectureViewer } from "../../skills/architecture-visualizer/scripts/server.mjs";
import { registerService, setServiceSnapshot } from "../service-adapter/registry.js";

const SERVICE_ID = "visual-companion";

const parameters = Type.Object({
	action: StringEnum(["start", "stop"] as const, { description: "Start/show a visual companion or stop the session backend." }),
	visualizer: Type.Optional(Type.String({ description: "Visualizer to serve. Currently: architecture." })),
	artifactPath: Type.Optional(Type.String({ description: "Repository-relative JSON artifact path. Required when starting." })),
});

export type VisualCompanionInput = Static<typeof parameters>;

type CompanionState = "starting" | "running" | "error" | "stopped";

function setState(ctx: ExtensionContext, state: CompanionState, port?: number): void {
	setServiceSnapshot(SERVICE_ID, {
		state,
		...(port ? { detail: `localhost:${port}` } : {}),
	}, ctx);
}

function resolveArtifact(cwd: string, input: string): string {
	const candidate = resolve(cwd, input.replace(/^@/, ""));
	if (!existsSync(candidate)) throw new Error(`Visualization artifact not found: ${candidate}`);
	const root = realpathSync(cwd);
	const artifact = realpathSync(candidate);
	const fromRoot = relative(root, artifact);
	if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
		throw new Error("visual_companion only serves artifacts inside the current repository.");
	}
	return artifact;
}

function openUrl(url: string): Promise<boolean> {
	return new Promise((done) => {
		const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
		const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		child.once("spawn", () => {
			child.unref();
			done(true);
		});
		child.once("error", () => done(false));
	});
}

export default function visualCompanion(pi: ExtensionAPI): void {
	let backend: VisualCompanionBackend | undefined;
	let activeViewer: string | undefined;
	let activeArtifact: string | undefined;
	let operationTail: Promise<void> = Promise.resolve();
	let closing = false;

	const serial = async <T>(operation: () => Promise<T>): Promise<T> => {
		const previous = operationTail;
		let release!: () => void;
		operationTail = new Promise<void>((resolve) => { release = resolve; });
		await previous;
		try { return await operation(); }
		finally { release(); }
	};

	const close = async (ctx?: ExtensionContext) => {
		const current = backend;
		backend = undefined;
		activeViewer = undefined;
		activeArtifact = undefined;
		try {
			if (current) await current.close();
		} finally {
			if (ctx) setState(ctx, "stopped");
		}
	};

	const unregisterService = registerService({
		id: SERVICE_ID,
		name: "Visual companion",
		order: 30,
		internal: true,
		stayAlive: false,
		singleton: true,
		perSession: true,
	}, {
		health: async () => backend ? { state: "running", detail: `localhost:${backend.port}` } : { state: "stopped" },
		stop: async ({ ctx }) => serial(async () => { await close(ctx); return { state: "stopped" }; }),
	});

	pi.registerTool({
		name: "visual_companion",
		label: "Visual Companion",
		description: "Start or stop the session's single local visual-companion backend. Start serves a visualizer artifact on a random loopback port, opens it in the browser, and reuses the same backend for later visualizers in this session.",
		promptSnippet: "Start or stop the session-local browser visual companion for generated visualization artifacts",
		promptGuidelines: ["Use visual_companion after a visualization skill writes its JSON artifact; update the artifact directly for live rerendering, and stop the companion when it is no longer needed."],
		parameters,
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			return serial(async () => {
			if (closing) throw new Error("The visual companion session is shutting down.");
			if (input.action === "stop") {
				const wasRunning = !!backend;
				await close(ctx);
				return {
					content: [{ type: "text", text: wasRunning ? "Stopped the visual companion backend." : "Visual companion backend is already stopped." }],
					details: { state: "stopped" },
				};
			}

			if (!input.artifactPath) throw new Error("artifactPath is required when starting the visual companion.");
			const viewerId = input.visualizer ?? "architecture";
			if (viewerId !== "architecture") throw new Error(`Unknown visualizer: ${viewerId}`);
			const artifactPath = resolveArtifact(ctx.cwd, input.artifactPath);
			signal?.throwIfAborted();
			setState(ctx, "starting");
			try {
				const reused = !!backend;
				if (!backend) {
					const created = await createVisualCompanionBackend({ viewers: [createArchitectureViewer()], port: 0 });
					if (closing || signal?.aborted) {
						await created.close();
						throw new Error("The visual companion start was cancelled during session shutdown.");
					}
					backend = created;
				}
				const shown = backend.show({ viewerId, artifactPath });
				activeViewer = viewerId;
				activeArtifact = artifactPath;
				setState(ctx, "running", backend.port);
				const opened = await openUrl(shown.url);
				return {
					content: [{
						type: "text",
						text: `${reused ? "Reused" : "Started"} the visual companion backend at ${shown.url}\nServing ${viewerId}: ${shown.artifactPath}${opened ? "\nOpened the URL in the browser." : "\nCould not open the browser automatically; use the URL above."}${shown.valid ? "" : `\nArtifact diagnostics: ${shown.errors.join("; ")}`}`,
					}],
					details: {
						state: "running",
						reused,
						url: shown.url,
						port: backend.port,
						visualizer: activeViewer,
						artifactPath: activeArtifact,
						valid: shown.valid,
						errors: shown.errors,
						opened,
					},
				};
			} catch (error) {
				setState(ctx, closing ? "stopped" : "error");
				throw error;
			}
			});
		},
	});

	pi.on("session_start", (_event, ctx) => {
		closing = false;
		setState(ctx, "stopped");
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		closing = true;
		await serial(() => close(ctx));
		unregisterService();
	});
}
