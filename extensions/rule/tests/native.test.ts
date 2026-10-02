import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import rulesExtension from "../index.js";
import { nativeSession } from "../../work-mode/tests/support/native-session.js";

const body = "# Scoped native fixture\n\nKeep complete scoped instructions.\nNever lose second paragraph.";

test("native next provider request receives nested rules independently of filtered script output", { timeout: 30_000 }, async () => {
	for (const scenario of ["filtered", "unfiltered", "rule-file", "failed"] as const) {
		const h = await nativeSession([rulesExtension]);
		try {
			await mkdir(join(h.cwd, ".pi", "rules"), { recursive: true });
			await mkdir(join(h.cwd, "src"));
			await writeFile(join(h.cwd, ".pi", "rules", "scoped.md"), `---\npaths: ['src/**/*.ts']\n---\n${body}\n`);
			await writeFile(join(h.cwd, "src", "app.ts"), "first source line\nsecond source line\n");
			await h.session.bindExtensions({ mode: "print" });
			const path = scenario === "rule-file" ? ".pi/rules/scoped.md" : scenario === "failed" ? "src/missing.ts" : "src/app.ts";
			const requests = await h.call("codemode", { code: `const result = await tools.read({path:${JSON.stringify(path)}}); text(${scenario === "unfiltered" ? "result" : "result.split('\\n')[0]"});` });
			assert.equal(requests.length, 2, `${scenario}: no extra turn from context injection`);
			const next = requests[1]!.messages;
			const messagesWithBody = next.filter((message) => JSON.stringify(message.content).includes("Keep complete scoped instructions."));
			const loaded = h.session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "pibox-rules-loaded");
			if (scenario === "failed") {
				assert.equal(messagesWithBody.length, 0);
				assert.equal(loaded.length, 0);
			} else {
				assert.equal(messagesWithBody.length, 1, `${scenario}: body delivered once, outside script result`);
				assert.equal(messagesWithBody[0]!.role, "user", "public custom context reaches provider as user-role message");
				assert.ok(JSON.stringify(messagesWithBody[0]!.content).includes("Never lose second paragraph."));
				assert.equal(loaded.length, 1);
				const result = [...next].reverse().find((message) => message.role === "toolResult");
				assert.ok(result && !result.isError);
				assert.ok(!JSON.stringify(result.content).includes("Keep complete scoped instructions."), "nested result need not carry instruction body");
			}
			const later = await h.call("read", { path: "src/app.ts" });
			assert.equal(later.length, 2);
			const direct = [...later[1]!.messages].reverse().find((message) => message.role === "toolResult");
			assert.ok(direct && !direct.isError);
			assert.equal(JSON.stringify(direct.content).includes("Keep complete scoped instructions."), scenario === "failed", "failure allows later direct delivery; success deduplicates");
			assert.equal(h.session.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "pibox-scoped-rules").length, scenario === "failed" ? 0 : 1);
		} finally { await h.close(); }
	}
});
