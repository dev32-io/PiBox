import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const helperPath = resolve("extensions/visual-companion/mockup/assets/tweaks.js");
const appPath = resolve("extensions/visual-companion/mockup/assets/app.js");
const htmlPath = resolve("extensions/visual-companion/mockup/assets/index.html");

async function helperApi() {
	const source = (await readFile(helperPath, "utf8")).replaceAll("export ", "");
	const messages: unknown[] = [];
	const parent = { postMessage: (message: unknown) => messages.push(message) };
	const listeners = new Map<string, (event: any) => void>();
	const context = vm.createContext({
		URLSearchParams,
		location: { hash: "#tweaks=session" },
		parent,
		addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener),
		removeEventListener: (type: string) => listeners.delete(type),
	});
	new vm.Script(`${source}\nglobalThis.api = { validateTweaksDefinition, valuesFor, connectTweaks, requestTweaksReload };`).runInContext(context);
	return { api: (context as any).api, messages, parent, listeners };
}

const definition = {
	controls: [
		{ key: "layout", label: "Layout", type: "choice", options: [{ value: "cards", label: "Cards" }, { value: "table", label: "Table" }], default: "cards" },
		{ key: "motion", label: "Motion", type: "toggle", default: true },
		{ key: "density", label: "Density", type: "range", min: 1, max: 5, step: 1, default: 3 },
	],
};

test("tweak definitions validate combinations and retain only compatible values", async () => {
	const { api } = await helperApi();
	const parsed = api.validateTweaksDefinition(definition);
	assert.deepEqual(
		JSON.parse(JSON.stringify(api.valuesFor(parsed, { layout: "table", motion: false, density: 4, extra: "drop" }))),
		{ layout: "table", motion: false, density: 4 },
	);
	assert.deepEqual(
		JSON.parse(JSON.stringify(api.valuesFor(parsed, { layout: "gone", motion: "yes", density: 99 }))),
		{ layout: "cards", motion: true, density: 3 },
	);
	for (const malformed of [
		{},
		{ controls: [] },
		{ controls: [{ key: "x", label: "X", type: "toggle", default: "yes" }] },
		{ controls: [{ key: "x", label: "X", type: "choice", options: [], default: "x" }] },
		{ controls: [{ key: "x", label: "X", type: "range", min: 5, max: 1, default: 3 }] },
	]) assert.throws(() => api.validateTweaksDefinition(malformed));
});

test("sandbox helper fences sources, tokens, and values before delivering complete state", async () => {
	const { api, messages, parent, listeners } = await helperApi();
	const received: unknown[] = [];
	api.connectTweaks((values: unknown) => received.push(values));
	assert.deepEqual(JSON.parse(JSON.stringify(messages[0])), { channel: "visual-companion:tweaks", token: "session", type: "ready" });
	const receive = listeners.get("message")!;
	const valid = { channel: "visual-companion:tweaks", token: "session", type: "state", values: { layout: "table", motion: false, density: 4 } };
	receive({ source: {}, data: valid });
	receive({ source: parent, data: { ...valid, token: "stale" } });
	receive({ source: parent, data: { ...valid, values: { density: Number.NaN } } });
	assert.equal(received.length, 0);
	receive({ source: parent, data: valid });
	assert.deepEqual(JSON.parse(JSON.stringify(received)), [{ layout: "table", motion: false, density: 4 }]);
	assert.equal(Object.isFrozen(received[0]), true);
	api.requestTweaksReload();
	assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { channel: "visual-companion:tweaks", token: "session", type: "reload" });
});

const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const turn = () => new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

async function runWrapper(initialTweaks: unknown | undefined) {
	const dom = new JSDOM(await readFile(htmlPath, "utf8"), { url: "http://companion.test/v/mockup/" });
	const { window } = dom;
	let documentEntry = "/prototype/index.html";
	let tweaks = initialTweaks;
	let documentResponder = async () => response({ ok: true, document: { entry: documentEntry } });
	let tweaksResponder = async () => tweaks === undefined ? response({}, 404) : response(tweaks);
	const eventListeners = new Map<string, (event: any) => void>();
	class EventSourceMock {
		addEventListener(type: string, listener: (event: any) => void) { eventListeners.set(type, listener); }
	}
	const fetchMock = async (url: string) => url === "./api/document" ? documentResponder() : tweaksResponder();
	const helper = await helperApi();
	const source = (await readFile(appPath, "utf8")).replace(
		'import { validateTweaksDefinition, valuesFor } from "./tweaks.js";',
		"const { validateTweaksDefinition, valuesFor } = __tweaks;",
	);
	const context = vm.createContext({
		__tweaks: helper.api,
		console,
		crypto: { randomUUID: (() => { let id = 0; return () => `token-${++id}`; })() },
		document: window.document,
		EventSource: EventSourceMock,
		fetch: fetchMock,
		navigator: { clipboard: { writeText: async () => {} } },
		Option: window.Option,
		addEventListener: window.addEventListener.bind(window),
	});
	await new vm.Script(`(async () => { ${source} })()`).runInContext(context);
	return {
		window,
		eventListeners,
		frame: window.document.querySelector("#mockup") as HTMLIFrameElement,
		panel: window.document.querySelector("#tweaks") as HTMLDetailsElement,
		setDocumentEntry: (entry: string) => { documentEntry = entry; },
		setTweaks: (next: unknown | undefined) => { tweaks = next; },
		setDocumentResponder: (next: typeof documentResponder) => { documentResponder = next; },
		setTweaksResponder: (next: typeof tweaksResponder) => { tweaksResponder = next; },
	};
}

test("wrapper hides absent controls and shows malformed definitions without blocking mockup", async () => {
	const absent = await runWrapper(undefined);
	assert.equal(absent.panel.hidden, true);
	assert.match(absent.frame.src, /content\/\?revision=1#tweaks=token-1/);

	const malformed = await runWrapper({ controls: [] });
	assert.equal(malformed.panel.hidden, false);
	assert.match(malformed.window.document.querySelector("#tweak-error")!.textContent ?? "", /needs 1-32 controls/);
	assert.match(malformed.frame.src, /content\//, "invalid metadata does not prevent prototype load");
});

test("wrapper delivers initial state only after ready, not iframe load", async () => {
	const browser = await runWrapper(definition);
	const delivered: unknown[] = [];
	(browser.frame.contentWindow as any).postMessage = (message: unknown) => delivered.push(message);
	browser.frame.dispatchEvent(new browser.window.Event("load"));
	assert.equal(delivered.length, 0);
	const token = new URL(browser.frame.src).hash.slice("#tweaks=".length);
	browser.window.dispatchEvent(new browser.window.MessageEvent("message", {
		source: browser.frame.contentWindow, origin: "null", data: { channel: "visual-companion:tweaks", token, type: "ready" },
	}));
	assert.equal(delivered.length, 1);
	assert.deepEqual(JSON.parse(JSON.stringify((delivered[0] as any).values)), { layout: "cards", motion: true, density: 3 });
});

test("readiness probe preserves loading frame generation and helper handshake", async () => {
	const browser = await runWrapper(definition);
	const pending = deferred<ReturnType<typeof response>>();
	browser.setDocumentResponder(async () => pending.promise);
	const delivered: unknown[] = [];
	(browser.frame.contentWindow as any).postMessage = (message: unknown) => delivered.push(message);
	const src = browser.frame.src;
	const token = new URL(src).hash.slice("#tweaks=".length);
	browser.eventListeners.get("ready")!({});
	browser.frame.dispatchEvent(new browser.window.Event("load"));
	assert.equal(browser.frame.hidden, false);
	assert.equal((browser.window.document.querySelector("#status") as HTMLElement).hidden, true);
	browser.window.dispatchEvent(new browser.window.MessageEvent("message", {
		source: browser.frame.contentWindow, origin: "null", data: { channel: "visual-companion:tweaks", token, type: "ready" },
	}));
	assert.equal(delivered.length, 1, "helper ready remains valid during document probe");
	pending.resolve(response({ ok: true, document: { entry: "/prototype/index.html" } }));
	await turn();
	assert.equal(browser.frame.src, src);
});

test("readiness probe cannot consume delayed live reload intent", async () => {
	const browser = await runWrapper(definition);
	const reloadDocument = deferred<ReturnType<typeof response>>();
	const probeDocument = deferred<ReturnType<typeof response>>();
	let request = 0;
	browser.setDocumentResponder(async () => request++ === 0 ? reloadDocument.promise : probeDocument.promise);
	const src = browser.frame.src;
	browser.eventListeners.get("changed")!({ data: JSON.stringify({ ok: true }) });
	browser.eventListeners.get("ready")!({});
	probeDocument.resolve(response({ ok: true, document: { entry: "/prototype/index.html" } }));
	await turn();
	assert.notEqual(browser.frame.src, src, "latest probe carries pending reload");
	const reloadedSrc = browser.frame.src;
	reloadDocument.resolve(response({ ok: true, document: { entry: "/prototype/index.html" } }));
	await turn();
	assert.equal(browser.frame.src, reloadedSrc, "stale reload response cannot render again");
});

test("latest document request wins delayed out-of-order responses", async () => {
	const browser = await runWrapper(definition);
	const older = deferred<ReturnType<typeof response>>();
	const newer = deferred<ReturnType<typeof response>>();
	let request = 0;
	browser.setDocumentResponder(async () => request++ === 0 ? older.promise : newer.promise);
	browser.eventListeners.get("changed")!({ data: JSON.stringify({ ok: true }) });
	browser.eventListeners.get("changed")!({ data: JSON.stringify({ ok: true }) });
	newer.resolve(response({ ok: true, document: { entry: "/new/index.html" } }));
	await turn();
	older.resolve(response({ ok: true, document: { entry: "/stale/index.html" } }));
	await turn();
	assert.match(browser.frame.src, /token-2$/);
	assert.equal((browser.window.document.querySelector('select[data-key="layout"]') as HTMLSelectElement).value, "cards");
});

test("latest definition wins helper reload races and old-frame messages stay fenced", async () => {
	const browser = await runWrapper(definition);
	const older = deferred<ReturnType<typeof response>>();
	const newer = deferred<ReturnType<typeof response>>();
	let request = 0;
	browser.setTweaksResponder(async () => request++ === 0 ? older.promise : newer.promise);
	const oldToken = new URL(browser.frame.src).hash.slice("#tweaks=".length);
	const oldReload = { channel: "visual-companion:tweaks", token: oldToken, type: "reload" };
	browser.window.dispatchEvent(new browser.window.MessageEvent("message", { source: browser.frame.contentWindow, origin: "null", data: oldReload }));
	browser.window.dispatchEvent(new browser.window.MessageEvent("message", { source: browser.frame.contentWindow, origin: "null", data: oldReload }));
	assert.equal(request, 1, "pending reload invalidates old frame token");
	browser.eventListeners.get("changed")!({ data: JSON.stringify({ ok: true }) });
	await turn();
	assert.equal(request, 2);
	newer.resolve(response({ controls: [{ key: "fresh", label: "Fresh", type: "toggle", default: true }] }));
	await turn();
	older.resolve(response({ controls: [{ key: "stale", label: "Stale", type: "toggle", default: true }] }));
	await turn();
	assert.ok(browser.window.document.querySelector('[data-key="fresh"]'));
	assert.equal(browser.window.document.querySelector('[data-key="stale"]'), null);
});

test("same-artifact malformed metadata keeps compatible selections for recovery", async () => {
	const browser = await runWrapper(definition);
	const select = browser.window.document.querySelector('select[data-key="layout"]') as HTMLSelectElement;
	select.value = "table";
	select.dispatchEvent(new browser.window.Event("input", { bubbles: true }));
	browser.setTweaks({ controls: [] });
	browser.eventListeners.get("changed")!({ data: JSON.stringify({ ok: true }) });
	await turn();
	assert.match(browser.window.document.querySelector("#tweak-error")!.textContent ?? "", /needs 1-32 controls/);
	browser.setTweaks(definition);
	browser.eventListeners.get("changed")!({ data: JSON.stringify({ ok: true }) });
	await turn();
	assert.equal((browser.window.document.querySelector('select[data-key="layout"]') as HTMLSelectElement).value, "table");
});

test("wrapper composes controls, restores state, fences messages, and bounds reload loops", async () => {
	const browser = await runWrapper(definition);
	const select = browser.window.document.querySelector('select[data-key="layout"]') as HTMLSelectElement;
	select.value = "table";
	select.dispatchEvent(new browser.window.Event("input", { bubbles: true }));
	const firstSrc = browser.frame.src;
	const token = new URL(firstSrc).hash.slice("#tweaks=".length);
	const reload = { channel: "visual-companion:tweaks", token, type: "reload" };
	browser.window.dispatchEvent(new browser.window.MessageEvent("message", { source: browser.frame.contentWindow, origin: "https://foreign.test", data: reload }));
	assert.equal(browser.frame.src, firstSrc, "foreign origin is fenced");
	browser.window.dispatchEvent(new browser.window.MessageEvent("message", { source: browser.frame.contentWindow, origin: "null", data: reload }));
	await new Promise((resolveTurn) => setImmediate(resolveTurn));
	const reloadedSrc = browser.frame.src;
	assert.notEqual(reloadedSrc, firstSrc);
	assert.equal((browser.window.document.querySelector('select[data-key="layout"]') as HTMLSelectElement).value, "table");
	const nextToken = new URL(reloadedSrc).hash.slice("#tweaks=".length);
	browser.window.dispatchEvent(new browser.window.MessageEvent("message", { source: browser.frame.contentWindow, origin: "null", data: { ...reload, token: nextToken } }));
	await turn();
	assert.equal(browser.frame.src, reloadedSrc, "same combination cannot create reload loop");

	let currentSelect = browser.window.document.querySelector('select[data-key="layout"]') as HTMLSelectElement;
	currentSelect.value = "cards";
	currentSelect.dispatchEvent(new browser.window.Event("input", { bubbles: true }));
	currentSelect.value = "table";
	currentSelect.dispatchEvent(new browser.window.Event("input", { bubbles: true }));
	browser.window.dispatchEvent(new browser.window.MessageEvent("message", { source: browser.frame.contentWindow, origin: "null", data: { ...reload, token: nextToken } }));
	await turn();
	assert.notEqual(browser.frame.src, reloadedSrc, "A-B-A can request a fresh reload");

	let priorSrc = browser.frame.src;
	let currentToken = new URL(priorSrc).hash.slice("#tweaks=".length);
	(browser.window.document.querySelector("#tweak-reset") as HTMLButtonElement).click();
	currentSelect = browser.window.document.querySelector('select[data-key="layout"]') as HTMLSelectElement;
	currentSelect.value = "table";
	currentSelect.dispatchEvent(new browser.window.Event("input", { bubbles: true }));
	browser.window.dispatchEvent(new browser.window.MessageEvent("message", { source: browser.frame.contentWindow, origin: "null", data: { ...reload, token: currentToken } }));
	await turn();
	assert.notEqual(browser.frame.src, priorSrc, "reset clears reload deduplication after changing state");

	browser.setTweaks({ ...definition, controls: [{ ...definition.controls[0], options: [{ value: "cards", label: "Cards" }], default: "cards" }, ...definition.controls.slice(1)] });
	browser.eventListeners.get("changed")!({ data: JSON.stringify({ ok: true }) });
	await turn();
	browser.setTweaks(definition);
	browser.eventListeners.get("changed")!({ data: JSON.stringify({ ok: true }) });
	await turn();
	priorSrc = browser.frame.src;
	currentToken = new URL(priorSrc).hash.slice("#tweaks=".length);
	currentSelect = browser.window.document.querySelector('select[data-key="layout"]') as HTMLSelectElement;
	currentSelect.value = "table";
	currentSelect.dispatchEvent(new browser.window.Event("input", { bubbles: true }));
	browser.window.dispatchEvent(new browser.window.MessageEvent("message", { source: browser.frame.contentWindow, origin: "null", data: { ...reload, token: currentToken } }));
	await turn();
	assert.notEqual(browser.frame.src, priorSrc, "definition reconciliation clears stale reload deduplication");

	browser.setDocumentEntry("/other/index.html");
	browser.eventListeners.get("ready")!({});
	await new Promise((resolveTurn) => setImmediate(resolveTurn));
	assert.equal((browser.window.document.querySelector('select[data-key="layout"]') as HTMLSelectElement).value, "cards", "artifact switch clears prior selection");
});
