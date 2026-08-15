import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { probeServiceHealth } from "../compose.js";

test("health probes bypass Fetch forbidden-port policy", async () => {
	const server = createServer((_request, response) => {
		response.statusCode = 200;
		response.end("ok");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing server address");
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (() => { throw new Error("health probe must not use fetch"); }) as typeof fetch;
	try {
		assert.deepEqual(await probeServiceHealth(`http://127.0.0.1:${address.port}/`, 1_000), {
			state: "running",
			detail: `127.0.0.1:${address.port}`,
		});
	} finally {
		globalThis.fetch = originalFetch;
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});
