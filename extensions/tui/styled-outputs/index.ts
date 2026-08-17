import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	generateDiffString,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, Markdown, Spacer, visibleWidth } from "@earendil-works/pi-tui";
import { decorateHexColors } from "./color-preview.js";
import { DEFAULT_STYLED_OUTPUTS_CONFIG } from "./config.js";
import { createPrefixedMarkdown } from "./components/message-layout.js";
import { renderToolCall, renderToolResult } from "./components/tool-renderers.js";
import { LinePrefixedComponent } from "./components/tool-shell.js";
import { isHarnessTool, renderHarnessToolCall, renderHarnessToolResult } from "./components/harness-tool-renderers.js";

const PATCH_FLAG = Symbol.for("pibox:styled-outputs:patched:v3");
// Version tool patches separately so /reload can replace an older shell patch
// without re-wrapping the already-installed user/assistant message patches.
const TOOL_PATCH_FLAG = Symbol.for("pibox:styled-outputs:tool-patched:v8");
const STATE_KEY = Symbol.for("pibox:styled-outputs:state");
type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
const STYLED_TOOL_NAMES = new Set<string>(["read", "bash", "edit", "write", "grep", "find", "ls"]);

interface GlobalStyleState {
	theme: Theme | undefined;
}

function globalState(): GlobalStyleState {
	const root = globalThis as typeof globalThis & { [STATE_KEY]?: GlobalStyleState };
	return (root[STATE_KEY] ??= { theme: undefined });
}

function installMessagePatches(): void {
	const assistantPrototype = AssistantMessageComponent.prototype as any;
	if (!assistantPrototype[PATCH_FLAG]) {
		const originalUpdateContent = assistantPrototype.updateContent;
		assistantPrototype.updateContent = function piBoxAssistantUpdate(message: any, isStreaming?: boolean) {
			originalUpdateContent.call(this, message, isStreaming);
			// Pi must retain the normalized error internally to trigger overflow
			// recovery, but the transcript does not need to show that recovered
			// failure above the auto-compaction status.
			if (
				message?.provider === "local-llm" &&
				message?.stopReason === "error" &&
				/context[_ ]length[_ ]exceeded/i.test(message?.errorMessage ?? "")
			) {
				this.contentContainer?.clear();
				return;
			}
			const theme = globalState().theme;
			const children = this.contentContainer?.children;
			if (!theme || !Array.isArray(children)) return;

			// Thinking remains in the session and model context, but is presented live
			// in the working row instead of accumulating in transcript history.
			this.contentContainer.children = children.filter((child: any) =>
				!(child instanceof Markdown && (child as any).defaultTextStyle?.italic),
			);
			const visibleChildren = this.contentContainer.children;
			if (visibleChildren.every((child: any) => child instanceof Spacer)) {
				this.contentContainer.clear();
				return;
			}
			// User messages own the turn's trailing gap, so remove Pi's conditional
			// assistant-leading spacer. This keeps text and tool-only turns aligned.
			if (visibleChildren[0] instanceof Spacer) visibleChildren[0].setLines(0);
			for (let index = 0; index < visibleChildren.length; index++) {
				const child = visibleChildren[index];
				if (!(child instanceof Markdown)) continue;
				const text = (child as any).text;
				if (text) visibleChildren[index] = createPrefixedMarkdown(text, this.markdownTheme, theme, {
					prefix: "●",
					prefixColor: "text",
				});
			}
		};
		assistantPrototype[PATCH_FLAG] = true;
	}

	const userPrototype = UserMessageComponent.prototype as any;
	if (!userPrototype[PATCH_FLAG]) {
		const originalRebuild = userPrototype.rebuild;
		userPrototype.rebuild = function piBoxUserRebuild() {
			originalRebuild.call(this);
			const theme = globalState().theme;
			const box = this.children?.[0];
			if (!theme || !Array.isArray(box?.children)) return;
			for (let index = 0; index < box.children.length; index++) {
				const child = box.children[index];
				if (!(child instanceof Markdown)) continue;
				const text = (child as any).text;
				if (text) box.children[index] = createPrefixedMarkdown(text, this.markdownTheme, theme, {
					prefix: "❯",
					prefixColor: "accent",
					bodyColor: "text",
				});
			}
			// Own one stable trailing row here instead of relying on the next assistant
			// component, which omits its leading spacer for tool-only responses.
			box.paddingX = 0;
			box.paddingY = 0;
			this.addChild(new Spacer(1));
		};
		userPrototype[PATCH_FLAG] = true;
	}
}

function installToolPatch(): void {
	const prototype = ToolExecutionComponent.prototype as any;
	if (prototype[TOOL_PATCH_FLAG]) return;
	const originalUpdateDisplay = prototype.updateDisplay;
	prototype.updateDisplay = function piBoxToolUpdateDisplay() {
		originalUpdateDisplay.call(this);
		// Native tool rows begin with a Spacer(1). That is useful for boxed tools,
		// but makes a sequence of compact calls look double-spaced.
		const leadingSpacer = this.children?.[0];
		if (leadingSpacer instanceof Spacer) leadingSpacer.setLines(0);

		const renderContainer = this.getRenderShell?.() === "self" ? this.selfRenderContainer : this.contentBox;
		if (this.contentBox) {
			// The shared shell owns transcript-body indentation for both PiBox and
			// third-party tools. Individual renderers remain padding-independent.
			this.contentBox.paddingX = 3;
			this.contentBox.paddingY = 0;
			this.contentBox.setBgFn(undefined);
		}

		// PiBox harness tools share one semantic renderer so structured results remain
		// readable instead of appearing as raw JSON blobs. Foreground subagents use
		// the same pulsing row language as the background footer dashboard.
		if (isHarnessTool(this.toolName) && Array.isArray(renderContainer?.children)) {
			const theme = globalState().theme;
			if (theme) {
				const call = renderHarnessToolCall(this.toolName, this.args ?? {}, theme, this.isPartial, this.result?.isError ?? false, this.result?.details);
				const children = [call];
				if (this.result && !this.isPartial) children.push(renderHarnessToolResult(this.toolName, this.result, this.expanded, theme, this.result.isError ?? false));
				renderContainer.children = children;
			}
			return;
		}

		// Third-party renderers already know how to summarize their domain-specific
		// output. Decorate those components rather than replacing them, giving every
		// tool the same lifecycle checkmark and status branch as PiBox's built-ins.
		if (!STYLED_TOOL_NAMES.has(this.toolName) && Array.isArray(renderContainer?.children)) {
			const theme = globalState().theme;
			const shellIndent = this.getRenderShell?.() === "self" ? "   " : "";
			// A versioned /reload may be running outside an older compatibility patch.
			// Peel off its display-only wrapper before applying the current layout.
			const unwrap = (component: any): any => {
				while (component?.constructor?.name === "LinePrefixedComponent" && component.child) component = component.child;
				return component;
			};
			const call = unwrap(renderContainer.children[0]);
			const result = this.result ? unwrap(renderContainer.children[1]) : undefined;
			if (theme && call) {
				const symbol = this.isPartial
					? theme.fg("muted", "✽")
					: this.result?.isError
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");
				const prefix = `${shellIndent}${symbol} `;
				const continuation = `${shellIndent}  `;
				renderContainer.children[0] = new LinePrefixedComponent(
					call, prefix, continuation, visibleWidth(prefix), visibleWidth(continuation),
				);
			}
			if (theme && result) {
				const status = this.isPartial ? "Running…" : this.result?.isError ? "Error" : "Done";
				const color = this.isPartial ? "muted" : this.result?.isError ? "error" : "success";
				const prefix = `${shellIndent}${theme.fg("dim", "└─")} ${theme.fg(color, status)}${theme.fg("dim", " • ")}`;
				const continuation = `${shellIndent}   `;
				const toggle = getKeybindings().getKeys("app.tools.expand")[0] ?? "ctrl+o";
				const collapsed = !this.isPartial && !this.expanded;
				renderContainer.children[1] = new LinePrefixedComponent(
					result,
					prefix,
					continuation,
					visibleWidth(prefix),
					visibleWidth(continuation),
					"",
					0,
					collapsed ? 3 : undefined,
					collapsed ? (text) => theme.fg("muted", text) : undefined,
					collapsed ? (omitted) => theme.fg("dim", `… +${omitted} lines (${toggle} to expand)`) : undefined,
				);
			}
		}
	};
	prototype[TOOL_PATCH_FLAG] = true;
}

function registerStyledTools(pi: ExtensionAPI): void {
	const cwd = process.cwd();
	const tools: Array<[ToolName, any]> = [
		["read", createReadTool(cwd)],
		["bash", createBashTool(cwd)],
		["edit", createEditTool(cwd)],
		["write", createWriteTool(cwd)],
		["grep", createGrepTool(cwd)],
		["find", createFindTool(cwd)],
		["ls", createLsTool(cwd)],
	];
	for (const [name, tool] of tools) {
		pi.registerTool({
			...tool,
			name,
			// Keep every built-in in the same padded shell. Edit otherwise inherits
			// its native self-rendering shell and escapes transcript indentation.
			renderShell: "default",
			async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
				if (name !== "write") return tool.execute(toolCallId, params, signal, onUpdate, ctx);
				let previous: string | undefined;
				try {
					previous = await readFile(resolve(cwd, params.path), "utf8");
				} catch {
					// A missing or unreadable target is classified as a create. The wrapped
					// write tool remains responsible for reporting actual write failures.
				}
				const result = await tool.execute(toolCallId, params, signal, onUpdate, ctx);
				const diff = generateDiffString(previous ?? "", params.content).diff;
				return {
					...result,
					details: { piboxWrite: { action: previous === undefined ? "create" : "rewrite", diff } },
				};
			},
			renderCall: (args: any, theme: Theme, ctx: any) => renderToolCall(name, args, theme, ctx),
			renderResult: (result: any, options: any, theme: Theme, ctx: any) => renderToolResult(name, result, options, theme, ctx),
		});
	}
}

export default function styledOutputs(pi: ExtensionAPI): void {
	const config = DEFAULT_STYLED_OUTPUTS_CONFIG;
	installMessagePatches();
	installToolPatch();
	registerStyledTools(pi);

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") globalState().theme = ctx.ui.theme;
	});
	pi.on("session_shutdown", () => {
		globalState().theme = undefined;
	});

	pi.registerMarkdownTransformer((markdown, context) => {
		if (
			!context.isStreaming &&
			config.colorPreviews.enabled &&
			config.colorPreviews.messageTypes.includes(context.messageType)
		) return decorateHexColors(markdown, config.colorPreviews);
		return markdown;
	});
}
