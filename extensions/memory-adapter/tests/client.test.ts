import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { loopbackMem0Url, Mem0Client } from "../client.js";
import { buildRecallQuery, formatRecallContext, selectRecallCandidates } from "../index.js";

test("accepts only loopback Mem0 endpoint overrides", () => {
	assert.equal(loopbackMem0Url("http://127.0.0.1:6001"), "http://127.0.0.1:6001");
	assert.equal(loopbackMem0Url("http://localhost:6001/"), "http://localhost:6001");
	assert.throws(() => loopbackMem0Url("https://memory.example.com"), /loopback host/);
	assert.throws(() => loopbackMem0Url("http://127.0.0.1:6001/private"), /without credentials, path/);
});

test("does not follow redirects from a loopback Mem0 endpoint", async () => {
	const server = createServer((_request, response) => {
		response.statusCode = 302;
		response.setHeader("location", "https://memory.example.com/collect");
		response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing server address");
	try {
		const client = new Mem0Client({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "secret" });
		assert.equal(await client.health(), false);
		await assert.rejects(client.search("query", "pibox", "repo", 3), /Mem0 302/);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});

test("curated writes force infer=false and repository recall stays filtered", async () => {
	const requests: Array<{ url: string; method: string; key?: string; body?: unknown }> = [];
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			requests.push({
				url: request.url ?? "",
				method: request.method ?? "",
				...(request.headers["x-api-key"] ? { key: String(request.headers["x-api-key"]) } : {}),
				...(body ? { body: JSON.parse(body) } : {}),
			});
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify(request.url === "/search" ? [{ id: "m1", memory: "remember me" }] : [{ id: "m1", memory: "stored" }]));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing server address");
	try {
		const client = new Mem0Client({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "secret" });
		await client.add("curated", "pibox", { repo_id: "repo" });
		const recalled = await client.search("query", "pibox", "repo", 3);
		await client.get("m1", "pibox", "repo");
		assert.equal(recalled[0]?.memory, "remember me");
		assert.equal(requests[0]?.key, "secret");
		assert.deepEqual(requests[0]?.body, {
			messages: [{ role: "user", content: "curated" }],
			user_id: "pibox",
			metadata: { repo_id: "repo" },
			infer: false,
		});
		assert.deepEqual(requests[1]?.body, { query: "query", user_id: "pibox", filters: { repo_id: "repo" }, limit: 3 });
		assert.equal(requests[2]?.url, "/memories/m1?user_id=pibox&repo_id=repo");
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});

test("builds automatic recall queries from the bounded recent user objective", () => {
	const query = buildRecallQuery("implement the audio fix", [
		{ role: "user", content: "old unrelated request" },
		{ role: "assistant", content: [{ type: "text", text: "response" }] },
		{ role: "user", content: [{ type: "text", text: "investigate interrupted playback" }] },
	]);
	assert.equal(query, "old unrelated request\n\ninvestigate interrupted playback\n\nimplement the audio fix");
});

test("selects only active high-confidence memories near the best score", () => {
	const selection = selectRecallCandidates([
		{ id: "best", memory: "audio contract", score: 0.75, metadata: { status: "active" } },
		{ id: "related", memory: "audio pitfall", score: 0.68, metadata: { status: "active" } },
		{ id: "weak", memory: "generic lifecycle", score: 0.61, metadata: { status: "active" } },
		{ id: "stale", memory: "old behavior", score: 0.8, metadata: { status: "superseded" } },
	]);
	assert.deepEqual(selection.selected.map(({ id }) => id), ["best", "related"]);
	assert.match(selection.skipped.find(({ id }) => id === "weak")?.reason ?? "", /below/);
	assert.equal(selection.skipped.find(({ id }) => id === "stale")?.reason, "inactive or expired");
});

test("suppresses an entire low-confidence automatic recall", () => {
	const selection = selectRecallCandidates([
		{ id: "generic", memory: "not relevant", score: 0.61, metadata: { status: "active" } },
	]);
	assert.deepEqual(selection.selected, []);
	assert.match(selection.skipped[0]?.reason ?? "", /top score 0\.610 is below 0\.64/);
});

test("packs only complete bounded memory rows and reports budget exclusions", () => {
	const records = Array.from({ length: 5 }, (_, index) => ({
		id: `memory-${index + 1}`,
		memory: `fact ${index + 1} ${"x".repeat(2_000)}`,
		score: 0.8 - index * 0.01,
		metadata: { status: "active", type: "fact", evidence_paths: [`src/${index + 1}.ts`] },
	}));
	const packed = formatRecallContext(records);
	assert.ok(packed.content.length <= 4_000);
	assert.ok(packed.skipped.length > 0);
	for (const record of packed.included) assert.match(packed.content, new RegExp(`id=${record.id}\\b`));
	for (const skipped of packed.skipped) assert.doesNotMatch(packed.content, new RegExp(`id=${skipped.id}\\b`));
	assert.doesNotMatch(packed.content, /x{901}/, "individual memory text is bounded before packing");
});
