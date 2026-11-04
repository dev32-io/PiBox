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
export const ICON_SUBAGENT = "\u{f06a9}"; // nf-md-robot
export const ICON_WORKFLOW = "\u{f0e8}"; // nf-fa-sitemap
export const ICON_WEB = "\u{f0ac}"; // nf-fa-globe (MCP and web tools)
export const ICON_TOOL = "\u{f0ad}"; // nf-fa-wrench (unknown third-party tools)
export const ICON_GIT_BRANCH = "\u{e725}"; // nf-dev-git_branch
// Soft (thin) powerline divider: a hard triangle needs background fills this footer does not use.
export const ICON_SEPARATOR = "\u{e0b1}"; // nf-pl-left_soft_divider

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
