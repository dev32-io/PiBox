import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { createComposeServiceController, probeServiceHealth } from "../compose.js";

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


test("compose failures retain complete diagnostic text", async (t) => {
 const root = await mkdtemp(join(tmpdir(), "pibox-compose-diagnostic-"));
 t.after(() => rm(root, { recursive: true, force: true }));
 const diagnostic = `${"compose detail\n".repeat(100)}ROOT_CAUSE_AT_END`;
 const pi = { async exec() { return { code: 1, stdout: "", stderr: diagnostic }; } } as any;
 const controller = createComposeServiceController(pi, { id: "test", composeFile: "compose.yaml", projectDirectory: root, healthUrl: "http://127.0.0.1:1", lockRoot: root });
 await assert.rejects(controller.stop!({ ctx: {} as any }), (error: Error) => {
  assert.equal(error.message, `docker compose stop failed: ${diagnostic}`);
  return true;
 });
});
