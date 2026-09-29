import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";

const assets = resolve("extensions/visual-companion/scratch/assets");
const tick = () => new Promise<void>((done) => setTimeout(done, 10));
async function browser({ timers = false, markdown = false } = {}) {
  const html = await readFile(resolve(assets, "index.html"), "utf8");
  const app = await readFile(resolve(assets, "app.js"), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost/v/scratch/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const requests: Array<{ url: string; resolve: (value: unknown) => void }> = [];
  const streams: Array<{ url: string; closed: boolean; dispatch: (type: string) => void }> = [];
  const scheduled = new Map<number, { fn: () => void; delay: number }>();
  let nextTimer = 1_000_000;
  if (timers) {
    const set = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window);
    window.setTimeout = ((fn: () => void, delay: number) => delay >= 120 ? (scheduled.set(++nextTimer, { fn, delay }), nextTimer) : set(fn, delay)) as typeof window.setTimeout;
    window.clearTimeout = ((id: number) => { scheduled.delete(id); clear(id); }) as typeof window.clearTimeout;
  }
  window.matchMedia = (() => ({ matches: false, addEventListener() {} })) as unknown as typeof window.matchMedia;
  window.ResizeObserver = class { observe() {} disconnect() {} } as typeof window.ResizeObserver;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.requestAnimationFrame = (fn) => { fn(0); return 1; };
  class TreeItem extends window.HTMLElement {
    connectedCallback() {
      this.tabIndex = -1;
      if (this.parentElement?.localName === 'wa-tree-item' && this.expanded) this.expanded = false;
    }
    get expanded() { return this.hasAttribute("expanded"); }
    set expanded(value: boolean) {
      if (this.expanded === value) return;
      this.toggleAttribute("expanded", value);
      this.dispatchEvent(new window.Event(value ? "wa-expand" : "wa-collapse", { bubbles: true }));
    }
    get selected() { return this.hasAttribute("selected"); }
    set selected(value: boolean) { this.toggleAttribute("selected", value); }
  }
  class Tree extends window.HTMLElement {
    connectedCallback() {
      this.addEventListener('click', (event) => {
        const item = (event.target as Element).closest('wa-tree-item') as TreeItem | null;
        if (item?.classList.contains('folder')) item.expanded = !item.expanded;
      });
    }
  }
  class TabGroup extends window.HTMLElement {
    active = "";
    updateComplete = Promise.resolve();
    syncTabsAndPanels() {}
    updateActiveTab() {
      const prior = this.querySelector('wa-tab[active]')?.getAttribute('panel');
      this.querySelectorAll('wa-tab').forEach((tab, i) => {
        tab.id ||= `tab-${i}`;
        const panel = [...this.querySelectorAll('wa-tab-panel')].find((p) => p.getAttribute('name') === tab.getAttribute('panel'))! as Panel;
        panel.id ||= `panel-${i}`;
        panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id);
        tab.setAttribute('aria-controls', panel.id);
        tab.toggleAttribute('active', tab.getAttribute('panel') === this.active);
        panel.active = tab.hasAttribute('active');
        panel.setAttribute('aria-hidden', String(!panel.active));
      });
      if (prior !== this.active) this.dispatchEvent(Object.assign(new window.Event('wa-tab-show'), { detail: { name: this.active } }));
    }
  }
  class Tab extends window.HTMLElement { set panel(value: string) { this.setAttribute('panel', value); } }
  class Panel extends window.HTMLElement {
    updateComplete = Promise.resolve();
    get active() { return this.hasAttribute('active'); }
    set active(value: boolean) { this.toggleAttribute('active', value); }
    set name(value: string) { this.setAttribute('name', value); }
  }
  window.customElements.define("wa-tree-item", TreeItem);
  window.customElements.define("wa-tree", Tree);
  window.customElements.define("wa-tab-group", TabGroup);
  window.customElements.define("wa-tab", Tab);
  window.customElements.define("wa-tab-panel", Panel);
  window.customElements.define("wa-split-panel", class extends window.HTMLElement { positionInPixels = 268; disabled = false; });
  window.fetch = ((url: string) => new Promise((resolve) => requests.push({ url, resolve: resolve as (value: unknown) => void }))) as typeof window.fetch;
  window.EventSource = class extends window.EventTarget {
    entry: (typeof streams)[number];
    constructor(public url: string) { super(); this.entry = { url, closed: false, dispatch: (type) => this.dispatchEvent(new window.Event(type)) }; streams.push(this.entry); }
    close() { this.entry.closed = true; }
  } as typeof window.EventSource;
  window.eval(app.replace("import './webawesome.min.js';", "").replace("import { renderMarkdown } from './markdown.js';", markdown
    ? "const renderMarkdown = text => `<p>${text.replaceAll('<', '&lt;').replaceAll('**format**', '<strong>format</strong>')}</p>`;"
    : "const renderMarkdown = text => `<p>${text.replaceAll('<', '&lt;')}</p>`;"));
  const reply = async (index: number, body: unknown, status = 200) => {
    requests[index]!.resolve({ ok: status === 200, status, json: async () => body });
    await tick();
  };
  const advance = async () => {
    const pending = [...scheduled].filter(([, task]) => task.delay === 120);
    for (const [id, task] of pending) { scheduled.delete(id); task.fn(); }
    await tick();
  };
  return { window, document: window.document, requests, streams, reply, advance, close: () => dom.window.close() };
}
function selectTab(b: Awaited<ReturnType<typeof browser>>, path: string) {
  const group = b.document.querySelector('#tabs')! as HTMLElement & { active: string };
  group.active = path;
  group.dispatchEvent(Object.assign(new b.window.Event('wa-tab-show'), { detail: { name: path } }));
}
const tree = (entries: unknown[], identity = "session-a") => ({ identity, kind: "directory", entries, nextCursor: null });
const text = (content: string, identity = "session-a") => ({ identity, kind: "text", content, version: content });
async function ready(b: Awaited<ReturnType<typeof browser>>) {
  await b.reply(0, tree([{ name: "docs", kind: "directory" }, { name: "plan.md", kind: "file" }, { name: "ledger.md", kind: "file" }]));
  await b.reply(1, text("# Plan one"));
  await b.reply(2, text("Ledger one"));
  assert.equal(b.streams.length, 1);
}

test("folder row toggles once; collapsed children remain invisible and sidebar inert", async () => {
  const b = await browser();
  try {
    await ready(b);
    const folder = b.document.querySelector<HTMLElement>('wa-tree-item[data-path="docs"]')!;
    // Model Web Awesome `selection=leaf` row activation; app must not toggle twice.
    folder.click();
    assert.equal(folder.hasAttribute("expanded"), true);
    assert.equal(b.requests.length, 4);
    await b.reply(3, tree([{ name: "docs", kind: "directory" }, { name: "plan.md", kind: "file" }, { name: "ledger.md", kind: "file" }]));
    await b.reply(4, tree([{ name: "readme.md", kind: "file" }]));
    await b.reply(5, text("# Plan one"));
    await b.reply(6, text("Ledger one"));
    assert.ok(b.document.querySelector('[data-path="docs/readme.md"]'));
    const current = b.document.querySelector<HTMLElement>('wa-tree-item[data-path="docs"]')!;
    current.click();
    assert.equal(b.document.querySelector('[data-path="docs/readme.md"]'), null);
    const files = b.document.querySelector<HTMLElement>('#files-toggle')!;
    files.click();
    assert.equal(b.document.querySelector<HTMLElement>('.sidebar')!.inert, true);
    assert.equal(b.document.querySelector<HTMLElement>('.sidebar')!.getAttribute('aria-hidden'), 'true');
    assert.equal(files.getAttribute('aria-expanded'), 'false');
    assert.equal(b.document.activeElement, files);
    files.click();
    assert.equal(files.getAttribute('aria-expanded'), 'true');
    assert.equal(b.document.activeElement?.localName, 'wa-tree-item');
    assert.equal(b.document.querySelector('.topbar, #collapse, #show-sidebar, #session-id'), null);
  } finally { b.close(); }
});

test("tabs deduplicate, find visible text, preserve query; live files refresh inactive and stale switch clears", async () => {
  const b = await browser();
  try {
    await ready(b);
    const node = b.document.querySelector<HTMLElement>('wa-tree-item[data-path="plan.md"]')!;
    b.document.querySelector<HTMLElement>('#find-toggle')!.click();
    const input = b.document.querySelector<HTMLInputElement>('#find-input')!;
    input.value = 'Plan'; input.dispatchEvent(new b.window.Event('input'));
    assert.equal(b.document.querySelector('#match-count')!.textContent, '1 of 1');
    assert.equal(b.document.querySelectorAll('mark').length, 1);
    // Open nested file after expansion via Web Awesome selection event.
    const folder = b.document.querySelector<HTMLElement>('wa-tree-item[data-path="docs"]')! as HTMLElement & { expanded: boolean };
    folder.expanded = true;
    await b.reply(3, tree([{ name: "docs", kind: "directory" }, { name: "plan.md", kind: "file" }, { name: "ledger.md", kind: "file" }]));
    await b.reply(4, tree([{ name: "readme.md", kind: "file" }]));
    await b.reply(5, text("# Plan one")); await b.reply(6, text("Ledger one"));
    const nested = b.document.querySelector<HTMLElement>('wa-tree-item[data-path="docs/readme.md"]')!;
    const selection = new b.window.Event('wa-selection-change') as Event & { detail: unknown };
    selection.detail = { selection: [nested] }; b.document.querySelector('#file-tree')!.dispatchEvent(selection);
    assert.equal(b.requests.length, 8);
    await b.reply(7, tree([{ name: "docs", kind: "directory" }, { name: "plan.md", kind: "file" }, { name: "ledger.md", kind: "file" }]));
    await b.reply(8, tree([{ name: "readme.md", kind: "file" }]));
    await b.reply(9, text("# Plan one")); await b.reply(10, text("Ledger one"));
    await b.reply(11, text("Nested note"));
    b.document.querySelector('#file-tree')!.dispatchEvent(selection);
    assert.equal(b.document.querySelectorAll('wa-tab[panel="docs/readme.md"]').length, 1);
    selectTab(b, 'plan.md');
    assert.equal(input.value, 'Plan');
    assert.ok(node);
    b.streams.at(-1)!.dispatch('changed');
    await new Promise((done) => setTimeout(done, 160));
    const next = b.requests.length - 1;
    await b.reply(next, tree([{ name: "docs", kind: "directory" }, { name: "plan.md", kind: "file" }, { name: "ledger.md", kind: "file" }]));
    await b.reply(next + 1, tree([{ name: "readme.md", kind: "file" }]));
    await b.reply(next + 2, text("# Plan updated"));
    await b.reply(next + 3, text("Ledger updated"));
    await b.reply(next + 4, text("Nested updated"));
    assert.match(b.document.querySelector('#document-scroll')!.textContent!, /Plan updated/);
    selectTab(b, 'docs/readme.md');
    assert.match(b.document.querySelector('#document-scroll')!.textContent!, /Nested updated/, 'inactive tab refreshed');
    b.document.querySelector<HTMLElement>('#refresh')!.click();
    await b.reply(b.requests.length - 1, tree([], 'session-b'));
    assert.equal(b.document.querySelector('wa-tab[panel="docs/readme.md"]'), null);
    assert.doesNotMatch(b.document.querySelector('#document-scroll')!.textContent!, /Plan updated|Nested updated/);
  } finally { b.close(); }
});

test("oversized watch URL retains binding stream and clears old session on invalidation", async () => {
  const b = await browser({ timers: true });
  try {
    const names = Array.from({ length: 41 }, (_, i) => `note-${String(i).padStart(2, '0')}-${'x'.repeat(190)}.txt`);
    const entries = [...names.map((name) => ({ name, kind: 'file' })), { name: 'plan.md', kind: 'file' }, { name: 'ledger.md', kind: 'file' }];
    await b.reply(0, tree(entries));
    await b.reply(1, text('Old private plan'));
    await b.reply(2, text('Old private ledger'));
    for (const name of names) {
      const selected = b.document.querySelector<HTMLElement>(`wa-tree-item[data-path="${name}"]`)!;
      b.document.querySelector('#file-tree')!.dispatchEvent(Object.assign(new b.window.Event('wa-selection-change'), { detail: { selection: [selected] } }));
    }
    assert.equal(b.document.querySelectorAll('wa-tab').length, names.length + 2);
    const lastRoot = b.requests.length - 1;
    await b.reply(lastRoot, tree(entries));
    for (let i = 0; i < names.length + 2; i++) await b.reply(lastRoot + 1 + i, text(i === names.length + 1 ? 'Old private ledger' : 'Old private plan'));
    const stream = b.streams.at(-1)!;
    assert.equal(new URL(stream.url, 'http://localhost').search, '', 'oversized scope falls back to binding-only subscription');
    assert.equal(stream.closed, false);
    assert.match(b.document.querySelector('#status')!.textContent!, /Refresh/);
    stream.dispatch('changed');
    await b.advance();
    assert.match(b.requests.at(-1)!.url, /api\/tree/, 'root changes still request a binding check');
    stream.dispatch('unavailable');
    assert.equal(stream.closed, true);
    assert.equal(b.document.querySelectorAll('wa-tab').length, 2);
    assert.doesNotMatch(b.document.querySelector('#document-scroll')!.textContent!, /Old private/);
    await b.advance();
    assert.match(b.requests.at(-1)!.url, /api\/tree/);
  } finally { b.close(); }
});

test("binding replacement fences late file responses and removes private tabs", async () => {
  const b = await browser();
  try {
    await ready(b);
    b.document.querySelector<HTMLElement>('#refresh')!.click();
    await b.reply(3, tree([{ name: 'plan.md', kind: 'file' }, { name: 'ledger.md', kind: 'file' }]));
    const lateFile = b.requests[4]!;
    b.document.querySelector<HTMLElement>('#refresh')!.click();
    await b.reply(5, tree([], 'session-b'));
    lateFile.resolve({ ok: true, json: async () => text('Old private data') });
    await tick();
    assert.doesNotMatch(b.document.querySelector('#document-scroll')!.textContent!, /Old private data|Plan one/);
    assert.equal(b.document.querySelector('#session-id'), null);
    assert.equal(b.document.querySelectorAll('wa-tab').length, 2);
  } finally { b.close(); }
});

test("native image uses versioned identity URL, fit/actual and decode failure state", async () => {
  const b = await browser();
  try {
    const entries = [{ name: 'photo.png', kind: 'file' }, { name: 'plan.md', kind: 'file' }, { name: 'ledger.md', kind: 'file' }];
    await b.reply(0, tree(entries));
    await b.reply(1, text('Plan')); await b.reply(2, text('Ledger'));
    const selected = b.document.querySelector<HTMLElement>('wa-tree-item[data-path="photo.png"]')!;
    b.document.querySelector('#file-tree')!.dispatchEvent(Object.assign(new b.window.Event('wa-selection-change'), { detail: { selection: [selected] } }));
    await b.reply(3, tree(entries));
    await b.reply(4, text('Plan')); await b.reply(5, text('Ledger'));
    await b.reply(6, { identity: 'session-a', kind: 'image', type: 'image/png', version: 'v1', url: '/v/scratch/api/image?path=photo.png&version=v1&identity=session-a' });
    const image = b.document.querySelector<HTMLImageElement>('#document-scroll img')!;
    assert.match(image.src, /version=v1&identity=session-a/);
    b.document.querySelector<HTMLElement>('#actual')!.click();
    assert.ok(b.document.querySelector('.image-frame.actual'));
    assert.equal((b.document.querySelector<HTMLButtonElement>('#find-toggle')!).disabled, true);
    b.document.querySelector<HTMLImageElement>('#document-scroll img')!.dispatchEvent(new b.window.Event('error'));
    assert.match(b.document.querySelector('#document-scroll')!.textContent!, /could not be decoded/);
  } finally { b.close(); }
});

test("hidden workspace masks old content until visible binding is revalidated", async () => {
  const b = await browser();
  try {
    await ready(b);
    assert.match(b.document.querySelector('#document-scroll')!.textContent!, /Plan one/);
    Object.defineProperty(b.document, 'hidden', { configurable: true, value: true });
    b.document.dispatchEvent(new b.window.Event('visibilitychange'));
    assert.equal(b.streams.at(-1)!.closed, true);
    assert.doesNotMatch(b.document.querySelector('#document-scroll')!.textContent!, /Plan one/);
    Object.defineProperty(b.document, 'hidden', { configurable: true, value: false });
    b.document.dispatchEvent(new b.window.Event('visibilitychange'));
    await b.reply(3, tree([{ name: 'plan.md', kind: 'file' }, { name: 'ledger.md', kind: 'file' }]));
    await b.reply(4, text('# Plan one')); await b.reply(5, text('Ledger one'));
    assert.match(b.document.querySelector('#document-scroll')!.textContent!, /Plan one/);
  } finally { b.close(); }
});

test('identity resets recover hidden and visible switches, plus unavailable rebinding without manual refresh', async () => {
  const b = await browser({ timers: true });
  try {
    await ready(b);
    Object.defineProperty(b.document, 'hidden', { configurable: true, value: true });
    b.document.dispatchEvent(new b.window.Event('visibilitychange'));
    Object.defineProperty(b.document, 'hidden', { configurable: true, value: false });
    b.document.dispatchEvent(new b.window.Event('visibilitychange'));
    await b.reply(3, tree([], 'session-b'));
    assert.doesNotMatch(b.document.querySelector('#document-scroll')!.textContent!, /Plan one/);
    await b.advance();
    await b.reply(4, tree([{ name: 'plan.md', kind: 'file' }, { name: 'ledger.md', kind: 'file' }], 'session-b'));
    await b.reply(5, text('Plan B', 'session-b')); await b.reply(6, text('Ledger B', 'session-b'));
    assert.match(b.document.querySelector('#document-scroll')!.textContent!, /Plan B/);
    b.document.querySelector<HTMLElement>('#refresh')!.click();
    await b.reply(7, { identity: null, kind: 'unavailable', entries: [], nextCursor: null });
    await b.advance();
    await b.reply(8, { identity: null, kind: 'unavailable', entries: [], nextCursor: null });
    assert.match(b.document.querySelector('#tree-state')!.textContent!, /not available/);
    b.document.querySelector<HTMLElement>('#refresh')!.click();
    await b.reply(9, tree([], 'session-c'));
    await b.advance();
    await b.reply(10, tree([], 'session-c'));
    await b.reply(11, text('Plan C', 'session-c')); await b.reply(12, text('Ledger C', 'session-c'));
    assert.match(b.document.querySelector('#document-scroll')!.textContent!, /Plan C/);
    assert.equal(b.document.querySelectorAll('wa-tab').length, 2);
    // A visible binding switch must also initiate its own fresh generation.
    b.document.querySelector<HTMLElement>('#refresh')!.click();
    await b.reply(13, tree([], 'session-d'));
    await b.advance();
    await b.reply(14, tree([], 'session-d'));
    await b.reply(15, text('Plan D', 'session-d')); await b.reply(16, text('Ledger D', 'session-d'));
    assert.match(b.document.querySelector('#document-scroll')!.textContent!, /Plan D/);
  } finally { b.close(); }
});

test('first ready and native reconnect reconcile missed atomic writes, without stream churn or polling', async () => {
  const b = await browser({ timers: true });
  try {
    await ready(b);
    const stream = b.streams[0]!;
    stream.dispatch('ready'); // Snapshot was taken before watcher became ready.
    await b.advance();
    await b.reply(3, tree([{ name: 'docs', kind: 'directory' }, { name: 'plan.md', kind: 'file' }, { name: 'ledger.md', kind: 'file' }]));
    await b.reply(4, text('Atomic Plan')); await b.reply(5, text('Ledger one'));
    assert.match(b.document.querySelector('#document-scroll')!.textContent!, /Atomic Plan/);
    assert.equal(b.streams.length, 1);
    stream.dispatch('ready'); // Browser's EventSource re-established same subscription.
    await b.advance();
    await b.reply(6, tree([{ name: 'docs', kind: 'directory' }, { name: 'plan.md', kind: 'file' }, { name: 'ledger.md', kind: 'file' }]));
    await b.reply(7, text('Native reconnect')); await b.reply(8, text('Ledger one'));
    assert.match(b.document.querySelector('#document-scroll')!.textContent!, /Native reconnect/);
    assert.equal(b.streams.length, 1);
    await b.advance(); assert.equal(b.requests.length, 9, 'quiet stream must not poll');
    const folder = b.document.querySelector<HTMLElement>('wa-tree-item[data-path="docs"]')! as HTMLElement & { expanded: boolean };
    folder.expanded = true;
    await b.reply(9, tree([{ name: 'docs', kind: 'directory' }, { name: 'plan.md', kind: 'file' }, { name: 'ledger.md', kind: 'file' }]));
    await b.reply(10, tree([])); await b.reply(11, text('Native reconnect')); await b.reply(12, text('Ledger one'));
    assert.equal(b.streams.length, 2, 'scope change creates new stream');
    b.streams[1]!.dispatch('ready');
    await b.advance();
    await b.reply(13, tree([{ name: 'docs', kind: 'directory' }, { name: 'plan.md', kind: 'file' }, { name: 'ledger.md', kind: 'file' }]));
    await b.reply(14, tree([{ name: 'new.md', kind: 'file' }])); await b.reply(15, text('Native reconnect')); await b.reply(16, text('Ledger one'));
    assert.ok(b.document.querySelector('[data-path="docs/new.md"]'));
    assert.equal(b.streams.length, 2);
    await b.advance(); assert.equal(b.requests.length, 17);
  } finally { b.close(); }
});

test('dense find has explicit cap; Unicode and formatting-spanning literal marks retain navigation', async () => {
  const b = await browser({ markdown: true });
  try {
    await b.reply(0, tree([]));
    await b.reply(1, text('Cross **format** boundary. Cross **format** boundary. İ i 😀. <script>not executable</script>'));
    await b.reply(2, text('Ledger'));
    b.document.querySelector<HTMLElement>('#find-toggle')!.click();
    const input = b.document.querySelector<HTMLInputElement>('#find-input')!;
    const find = (query: string) => { input.value = query; input.dispatchEvent(new b.window.Event('input')); };
    find('Cross format boundary');
    assert.equal(b.document.querySelector('#match-count')!.textContent, '1 of 2');
    assert.equal(b.document.querySelectorAll('mark').length, 6);
    assert.equal(b.document.querySelectorAll('mark.current-match').length, 3);
    b.document.querySelector<HTMLElement>('#next')!.click();
    assert.equal(b.document.querySelectorAll('mark.current-match').length, 3);
    assert.equal(b.document.querySelector('#match-count')!.textContent, '2 of 2');
    b.document.querySelector<HTMLElement>('#next')!.click();
    assert.equal(b.document.querySelector('#match-count')!.textContent, '1 of 2');
    b.document.querySelector<HTMLElement>('#previous')!.click();
    assert.equal(b.document.querySelector('#match-count')!.textContent, '2 of 2');
    input.dispatchEvent(new b.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    assert.equal(b.document.querySelector('#match-count')!.textContent, '1 of 2');
    find('😀.'); assert.equal(b.document.querySelector('mark')?.textContent, '😀.');
    find('i'); assert.equal(b.document.querySelector('mark')?.textContent, 'i'); // İ must not shift UTF-16 offsets.
    b.document.querySelector<HTMLElement>('#case')!.click();
    find('İ'); assert.equal(b.document.querySelector('#match-count')!.textContent, '1 of 1');
    find('*.('); assert.equal(b.document.querySelector('#match-count')!.textContent, 'No results');
    b.document.querySelector<HTMLElement>('#close-find')!.click();
    b.document.querySelector<HTMLElement>('#refresh')!.click();
    await b.reply(3, tree([])); await b.reply(4, text('a'.repeat(1024 * 1024))); await b.reply(5, text('Ledger'));
    b.document.querySelector<HTMLElement>('#find-toggle')!.click(); find('a');
    assert.equal(b.document.querySelectorAll('mark').length, 500);
    assert.match(b.document.querySelector('#match-count')!.textContent!, /500\+ \(match limit\)/);
    b.document.querySelector<HTMLElement>('#close-find')!.click();
    b.document.querySelector<HTMLElement>('#refresh')!.click();
    await b.reply(6, tree([])); await b.reply(7, text('**format**'.repeat(1200))); await b.reply(8, text('Ledger'));
    b.document.querySelector<HTMLElement>('#find-toggle')!.click(); find('format'.repeat(1200));
    assert.equal(b.document.querySelectorAll('mark').length, 500, 'one cross-node match cannot create unbounded marks');
    assert.match(b.document.querySelector('#match-count')!.textContent!, /match limit/);
  } finally { b.close(); }
});

test('active Web Awesome tabpanel owns visible document and labels it once', async () => {
  const b = await browser();
  try {
    await ready(b);
    await tick();
    const tab = b.document.querySelector('wa-tab[active]')!;
    const panel = b.document.getElementById(tab.getAttribute('aria-controls')!)!;
    assert.equal(panel.getAttribute('aria-labelledby'), tab.id);
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(panel.getAttribute('aria-hidden'), 'false');
    assert.ok(panel.contains(b.document.querySelector('#document-scroll')));
    assert.match(panel.textContent!, /Plan one/);
    b.document.querySelector<HTMLElement>('#document-scroll')!.scrollTop = 211;
    selectTab(b, 'ledger.md');
    await tick();
    assert.equal(b.document.querySelectorAll('wa-tab-panel #document-scroll').length, 1);
    assert.equal(panel.getAttribute('aria-hidden'), 'true');
    const ledger = b.document.querySelector('wa-tab[active]')!;
    assert.ok(b.document.getElementById(ledger.getAttribute('aria-controls')!)!.contains(b.document.querySelector('#document-scroll')));
    selectTab(b, 'plan.md');
    await tick();
    assert.equal(b.document.querySelector<HTMLElement>('#document-scroll')!.scrollTop, 211);
  } finally { b.close(); }
});

test('rapid tab changes and active close retain saved scroll; stale activation cannot steal view', async () => {
  const b = await browser();
  try {
    await b.reply(0, tree([{ name: 'note.txt', kind: 'file' }, { name: 'plan.md', kind: 'file' }, { name: 'ledger.md', kind: 'file' }]));
    await b.reply(1, text('Plan'.repeat(500))); await b.reply(2, text('Ledger'));
    const scroll = b.document.querySelector<HTMLElement>('#document-scroll')!;
    scroll.scrollTop = 420;
    selectTab(b, 'ledger.md'); selectTab(b, 'plan.md'); selectTab(b, 'ledger.md'); selectTab(b, 'plan.md');
    await tick();
    assert.equal(scroll.scrollTop, 420);
    selectTab(b, 'ledger.md'); selectTab(b, 'plan.md');
    const group = b.document.querySelector('#tabs')!;
    group.dispatchEvent(Object.assign(new b.window.Event('wa-tab-show'), { detail: { name: 'ledger.md' } }));
    await tick();
    assert.ok(b.document.querySelector('wa-tab[panel="plan.md"]')!.hasAttribute('active'));
    assert.equal(scroll.scrollTop, 420);
    const selected = b.document.querySelector<HTMLElement>('wa-tree-item[data-path="note.txt"]')!;
    b.document.querySelector('#file-tree')!.dispatchEvent(Object.assign(new b.window.Event('wa-selection-change'), { detail: { selection: [selected] } }));
    await b.reply(3, tree([{ name: 'note.txt', kind: 'file' }, { name: 'plan.md', kind: 'file' }, { name: 'ledger.md', kind: 'file' }]));
    await b.reply(4, text('Plan'.repeat(500))); await b.reply(5, text('Ledger')); await b.reply(6, text('Note'));
    b.document.querySelector<HTMLElement>('wa-tab[panel="note.txt"] .tab-close')!.click();
    await tick();
    assert.equal(b.document.querySelector('wa-tab[panel="note.txt"]'), null);
    selectTab(b, 'plan.md'); await tick();
    assert.equal(scroll.scrollTop, 420);
  } finally { b.close(); }
});

test('expanded nested folder survives rebuilt tree and sibling remains separate', async () => {
  const b = await browser();
  const root = [{ name: 'docs', kind: 'directory' }, { name: 'plan.md', kind: 'file' }, { name: 'ledger.md', kind: 'file' }];
  const children = [{ name: 'deep', kind: 'directory' }, { name: 'research.md', kind: 'file' }];
  try {
    await ready(b);
    (b.document.querySelector('wa-tree-item[data-path="docs"]') as HTMLElement & { expanded: boolean }).expanded = true;
    await b.reply(3, tree(root)); await b.reply(4, tree(children));
    await b.reply(5, text('Plan')); await b.reply(6, text('Ledger'));
    (b.document.querySelector('wa-tree-item[data-path="docs/deep"]') as HTMLElement & { expanded: boolean }).expanded = true;
    await b.reply(7, tree(root)); await b.reply(8, tree(children)); await b.reply(9, tree([{ name: 'config.json', kind: 'file' }]));
    await b.reply(10, text('Plan')); await b.reply(11, text('Ledger'));
    const nested = b.document.querySelector('wa-tree-item[data-path="docs/deep"]')!;
    assert.ok(nested.hasAttribute('expanded'));
    assert.ok(b.document.querySelector('wa-tree-item[data-path="docs/deep/config.json"]'));
    assert.ok(b.document.querySelector('wa-tree-item[data-path="docs/research.md"]'));
    b.document.querySelector<HTMLElement>('#refresh')!.click();
    await b.reply(12, tree(root)); await b.reply(13, tree(children)); await b.reply(14, tree([{ name: 'config.json', kind: 'file' }, { name: 'new.json', kind: 'file' }]));
    await b.reply(15, text('Plan')); await b.reply(16, text('Ledger'));
    assert.ok(b.document.querySelector('wa-tree-item[data-path="docs/deep"]')!.hasAttribute('expanded'));
    assert.ok(b.document.querySelector('wa-tree-item[data-path="docs/deep/new.json"]'));
  } finally { b.close(); }
});
