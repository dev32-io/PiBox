import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

class EventTargetMock {
	listeners = new Map<string, Array<(event: any) => void>>();
	addEventListener(type: string, listener: (event: any) => void) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	dispatch(type: string, event: Record<string, unknown> = {}) {
		for (const listener of this.listeners.get(type) ?? []) listener({ type, ...event });
	}
}

class ElementMock extends EventTargetMock {
	attributes = new Map<string, string>();
	dataset: Record<string, string> = {};
	hidden = false;
	disabled = false;
	tabIndex = 0;
	scrollTop = 0;
	textContent = "";
	focused = false;
	htmlWrites = 0;
	children = new Map<string, ElementMock>();
	#innerHTML = "";
	get innerHTML() { return this.#innerHTML; }
	set innerHTML(value: string) { this.#innerHTML = value; this.htmlWrites += 1; }
	setAttribute(name: string, value: string) { this.attributes.set(name, value); }
	querySelector(selector: string) { return this.children.get(selector)!; }
	focus() { this.focused = true; }
	replaceChildren() { this.#innerHTML = ""; this.textContent = ""; }
}

type PendingFetch = {
	signal: AbortSignal;
	resolve(response: { status: number; ok: boolean; json(): Promise<unknown> }): void;
	reject(error: Error): void;
};

type Notes = Record<"plan" | "ledger", { markdown: string; truncated?: boolean }>;

async function createBrowser() {
	const source = await readFile(resolve("extensions/visual-companion/scratch/assets/app.js"), "utf8");
	const windowEvents = new EventTargetMock();
	const documentEvents = new EventTargetMock() as EventTargetMock & { hidden: boolean; querySelector(selector: string): ElementMock };
	documentEvents.hidden = false;
	const elements = new Map<string, ElementMock>();
	for (const id of ["tab-plan", "tab-ledger", "status", "refresh"]) elements.set(`#${id}`, new ElementMock());
	for (const id of ["plan", "ledger"]) {
		const panel = new ElementMock();
		panel.children.set(".markdown", new ElementMock());
		panel.children.set(".note-state", new ElementMock());
		elements.set(`#panel-${id}`, panel);
	}
	documentEvents.querySelector = (selector) => elements.get(selector)!;

	const pending: PendingFetch[] = [];
	const fetchMock = (_url: string, options: { signal: AbortSignal }) => new Promise((resolveFetch, rejectFetch) => {
		pending.push({ signal: options.signal, resolve: resolveFetch as PendingFetch["resolve"], reject: rejectFetch });
	});
	class EventSourceMock extends EventTargetMock {
		static CLOSED = 2;
		static instances: EventSourceMock[] = [];
		readyState = 1;
		closed = false;
		constructor(public url: string) { super(); EventSourceMock.instances.push(this); }
		close() { this.closed = true; this.readyState = EventSourceMock.CLOSED; }
	}
	const parent = {};
	const context = vm.createContext({
		AbortController,
		EventSource: EventSourceMock,
		document: documentEvents,
		fetch: fetchMock,
		location: { origin: "http://companion.test" },
		parent,
		addEventListener: windowEvents.addEventListener.bind(windowEvents),
		__renderMarkdown: (markdown: string) => `<rendered>${markdown}</rendered>`,
	});
	new vm.Script(source.replace('import { renderMarkdown } from "./markdown.js";', "const renderMarkdown = __renderMarkdown;")).runInContext(context);
	await settle();

	const response = (body: Notes | undefined, status = 200) => ({
		status,
		ok: status >= 200 && status < 300,
		async json() {
			assert.ok(body, "a response without a notes body must not be parsed");
			return body;
		},
	});
	return {
		pending,
		events: EventSourceMock.instances,
		windowEvents,
		document: documentEvents,
		parent,
		element: (selector: string) => elements.get(selector)!,
		markdown: (id: "plan" | "ledger") => elements.get(`#panel-${id}`)!.querySelector(".markdown"),
		noteState: (id: "plan" | "ledger") => elements.get(`#panel-${id}`)!.querySelector(".note-state"),
		response,
	};
}

async function settle() {
	await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
}

const notes = (plan: string, ledger: string): Notes => ({ plan: { markdown: plan }, ledger: { markdown: ledger } });

test("live events refresh changed notes without disturbing selection or late user scroll", async () => {
	const browser = await createBrowser();
	assert.equal(browser.events.length, 1);
	assert.equal(browser.pending.length, 1, "initial activation fetches notes");
	browser.pending[0]!.resolve(browser.response(notes("plan one", "ledger one")));
	await settle();

	browser.element("#tab-ledger").dispatch("click");
	browser.markdown("plan").scrollTop = 10;
	browser.markdown("ledger").scrollTop = 20;
	browser.events[0]!.dispatch("ready");
	assert.equal(browser.pending.length, 2, "ready refreshes");
	browser.markdown("plan").scrollTop = 31;
	browser.markdown("ledger").scrollTop = 42;
	browser.pending[1]!.resolve(browser.response(notes("plan two", "ledger two")));
	await settle();
	assert.equal(browser.element("#tab-ledger").attributes.get("aria-selected"), "true");
	assert.equal(browser.element("#panel-ledger").hidden, false);
	assert.equal(browser.markdown("plan").scrollTop, 31);
	assert.equal(browser.markdown("ledger").scrollTop, 42);

	const writes = [browser.markdown("plan").htmlWrites, browser.markdown("ledger").htmlWrites];
	browser.events[0]!.dispatch("changed");
	assert.equal(browser.pending.length, 3, "changed refreshes");
	browser.pending[2]!.resolve(browser.response(notes("plan two", "ledger two")));
	await settle();
	assert.deepEqual([browser.markdown("plan").htmlWrites, browser.markdown("ledger").htmlWrites], writes, "identical notes do not rerender");
});

test("inactivity fences requests, while visibility and page activation reconnect and refresh", async () => {
	const browser = await createBrowser();
	const firstRequest = browser.pending[0]!;
	browser.windowEvents.dispatch("message", {
		origin: "http://companion.test", source: browser.parent,
		data: { type: "visual-companion:activity", active: false },
	});
	assert.equal(browser.events[0]!.closed, true);
	assert.equal(firstRequest.signal.aborted, true);
	firstRequest.resolve(browser.response(notes("stale private plan", "stale private ledger")));
	await settle();
	assert.equal(browser.markdown("plan").innerHTML, "", "an aborted generation cannot apply");

	browser.windowEvents.dispatch("message", {
		origin: "http://companion.test", source: browser.parent,
		data: { type: "visual-companion:activity", active: true },
	});
	assert.equal(browser.events.length, 2);
	assert.equal(browser.pending.length, 2, "reactivation refreshes");

	browser.document.hidden = true;
	browser.document.dispatch("visibilitychange");
	assert.equal(browser.events[1]!.closed, true);
	assert.equal(browser.pending[1]!.signal.aborted, true);
	browser.document.hidden = false;
	browser.document.dispatch("visibilitychange");
	assert.equal(browser.events.length, 3);
	assert.equal(browser.pending.length, 3);

	browser.windowEvents.dispatch("pagehide");
	assert.equal(browser.events[2]!.closed, true);
	assert.equal(browser.pending[2]!.signal.aborted, true);
	browser.windowEvents.dispatch("pageshow");
	assert.equal(browser.events.length, 4);
	assert.equal(browser.pending.length, 4, "pageshow reconnects and refreshes");
});

test("unavailable automatically follows a replacement binding and error recovery remains usable", async () => {
	const browser = await createBrowser();
	browser.pending[0]!.resolve(browser.response(notes("old plan", "old ledger")));
	await settle();

	browser.events[0]!.dispatch("unavailable");
	assert.equal(browser.events[0]!.closed, true);
	assert.equal(browser.pending.length, 2, "unavailable revalidates without user interaction");
	assert.equal(browser.markdown("plan").innerHTML, "", "old private notes are cleared immediately");
	browser.pending[1]!.resolve(browser.response(notes("replacement plan", "replacement ledger")));
	await settle();
	assert.match(browser.markdown("plan").innerHTML, /replacement plan/);
	assert.equal(browser.events.length, 2, "a valid replacement binding gets a fresh event source");

	browser.events[1]!.dispatch("error");
	assert.equal(browser.pending.length, 3, "stream errors revalidate notes");
	browser.pending[2]!.reject(new Error("offline"));
	await settle();
	assert.match(browser.markdown("plan").innerHTML, /replacement plan/, "a transient error retains loaded notes");
	assert.equal(browser.element("#status").dataset.state, "error");

	browser.element("#refresh").dispatch("click");
	browser.pending[3]!.resolve(browser.response(notes("manual recovery", "ledger recovery")));
	await settle();
	assert.match(browser.markdown("plan").innerHTML, /manual recovery/);
	assert.equal(browser.element("#status").textContent, "Scratch notes refreshed.");
});

test("unavailable fences stale fetches and a notes 404 stays cleared and disconnected", async () => {
	const browser = await createBrowser();
	browser.pending[0]!.resolve(browser.response(notes("private plan", "private ledger")));
	await settle();
	browser.events[0]!.dispatch("changed");
	const stale = browser.pending[1]!;

	browser.events[0]!.dispatch("unavailable");
	assert.equal(stale.signal.aborted, true);
	assert.equal(browser.pending.length, 3, "unavailable starts exactly one current-binding check");
	assert.equal(browser.markdown("plan").innerHTML, "");
	stale.resolve(browser.response(notes("stale private plan", "stale private ledger")));
	await settle();
	assert.equal(browser.markdown("plan").innerHTML, "", "the stale generation cannot repopulate cleared notes");

	browser.pending[2]!.resolve(browser.response(undefined, 404));
	await settle();
	assert.equal(browser.events.length, 1, "a precise notes 404 does not reconnect live updates");
	assert.equal(browser.markdown("plan").innerHTML, "");
	assert.equal(browser.markdown("ledger").innerHTML, "");
	assert.equal(browser.noteState("plan").textContent, "Scratch notes are no longer available for this session.");
	assert.equal(browser.element("#status").textContent, "Scratch notes are unavailable.");

	browser.element("#refresh").dispatch("click");
	assert.equal(browser.events.length, 2, "manual Refresh reconnects after a genuine 404");
	assert.equal(browser.markdown("plan").innerHTML, "", "notes stay cleared while manual Refresh is pending");
	browser.pending[3]!.resolve(browser.response(notes("manual plan", "manual ledger")));
	await settle();
	assert.match(browser.markdown("plan").innerHTML, /manual plan/);
});
