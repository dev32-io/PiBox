import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { existsSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createArchitectureViewer } from "../../skills/architecture-visualizer/scripts/server.mjs";
import { registerService, setServiceSnapshot } from "../service-adapter/registry.js";
import { createVisualCompanionPlatform } from "./platform.js";
import { createStoryBoardViewer } from "./story-board/index.js";

const SERVICE_ID = "visual-companion";

const parameters = Type.Object({
	action: StringEnum(["start", "stop"] as const, { description: "Open Architecture or stop the session backend." }),
	visualizer: Type.Optional(Type.String({ description: "Visualizer to serve. Currently: architecture." })),
	artifactPath: Type.Optional(Type.String({ description: "Repository-relative JSON artifact path. Required when starting." })),
});

export type VisualCompanionInput = Static<typeof parameters>;
type CompanionState = "starting" | "running" | "error" | "stopped";

function setState(ctx: ExtensionContext, state: CompanionState, detail?: string): void {
	setServiceSnapshot(SERVICE_ID, { state, ...(detail ? { detail } : {}) }, ctx);
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
		child.once("spawn", () => { child.unref(); done(true); });
		child.once("error", () => done(false));
	});
}

export default function visualCompanion(pi: ExtensionAPI): void {
	const platform = createVisualCompanionPlatform();
	let activeViewer: string | undefined;
	let activeArtifact: string | undefined;

	const unregisterService = registerService({
		id: SERVICE_ID,
		name: "Visual companion",
		order: 30,
		internal: true,
		stayAlive: false,
		singleton: true,
		perSession: true,
	}, {
		start: async ({ ctx, signal }) => {
			const { backend } = await platform.start(signal);
			if (!backend.viewers.includes("story-board")) backend.registerViewer(createStoryBoardViewer({ repositoryRoot: ctx.cwd }));
			backend.select("story-board");
			return { state: "running", detail: backend.url };
		},
		health: async () => {
			const status = platform.status();
			return status.state === "running" ? { state: "running", detail: status.url } : { state: "stopped" };
		},
		stop: async () => platform.stop(),
	});

	pi.registerTool({
		name: "visual_companion",
		label: "Visual Companion",
		description: "Open an Architecture artifact in the single session-local shared Visual Companion shell, or stop its loopback backend.",
		promptSnippet: "Open or stop the session-local browser visual companion for an Architecture artifact",
		promptGuidelines: ["Use visual_companion after the Architecture skill writes its JSON artifact; update the artifact directly for live rerendering, and stop the companion when it is no longer needed."],
		parameters,
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			if (input.action === "stop") {
				const wasRunning = platform.status().state === "running";
				await platform.stop();
				activeViewer = undefined;
				activeArtifact = undefined;
				setState(ctx, "stopped");
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
				const { backend } = await platform.start(signal);
				if (!backend.viewers.includes("story-board")) backend.registerViewer(createStoryBoardViewer({ repositoryRoot: ctx.cwd }));
				const shown = await platform.open({ viewer: () => createArchitectureViewer(), artifactPath, ...(signal ? { signal } : {}) });
				activeViewer = viewerId;
				activeArtifact = artifactPath;
				setState(ctx, "running", platform.status().url);
				const opened = await openUrl(shown.url);
				return {
					content: [{
						type: "text",
						text: `${shown.reused ? "Reused" : "Started"} the visual companion backend at ${shown.url}\nServing ${viewerId}: ${shown.artifactPath}${opened ? "\nOpened the URL in the browser." : "\nCould not open the browser automatically; use the URL above."}${shown.valid ? "" : `\nArtifact diagnostics: ${shown.errors?.join("; ")}`}`,
					}],
					details: {
						state: "running",
						reused: shown.reused,
						url: shown.url,
						port: platform.status().port,
						visualizer: activeViewer,
						artifactPath: activeArtifact,
						valid: shown.valid,
						errors: shown.errors,
						opened,
					},
				};
			} catch (error) {
				setState(ctx, platform.status().state === "stopped" ? "stopped" : "error");
				throw error;
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		platform.beginSession();
		setState(ctx, "stopped");
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		await platform.shutdown();
		setState(ctx, "stopped");
		unregisterService();
	});
}
