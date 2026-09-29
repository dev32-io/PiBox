import assert from "node:assert/strict";
import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { get } from "node:http";
import test from "node:test";
import { createSessionScratchWorkspace, type SessionScratchBinding } from "../../session-scratch/workspace.js";
import { createVisualCompanionBackend } from "../backend.mjs";
import { createScratchViewer } from "../scratch/index.js";

async function subscribe(url: string, query = "") {
	const controller = new AbortController();
	const response = await fetch(`${url}/v/scratch/events${query}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]) });
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
			await symlink(`${workspace.paths.root}/meta.json`, workspace.paths.plan);
			assert.equal(await stream.next(), changed, "notifications never contain file contents");
			assert.equal((await fetch(`${backend.url}/v/scratch/api/notes`)).status, 404);
			assert.equal((await fetch(url)).status, 200);
			await fetch(`${backend.url}/api/viewers`);
			// Broken note does not invalidate otherwise usable workspace stream.
		} finally { stream.close(); }
	} finally {
		await backend.close();
		await rm(workspace.paths.root, { recursive: true, force: true });
	}
});

test("expanded nested directories and opened files invalidate across atomic save and recreation", async () => {
	const workspace = await createSessionScratchWorkspace("nested-live");
	const dir = join(workspace.paths.root, "nested");
	await mkdir(dir);
	const backend = await createVisualCompanionBackend({ viewers: [createScratchViewer(() => workspace.binding)] });
	try {
		const query = "?dir=nested&file=nested%2Fopened.txt";
		const stream = await subscribe(backend.url, query);
		try {
			assert.equal(await stream.next(), ready);
			await writeFile(join(dir, "opened.tmp"), "first");
			await rename(join(dir, "opened.tmp"), join(dir, "opened.txt"));
			assert.equal(await stream.next(), changed);
			await rm(dir, { recursive: true });
			assert.equal(await stream.next(), changed);
			await mkdir(dir);
			await writeFile(join(dir, "opened.txt"), "second");
			assert.equal(await stream.next(), changed);
		} finally { stream.close(); }
		const next = await subscribe(backend.url, query);
		try {
			assert.equal(await next.next(), ready);
			await writeFile(join(dir, "opened.txt"), "third");
			assert.equal(await next.next(), changed);
		} finally { next.close(); }
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

test("disconnect or watcher error during awaited setup closes watchers without creating late ones", async () => {
	const { EventEmitter } = await import("node:events");
	const { watch } = await import("node:fs");
	for (const cause of ["disconnect", "error"] as const) {
		const workspace = await createSessionScratchWorkspace(`setup-${cause}`);
		let entered!: () => void, release!: () => void, closed!: () => void;
		const waiting = new Promise<void>((resolve) => { entered = resolve; });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const watcherClosed = new Promise<void>((resolve) => { closed = resolve; });
		let created = 0, destroyed = 0;
		let firstWatcher: InstanceType<typeof EventEmitter> | undefined;
		const viewer = createScratchViewer(() => workspace.binding, {
			directory: async (_binding, path) => {
				if (path === "nested") { entered(); await gate; }
				return join(workspace.paths.root, path);
			},
			watch: (() => {
				created += 1;
				firstWatcher = Object.assign(new EventEmitter(), { close() { destroyed += 1; closed(); } });
				return firstWatcher;
			}) as unknown as typeof watch,
		});
		const backend = await createVisualCompanionBackend({ viewers: [viewer] });
		try {
			const request = get(`${backend.url}/v/scratch/events?dir=nested`);
			request.on("error", () => undefined); // Expected after client disconnect.
			await waiting;
			assert.equal(created, 1);
			if (cause === "disconnect") request.destroy();
			else firstWatcher!.emit("error", new Error("watch failed"));
			await watcherClosed;
			release();
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(created, 1, `no late watcher after ${cause}`);
			assert.equal(destroyed, 1);
		} finally {
			release();
			await backend.close();
			await rm(workspace.paths.root, { recursive: true, force: true });
		}
	}
});

test("pending watcher setups reserve all 16 slots before await and release them on close", async () => {
	const { EventEmitter } = await import("node:events");
	const { watch } = await import("node:fs");
	const workspace = await createSessionScratchWorkspace("stream-cap");
	let release!: () => void, entered!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const allEntered = new Promise<void>((resolve) => { entered = resolve; });
	let pending = 0, created = 0, destroyed = 0;
	const viewer = createScratchViewer(() => workspace.binding, {
		directory: async () => {
			if (++pending === 16) entered();
			await gate;
			return workspace.paths.root;
		},
		watch: (() => {
			created += 1;
			return Object.assign(new EventEmitter(), { close() { destroyed += 1; } });
		}) as unknown as typeof watch,
	});
	const backend = await createVisualCompanionBackend({ viewers: [viewer] });
	const controllers = Array.from({ length: 16 }, () => new AbortController());
	try {
		const url = `${backend.url}/v/scratch/events`;
		const requests = controllers.map(({ signal }) => fetch(url, { signal }));
		await allEntered;
		assert.equal((await fetch(url)).status, 429);
		release();
		const streams = await Promise.all(requests);
		assert.equal(streams.every((response) => response.status === 200), true);
		assert.equal(created, 16);
		controllers.forEach((controller) => controller.abort());
		await backend.close();
		assert.equal(destroyed, created);
	} finally {
		release();
		controllers.forEach((controller) => controller.abort());
		await backend.close();
		await rm(workspace.paths.root, { recursive: true, force: true });
	}
});

test("change during watcher setup follows SSE ready and stream stays live", async () => {
	const { EventEmitter } = await import("node:events");
	const { watch } = await import("node:fs");
	const workspace = await createSessionScratchWorkspace("setup-change");
	let entered!: () => void, release!: () => void;
	const waiting = new Promise<void>((resolve) => { entered = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const watchers: Array<InstanceType<typeof EventEmitter> & { close(): void }> = [];
	let closed = 0;
	const viewer = createScratchViewer(() => workspace.binding, {
		directory: async (_binding, path) => {
			if (path === "nested") { entered(); await gate; }
			return join(workspace.paths.root, path);
		},
		watch: ((_path: string, _options: unknown, listener: (...args: unknown[]) => void) => {
			const watcher = Object.assign(new EventEmitter(), { close() { closed += 1; } });
			watcher.on("change", listener);
			watchers.push(watcher);
			return watcher;
		}) as unknown as typeof watch,
	});
	const backend = await createVisualCompanionBackend({ viewers: [viewer] });
	const controller = new AbortController();
	try {
		let responded = false;
		const pending = fetch(`${backend.url}/v/scratch/events?dir=nested`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]) })
			.then((response) => { responded = true; return response; });
		await waiting;
		assert.equal(watchers.length, 1);
		watchers[0]!.emit("change", "rename", "plan.md");
		watchers[0]!.emit("change", "change", "plan.md");
		await new Promise((resolve) => setTimeout(resolve, 90)); // Past 60 ms debounce while later setup stays blocked.
		assert.equal(responded, false, "no stream bytes before ready");
		release();
		const response = await pending;
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
		const reader = response.body!.getReader();
		let body = "";
		const readUntil = async (count: number) => {
			while (body.split("event: changed").length - 1 < count) {
				const { value, done } = await reader.read();
				assert.equal(done, false);
				body += new TextDecoder().decode(value);
			}
		};
		await readUntil(1);
		assert.match(body, /^event: ready\ndata: \{\}\n\nevent: changed\ndata: \{\}\n\n/);
		watchers[0]!.emit("change", "change", "plan.md");
		await readUntil(2);
		assert.equal(body.split("event: ready").length - 1, 1);
	} finally {
		release();
		controller.abort();
		await backend.close();
		assert.equal(closed, watchers.length);
		await rm(workspace.paths.root, { recursive: true, force: true });
	}
});
