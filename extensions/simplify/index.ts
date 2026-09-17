import { readFile } from "node:fs/promises";
import { parseFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function simplifyExtension(pi: ExtensionAPI) {
	pi.registerCommand("simplify", {
		description: "Review recent changes for reuse, quality, and efficiency, then apply justified cleanup",
		handler: async (args) => {
			const { body } = parseFrontmatter(await readFile(new URL("../../skills/simplify/SKILL.md", import.meta.url), "utf8"));
			pi.sendUserMessage(`${body.trim()}\n\n## Explicit user invocation\n\n/simplify${args.trim() ? ` ${args.trim()}` : ""}`, { deliverAs: "followUp" });
		},
	});
}
