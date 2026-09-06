import assert from "node:assert/strict";
import { rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { get } from "node:http";
import test from "node:test";
import { createSessionScratchWorkspace, type SessionScratchBinding } from "../../session-scratch/workspace.js";
import { createVisualCompanionBackend } from "../backend.mjs";
import { createScratchViewer } from "../scratch/index.js";

async function subscribe(url: string) {
	const controller = new AbortController();
	const response = await fetch(`${url}/v/scratch/events`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]) });
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	return {
		close: () => controller.abort(),
		async next(): Promise<string | undefined> {
			while (!buffer.includes("\n\n")) {
				const { value, done } = await reader.read();
				if (done) return undefined;
				buffer += decoder.decode(value, { stream: true });
			}
			const end = buffer.indexOf("\n\n");
			const event = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			return event;
		},
	};
}

const ready = "event: ready\ndata: {}";
const changed = "event: changed\ndata: {}";
const unavailable = "event: unavailable\ndata: {}";

test("scratch pushes content-free changes across in-place writes and repeated atomic saves", async () => {
	const workspace = await createSessionScratchWorkspace("live");
	const backend = await createVisualCompanionBackend({ viewers: [createScratchViewer(() => workspace.binding)] });
	const stream = await subscribe(backend.url);
	try {
		assert.equal(await stream.next(), ready);
		await writeFile(workspace.paths.plan, "# First plan");
		assert.equal(await stream.next(), changed);
		for (const text of ["# Replaced plan", "# Replaced again"]) {
			const temp = join(workspace.paths.root, "plan.tmp");
			await writeFile(temp, text, { mode: 0o600 });
			await rename(temp, workspace.paths.plan);
			assert.equal(await stream.next(), changed);
			const notes = await (await fetch(`${backend.url}/v/scratch/api/notes`)).json();
			assert.equal(notes.plan.markdown, text);
		}
		await writeFile(workspace.paths.ledger, "# Decision");
		assert.equal(await stream.next(), changed);
		await backend.close();
		assert.equal(await stream.next(), unavailable);
		assert.equal(await stream.next(), undefined, "backend close ends the stream and watcher");
	} finally {
		stream.close();
		await backend.close();
		await rm(workspace.paths.root, { recursive: true, force: true });
	}
});

test("scratch invalidates old streams on binding change and serves only the new binding", async () => {
	const first = await createSessionScratchWorkspace("first");
	const second = await createSessionScratchWorkspace("second");
	let binding: SessionScratchBinding | undefined = first.binding;
	const viewer = createScratchViewer(() => binding);
	const backend = await createVisualCompanionBackend({ viewers: [viewer] });
	const stream = await subscribe(backend.url);
	try {
		assert.equal(await stream.next(), ready);
		binding = second.binding;
		viewer.refreshBinding();
		assert.equal(await stream.next(), unavailable);
		assert.equal(await stream.next(), undefined);
		const next = await subscribe(backend.url);
		try {
			assert.equal(await next.next(), ready);
			await writeFile(second.paths.ledger, "Second only");
			assert.equal(await next.next(), changed);
			binding = undefined;
			await fetch(`${backend.url}/api/viewers`); // discovery also prunes changed bindings
			assert.equal(await next.next(), unavailable);
			assert.equal((await fetch(`${backend.url}/v/scratch/events`)).status, 404);
		} finally { next.close(); }
	} finally {
		stream.close();
		await backend.close();
		await Promise.all([first, second].map((w) => rm(w.paths.root, { recursive: true, force: true })));
	}
});

test("scratch notifications retain read-only, same-origin, bounded access and reject symlinked notes", async () => {
	const workspace = await createSessionScratchWorkspace("private");
	const backend = await createVisualCompanionBackend({ viewers: [createScratchViewer(() => workspace.binding)] });
	const url = `${backend.url}/v/scratch/events`;
	try {
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((await fetch(url, { method })).status, 405);
		for (const headers of [{ origin: "https://foreign.test" }, { "sec-fetch-site": "cross-site" }]) {
			assert.equal((await fetch(url, { headers })).status, 403);
		}
		const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
			get(url, { headers: { host: "foreign.test" } }, (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject);
		});
		assert.equal(foreignHostStatus, 403);
		assert.equal((await fetch(`${url}?path=/etc/passwd`)).status, 400);
		const stream = await subscribe(backend.url);
		try {
			assert.equal(await stream.next(), ready);
			await rm(workspace.paths.plan);
			await symlink(workspace.paths.meta, workspace.paths.plan);
			assert.equal(await stream.next(), changed, "notifications never contain file contents");
			assert.equal((await fetch(`${backend.url}/v/scratch/api/notes`)).status, 404);
			assert.equal((await fetch(url)).status, 404);
			await fetch(`${backend.url}/api/viewers`);
			assert.equal(await stream.next(), unavailable);
		} finally { stream.close(); }
	} finally {
		await backend.close();
		await rm(workspace.paths.root, { recursive: true, force: true });
	}
});

test("disconnecting one scratch reader does not stop other readers or later subscriptions", async () => {
	const workspace = await createSessionScratchWorkspace("readers");
	const backend = await createVisualCompanionBackend({ viewers: [createScratchViewer(() => workspace.binding)] });
	const first = await subscribe(backend.url);
	const second = await subscribe(backend.url);
	try {
		assert.equal(await first.next(), ready);
		assert.equal(await second.next(), ready);
		first.close();
		await writeFile(workspace.paths.plan, "Other reader stays live");
		assert.equal(await second.next(), changed);
		const third = await subscribe(backend.url);
		try { assert.equal(await third.next(), ready); } finally { third.close(); }
	} finally {
		first.close(); second.close();
		await backend.close();
		await rm(workspace.paths.root, { recursive: true, force: true });
	}
});
