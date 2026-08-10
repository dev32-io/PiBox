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
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { decorateHexColors } from "./color-preview.js";
import { DEFAULT_STYLED_OUTPUTS_CONFIG } from "./config.js";
import { createPrefixedMarkdown } from "./components/message-layout.js";
import { renderToolCall, renderToolResult } from "./components/tool-renderers.js";

const PATCH_FLAG = Symbol.for("pibox:styled-outputs:patched");
const STATE_KEY = Symbol.for("pibox:styled-outputs:state");
type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

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
			const theme = globalState().theme;
			const children = this.contentContainer?.children;
			if (!theme || !Array.isArray(children)) return;
			for (let index = 0; index < children.length; index++) {
				const child = children[index];
				if (!(child instanceof Markdown)) continue;
				const text = (child as any).text;
				if (!text) continue;
				const thinking = !!(child as any).defaultTextStyle?.italic;
				children[index] = createPrefixedMarkdown(text, this.markdownTheme, theme, thinking
					? { prefix: "✽", prefixColor: "accent", bodyColor: "thinkingText", italic: true }
					: { prefix: "●", prefixColor: "text" });
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
			box.paddingX = 0;
		};
		userPrototype[PATCH_FLAG] = true;
	}
}

function installToolPatch(): void {
	const prototype = ToolExecutionComponent.prototype as any;
	if (prototype[PATCH_FLAG]) return;
	const originalUpdateDisplay = prototype.updateDisplay;
	prototype.updateDisplay = function piBoxToolUpdateDisplay() {
		originalUpdateDisplay.call(this);
		if (this.contentBox) {
			this.contentBox.paddingX = 3;
			this.contentBox.paddingY = 0;
			this.contentBox.setBgFn(undefined);
		}
	};
	prototype[PATCH_FLAG] = true;
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
