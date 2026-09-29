import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createSessionScratchWorkspace } from "../../session-scratch/workspace.js";
import { createVisualCompanionBackend } from "../backend.mjs";
import { createScratchViewer } from "../scratch/index.js";

const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082", "hex");

test("scratch explorer pages nested files, blocks links and traversal, fences image versions and bindings", async () => {
	const workspace = await createSessionScratchWorkspace("explorer");
	const second = await createSessionScratchWorkspace("other");
	let binding = workspace.binding;
	const backend = await createVisualCompanionBackend({ viewers: [createScratchViewer(() => binding)] });
	const base = `${backend.url}/v/scratch`;
	const tree = (path: string, cursor = 0) => fetch(`${base}/api/tree?path=${encodeURIComponent(path)}&cursor=${cursor}`);
	const file = (path: string) => fetch(`${base}/api/file?path=${encodeURIComponent(path)}`);
	try {
		await mkdir(join(workspace.paths.root, "nested"));
		await writeFile(join(workspace.paths.root, "nested", "text.txt"), "hello");
		await writeFile(join(workspace.paths.root, "nested", "picture.png"), png);
		await writeFile(join(workspace.paths.root, "nested", "binary"), Buffer.from([0, 1]));
		await writeFile(join(workspace.paths.root, "nested", "invalid-utf8"), Buffer.from([0xff]));
		await writeFile(join(workspace.paths.root, "nested", "fake.png"), "not an image");
		await writeFile(join(workspace.paths.root, "nested", "huge"), Buffer.alloc(1024 * 1024 + 1, 65));
		await symlink("/etc", join(workspace.paths.root, "outside"));
		await symlink("/etc/passwd", join(workspace.paths.root, "nested", "link"));
		await writeFile(join(workspace.paths.root, "meta.json"), "{\"user\":true}");
		const deep = Array.from({ length: 17 }, () => "d").join("/");
		await mkdir(join(workspace.paths.root, deep), { recursive: true });
		await writeFile(join(workspace.paths.root, deep, "note.txt"), "deep");
		const root = await (await tree("")).json();
		assert.equal(root.kind, "directory");
		assert.equal(root.entries[0].kind, "directory");
		assert.equal(root.entries.some((item: { name: string }) => item.name === "meta.json"), true);
		assert.equal((await (await file("meta.json")).json()).content, "{\"user\":true}");
		assert.equal((await (await file(`${deep}/note.txt`)).json()).content, "deep");
		assert.equal((await (await tree(deep)).json()).kind, "directory");
		assert.equal(root.entries.find((item: { name: string }) => item.name === "outside").kind, "blocked");
		assert.equal((await (await tree("nested")).json()).entries.find((item: { name: string }) => item.name === "link").kind, "blocked");
		assert.deepEqual((await (await file("nested/text.txt")).json()).kind, "text");
		assert.equal((await (await file("nested/binary")).json()).kind, "binary");
		assert.equal((await (await file("nested/invalid-utf8")).json()).kind, "binary");
		assert.equal((await (await file("nested/fake.png")).json()).kind, "unsupported");
		assert.equal((await (await file("nested/huge")).json()).kind, "too-large");
		assert.equal((await (await file("nested/missing")).json()).kind, "missing");
		assert.equal((await (await file("nested/link")).json()).kind, "blocked");
		assert.equal((await (await tree("outside/inner")).json()).kind, "blocked");
		for (const path of ["../outside", "/etc/passwd", "nested/../text.txt", "nested//text.txt", "nested\\text.txt"]) {
			assert.equal((await file(path)).status, 400, path);
		}
		assert.equal((await fetch(`${base}/api/file?path=a&path=b`)).status, 400);
		for (const route of ["api/tree?path=", "api/file?path=nested%2Ftext.txt", "events?dir=nested"]) {
			assert.equal((await fetch(`${base}/${route}`, { method: "POST" })).status, 405);
			assert.equal((await fetch(`${base}/${route}`, { headers: { origin: "https://foreign.test" } })).status, 403);
		}
		assert.equal((await fetch(`${base}/events?dir=../outside`)).status, 400);
		assert.equal((await fetch(`${base}/api/tree?path=&cursor=999999`)).status, 400);
		const image = await (await file("nested/picture.png")).json();
		assert.equal(image.kind, "image");
		assert.equal(image.type, "image/png");
		assert.equal(image.size, png.length);
		const imageUrl = new URL(image.url, base);
		assert.deepEqual(Buffer.from(await (await fetch(imageUrl)).arrayBuffer()), png);
		assert.equal((await fetch(imageUrl, { method: "POST" })).status, 405);
		await writeFile(join(workspace.paths.root, "nested", "picture.png"), Buffer.concat([png, Buffer.from([0])]));
		assert.equal((await fetch(imageUrl)).status, 404);
		binding = second.binding;
		assert.equal((await fetch(imageUrl)).status, 409);
		assert.equal((await (await tree("")).json()).identity === root.identity, false);
	} finally {
		await backend.close();
		await Promise.all([workspace, second].map((w) => rm(w.paths.root, { recursive: true, force: true })));
	}
});

test("scratch tree pages deterministically and reports bounded directories", async () => {
	const workspace = await createSessionScratchWorkspace("pages");
	const backend = await createVisualCompanionBackend({ viewers: [createScratchViewer(() => workspace.binding)] });
	try {
		for (let i = 0; i < 110; i++) await writeFile(join(workspace.paths.root, `file-${String(i).padStart(3, "0")}`), "x");
		const url = `${backend.url}/v/scratch/api/tree?path=`;
		const first = await (await fetch(url)).json();
		assert.equal(first.entries.length, 100);
		assert.equal(first.nextCursor, 100);
		const next = await (await fetch(`${url}&cursor=${first.nextCursor}`)).json();
		assert.equal(next.nextCursor, null);
		assert.equal(new Set([...first.entries, ...next.entries].map((e: { name: string }) => e.name)).size, 114);
	} finally {
		await backend.close();
		await rm(workspace.paths.root, { recursive: true, force: true });
	}
});
