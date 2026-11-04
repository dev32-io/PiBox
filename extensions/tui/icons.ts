/**
 * Nerd Font glyphs for the TUI (Hack Nerd Font fallback). Every glyph is a JS
 * escape: literal private-use characters are dropped by the authoring pipeline.
 * Icons are always followed by exactly one space; terminals may draw them two
 * cells wide when the next cell is blank.
 */
export const ICON_BASH = "\u{f489}"; // nf-oct-terminal
export const ICON_READ = "\u{f15c}"; // nf-fa-file_text
export const ICON_EDIT = "\u{f044}"; // nf-fa-pencil_square_o
export const ICON_WRITE = "\u{ea7f}"; // nf-cod-new_file: outline file with a plus, matching the outline style of the others
export const ICON_GREP = "\u{f002}"; // nf-fa-search
export const ICON_FOLDER = "\u{f07b}"; // nf-fa-folder (find, ls, cwd)
export const ICON_EXPLORE = "\u{f1e5}"; // nf-fa-binoculars (grouped read-only exploration)
export const ICON_SUBAGENT = "\u{f06a9}"; // nf-md-robot
export const ICON_WORKFLOW = "\u{f0e8}"; // nf-fa-sitemap
export const ICON_WEB = "\u{f0ac}"; // nf-fa-globe (MCP and web tools)
export const ICON_TOOL = "\u{f0ad}"; // nf-fa-wrench (unknown third-party tools)
export const ICON_GIT_BRANCH = "\u{e725}"; // nf-dev-git_branch
export const ICON_POWERLINE_BRANCH = "\u{e0a0}"; // nf-pl-branch (agnoster/oh-my-zsh branch mark)
export const ICON_POWERLINE_ARROW = "\u{e0b0}"; // nf-pl-left_hard_divider (filled segment end)
export const ICON_POWERLINE_CAP = "\u{e0b6}"; // nf-ple-left_half_circle_thick (rounded chain start)
export const ICON_POWERLINE_END = "\u{e0b4}"; // nf-ple-right_half_circle_thick (rounded pill/chain end)
export const ICON_POWERLINE_BACK = "\u{e0b2}"; // nf-pl-right_hard_divider (left-pointing arrow for right-aligned chains)
export const ICON_PERMISSIONS = "\u{f132}"; // nf-fa-shield
export const ICON_EFFORT = "\u{f0eb}"; // nf-fa-lightbulb_o
export const ICON_TIER = "\u{f1de}"; // nf-fa-sliders
export const ICON_FAST = "\u{f0e7}"; // nf-fa-bolt
export const ICON_TOKENS = "\u{f0ec}"; // nf-fa-exchange
export const ICON_SERVICE_DATABASE = "\u{f1c0}"; // nf-fa-database (Mem0)
export const ICON_SERVICE_SEARCH = "\u{f002}"; // nf-fa-search (SearXNG)
export const ICON_SERVICE_VIEW = "\u{f06e}"; // nf-fa-eye (Visual companion)
export const ICON_SERVICE_SERVER = "\u{f233}"; // nf-fa-server (any other service)

const BUILTIN_TOOL_ICONS: Record<string, string> = {
	bash: ICON_BASH,
	read: ICON_READ,
	edit: ICON_EDIT,
	write: ICON_WRITE,
	grep: ICON_GREP,
	find: ICON_FOLDER,
	ls: ICON_FOLDER,
};

export function builtinToolIcon(name: string): string {
	return BUILTIN_TOOL_ICONS[name] ?? ICON_TOOL;
}

/** Third-party tools: MCP and web fetchers get the globe, everything else a wrench. */
export function decoratedToolIcon(name: string): string {
	return name.startsWith("mcp__") || /^(web_search|fetch_content|source_check|get_search_content)$/.test(name) ? ICON_WEB : builtinToolIcon(name);
}

export function harnessToolIcon(name: string): string {
	return name.startsWith("subagent_") ? ICON_SUBAGENT : ICON_WORKFLOW;
}
