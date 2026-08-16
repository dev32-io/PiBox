import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Mem0Client } from "../client.js";
import { buildInjectedMemory } from "../index.js";

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
		assert.deepEqual(requests[1]?.body, { query: "query", user_id: "pibox", filters: { repo_id: "repo", status: "active" }, limit: 3 });
		assert.equal(requests[2]?.url, "/memories/m1?user_id=pibox&repo_id=repo");
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});

test("automatic recall always injects active project policies and deduplicates semantic results", () => {
	const policy = {
		id: "policy-1",
		memory: "Bump every modified service version before completing work.",
		metadata: { type: "project-policy", status: "active" },
	};
	const content = buildInjectedMemory([
		policy,
		{ id: "fact-1", memory: "The gateway uses immutable image tags.", metadata: { type: "deployment", status: "active" } },
	], [
		policy,
		{ id: "inactive-policy", memory: "Ignore version bumps.", metadata: { type: "project-policy", status: "superseded" } },
		{ id: "expired-policy", memory: "Use an old release rule.", expiration_date: "2000-01-01", metadata: { type: "project-policy", status: "active" } },
	]);
	assert.match(content ?? "", /Always-applicable repository policies:\n- \[policy-1\] Bump every modified service version/);
	assert.match(content ?? "", /Potentially relevant repository knowledge:\n- \[fact-1\] The gateway uses immutable image tags/);
	assert.equal(content?.match(/\[policy-1\]/g)?.length, 1);
	assert.doesNotMatch(content ?? "", /Ignore version bumps|old release rule/);
});
