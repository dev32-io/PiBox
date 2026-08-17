import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import memoryAdapter from "../index.js";

test("retrieves once per run and injects memory ephemerally before the current user message", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-memory-retrieval-"));
	await mkdir(join(root, ".git"));
	await writeFile(join(root, "audio.ts"), "export const queue = [];\n");
	await writeFile(join(root, "untracked.ts"), "export const unsafe = true;\n");
	t.after(() => rm(root, { recursive: true, force: true }));
	let searches = 0;
	let query = "";
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			response.setHeader("content-type", "application/json");
			if (request.url === "/health") return response.end(JSON.stringify({ status: "ok" }));
			if (request.url === "/search") {
				searches++;
				query = JSON.parse(body).query;
				return response.end(JSON.stringify([
					{ id: "audio-contract", memory: "Interrupted playback must clear the local queue.", score: 0.74, metadata: { status: "active", type: "audio-contract", evidence_paths: ["audio.ts"], verified_commit: "abc123" } },
					{ id: "untracked", memory: "Claim backed only by an untracked file.", score: 0.72, metadata: { status: "active", type: "audio-contract", evidence_paths: ["untracked.ts"], verified_commit: "abc123" } },
					{ id: "unverified", memory: "Unverified but similar audio claim.", score: 0.7, metadata: { status: "active", type: "audio-contract", evidence_paths: [] } },
					{ id: "weak", memory: "Generic unrelated fact.", score: 0.5, metadata: { status: "active", type: "misc", evidence_paths: [] } },
				]));
			}
			response.statusCode = 404;
			response.end(JSON.stringify({ error: "not found" }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing server address");
	const previousUrl = process.env.PIBOX_MEM0_URL;
	const previousKey = process.env.PIBOX_MEM0_API_KEY;
	process.env.PIBOX_MEM0_URL = `http://127.0.0.1:${address.port}`;
	process.env.PIBOX_MEM0_API_KEY = "test-key";
	t.after(() => {
		if (previousUrl === undefined) delete process.env.PIBOX_MEM0_URL; else process.env.PIBOX_MEM0_URL = previousUrl;
		if (previousKey === undefined) delete process.env.PIBOX_MEM0_API_KEY; else process.env.PIBOX_MEM0_API_KEY = previousKey;
	});

	const handlers = new Map<string, (...args: any[]) => any>();
	const bus = new Map<string, (value: unknown) => void>();
	const pi = {
		registerTool() {}, registerCommand() {}, sendUserMessage() {}, sendMessage() {},
		events: { on(name: string, handler: (value: unknown) => void) { bus.set(name, handler); }, emit(name: string, value: unknown) { bus.get(name)?.(value); } },
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		async exec(_command: string, args: string[]) {
			if (args.includes("--show-toplevel")) return { code: 0, stdout: `${root}\n`, stderr: "" };
			if (args.includes("--git-common-dir")) return { code: 0, stdout: `${join(root, ".git")}\n`, stderr: "" };
			if (args.includes("HEAD")) return { code: 0, stdout: "abc123\n", stderr: "" };
			if (args[0] === "ls-tree") {
				const separator = args.indexOf("--");
				const paths = args.slice(separator + 1).filter((path) => path !== "untracked.ts");
				return { code: 0, stdout: `${paths.join("\n")}${paths.length ? "\n" : ""}`, stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		},
	} as any;
	memoryAdapter(pi);
	const ctx = { cwd: root } as any;
	const before = await handlers.get("before_agent_start")?.({ prompt: "Fix interrupted assistant playback" }, ctx);
	assert.equal(before, undefined, "retrieval must not append a persistent before-agent message");
	const original = [
		{ role: "user", content: "Earlier audio investigation", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "I will inspect it." }], timestamp: 2 },
		{ role: "user", content: "Fix interrupted assistant playback", timestamp: 3 },
	];
	const first = await handlers.get("context")?.({ messages: original }, ctx);
	assert.equal(original.length, 3, "the session-derived context must remain unchanged");
	assert.equal(first.messages.length, 4);
	assert.equal(first.messages[2]?.customType, "pibox-memory");
	assert.match(first.messages[2]?.content ?? "", /audio-contract.*score=0\.740/);
	assert.match(first.messages[2]?.content ?? "", /clear the local queue/);
	assert.doesNotMatch(first.messages[2]?.content ?? "", /Claim backed only by an untracked|Unverified but similar|Generic unrelated fact/);
	assert.match(query, /Earlier audio investigation[\s\S]*Fix interrupted assistant playback/);
	await handlers.get("context")?.({ messages: original }, ctx);
	assert.equal(searches, 1, "tool-loop model calls reuse the run-scoped retrieval");
	await handlers.get("agent_settled")?.({}, ctx);
	assert.equal(await handlers.get("context")?.({ messages: original }, ctx), undefined);
	let provider: any;
	bus.get("pibox:distill:discover-knowledge-providers")?.({ register(value: unknown) { provider = value; } });
	assert.equal(provider.id, "mem0");
	const compared = await provider.search("interrupted playback", { cwd: root, limit: 3 });
	assert.equal(compared[0]?.id, "audio-contract");
	assert.deepEqual(compared[0]?.evidence, ["audio.ts"]);
});
