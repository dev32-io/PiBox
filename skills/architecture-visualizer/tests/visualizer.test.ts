import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LikeC4Model } from "@likec4/core/model";
import { createArchitectureViewer, loadDocument } from "../scripts/server.mjs";
import { createVisualCompanionBackend } from "../../../extensions/visual-companion/backend.mjs";

const source = `
specification { element component }
model {
  system = component 'Order platform' {
    api = component 'Order API'
    db = component 'Database'
    api -> db 'writes'
  }
}
views {
  view overview { include system with { navigateTo detail } }
  view detail of system { include system, system.* }
}`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "architecture-native-"));
  const artifact = join(directory, "architecture.c4");
  await writeFile(artifact, source);
  return { directory, artifact, close: () => rm(directory, { recursive: true, force: true }) };
}

test("native parser/layout roundtrip preserves containment, navigation and source revision; invalid and legacy source diagnose without mutation", async () => {
  const f = await fixture();
  try {
    const valid = await loadDocument(f.artifact);
    assert.equal(valid.ok, true, valid.errors.join("\n"));
    const document = JSON.parse(JSON.stringify(valid.document));
    assert.match(document.revision, /^[a-f0-9]{64}$/);
    const model = LikeC4Model.create(document.model);
    assert.ok(model.findView("detail"));
    assert.equal(model.view("overview").$view.nodes[0]?.navigateTo, "detail");
    assert.ok(model.view("detail").$view.nodes.some(node => node.id === "system.api"));
    await writeFile(f.artifact, source.replace("Order API", "Changed API"));
    const changed = await loadDocument(f.artifact);
    assert.equal(changed.ok, true);
    assert.notEqual((changed.document as any).revision, document.revision);
    await writeFile(f.artifact, "model { broken =");
    const invalid = await loadDocument(f.artifact);
    assert.equal(invalid.ok, false);
    assert.match(invalid.errors.join("\n"), /Line \d+/);
    const legacy = join(f.directory, "legacy.json");
    const json = '{"views":[]}';
    await writeFile(legacy, json);
    assert.match((await loadDocument(legacy)).errors.join("\n"), /Preserve this legacy JSON; reauthor/);
    assert.equal(await readFile(legacy, "utf8"), json);
  } finally { await f.close(); }
});

test("registered architecture watches same-file edits, preserves last-valid through errors, and recovers", async () => {
  const f = await fixture();
  const backend = await createVisualCompanionBackend({ viewers: [createArchitectureViewer()] });
  try {
    const shown = await backend.show({ viewerId: "architecture", artifactPath: f.artifact });
    assert.equal(shown.valid, true);
    const url = `${shown.viewerUrl}api/document`;
    const initial = await fetch(url).then(response => response.json());
    const until = async (predicate: (value: any) => boolean) => {
      for (let i = 0; i < 100; i++) {
        const value = await fetch(url).then(response => response.json());
        if (predicate(value)) return value;
        await new Promise(done => setTimeout(done, 30));
      }
      assert.fail("watch result did not settle");
    };
    await writeFile(f.artifact, "model { broken =");
    const invalid = await until(value => !value.ok);
    assert.equal(invalid.document.revision, initial.document.revision);
    assert.ok(invalid.errors.length);
    await writeFile(f.artifact, source.replace("Order API", "Recovered API"));
    const recovered = await until(value => value.ok && value.document.revision !== initial.document.revision);
    assert.match(JSON.stringify(recovered.document), /Recovered API/);
    assert.equal((await fetch(`${shown.viewerUrl}package.json`)).status, 404);
    assert.equal((await fetch(`${shown.viewerUrl}notices/THIRD-PARTY.txt`)).status, 200);
  } finally { await backend.close(); await f.close(); }
});

test("shipping bundle is local, dark, feature-bounded and accompanied by redistribution notices", async () => {
  const asset = (path: string) => readFile(new URL(`../assets/${path}`, import.meta.url), "utf8");
  const [html, fonts, notices, epl, app] = await Promise.all([
    asset("index.html"), asset("fonts.css"), asset("notices/THIRD-PARTY.txt"), asset("notices/Graphviz-EPL-2.0.txt"),
    readFile(new URL("../scripts/viewer.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(html, /font-src 'self' data:/);
  assert.match(html, /img-src 'self' data:/);
  assert.doesNotMatch(fonts, /https?:\/\//);
  assert.match(fonts, /data:font\/woff2;base64/);
  assert.match(app, /injectFontCss=\{false\}/);
  assert.match(app, /renderIcon=\{\(\) => null\}/);
  for (const feature of ["Search", "FocusMode", "RelationshipBrowser", "DynamicViewWalkthrough"]) {
    assert.ok(app.includes(`enable${feature}={true}`));
  }
  assert.match(app, /enableCompareWithLatest=\{false\}/);
  assert.match(app, /nodesSelectable controls showNavigationButtons=\{false\}/);
  assert.doesNotMatch(app, /flow\.current\?\.(fitView|zoomIn|zoomOut)/);
  assert.match(app, /Select an element for focus and relationships/);
  assert.match(app, /disabled=\{!ready \|\| captureBusy\} aria-busy=\{captureBusy\}>Save screenshot<\/button>/);
  assert.match(app, /await document.fonts.ready/);
  assert.match(app, /domToPng\(element, \{ scale: 1, backgroundColor: color\("canvas"\) \}\)/);
  assert.match(app, /if \(capturing.current \|\| !ready \|\| !graph.current\) return/);
  assert.match(app, /Screenshot failed:/);
  assert.match(app, /View changed during capture/);
  assert.doesNotMatch(app, /getDisplayMedia|html-to-image|toSvg/);
  for (const notice of ["modern-screenshot@4.7.0 (MIT)", "likec4@1.59.4", "@likec4/core@1.59.4", "react@19.3.0", "@mantine/core", "@xyflow/react", "SIL OPEN FONT LICENSE", "graphviz-15.0.0.tar.gz"]) assert.ok(notices.includes(notice), notice);
  assert.match(epl, /Eclipse Public License - v 2.0/);
});

test("viewport capture waits for fonts, blocks repeat clicks, names downloads safely and surfaces failure", async () => {
  const source = await readFile(new URL("../scripts/viewer.jsx", import.meta.url), "utf8");
  // Exercise the actual handler without mounting the graph engine in a fake DOM.
  const handler = source.slice(source.indexOf("  const saveScreenshot ="), source.indexOf("  const refresh ="));
  const element = { dataset: { view: "team/api", revision: "abcdef1234567890" } };
  const capturing = { current: false };
  let resolveFonts!: () => void;
  let calls = 0;
  let clicks = 0;
  let busy = false;
  let error = "";
  let fail = false;
  const link = { download: "", href: "", click: () => clicks++ };
  const scope = {
    capturing, ready: true, graph: { current: element },
    setCaptureBusy: (value: boolean) => { busy = value; },
    setCaptureError: (value: string) => { error = value; },
    color: () => "#222222",
    document: {
      fonts: { ready: new Promise<void>(resolve => { resolveFonts = resolve; }) },
      createElement: () => link,
    },
    domToPng: async (target: unknown, options: unknown) => {
      calls++;
      assert.equal(target, element);
      assert.deepEqual(options, { scale: 1, backgroundColor: "#222222" });
      if (fail) throw new Error("capture broke");
      return "data:image/png;base64,test";
    },
  };
  const save = new Function(...Object.keys(scope), `${handler}; return saveScreenshot;`)(...Object.values(scope));
  const pending = save();
  assert.equal(busy, true);
  await save();
  assert.equal(calls, 0);
  resolveFonts();
  await pending;
  assert.equal(calls, 1);
  assert.equal(clicks, 1);
  assert.equal(link.download, "architecture-team_api-abcdef123456.png");
  assert.equal(busy, false);
  assert.equal(capturing.current, false);
  fail = true;
  await save();
  assert.equal(error, "Screenshot failed: capture broke");
  assert.equal(clicks, 1);
  assert.equal(busy, false);
  fail = false;
  const changed = save();
  element.dataset.view = "changed";
  await changed;
  assert.match(error, /View changed during capture/);
  assert.equal(clicks, 1);
});

test("native overlay focus return follows the shadow-root stack and waits for dialog exits", async () => {
  const source = await readFile(new URL("../scripts/viewer.jsx", import.meta.url), "utf8");
  const component = source.slice(source.indexOf("function DialogFocusReturn()"), source.indexOf("function App()"));
  const listeners = new Map<string, () => void>();
  const frames = new Map<number, () => void>();
  let sequence = 0;
  let modalCount = 0;
  const focused: string[] = [];
  const control = (name: string) => ({ isConnected: true, focus: () => focused.push(name) });
  const outer = control("Open details");
  const inner = control("Browse relationships");
  const root = { activeElement: outer, querySelectorAll: () => Array(modalCount) };
  let cleanup: (() => void) | undefined;
  const overlays = { on: (event: string, callback: () => void) => {
    listeners.set(event, callback);
    return { unsubscribe: () => listeners.delete(event) };
  } };
  const run = new Function("useDiagramSelector", "useRef", "useEffect", "requestAnimationFrame", "cancelAnimationFrame",
    `${component.slice(0, component.indexOf("  return <span"))}}; DialogFocusReturn();`);
  const mount = (actor: unknown) => run(
    (select: (state: unknown) => unknown) => select({ children: { overlays: actor } }),
    () => ({ current: { getRootNode: () => root } }),
    (effect: () => (() => void) | undefined) => { cleanup = effect(); },
    (callback: () => void) => { frames.set(++sequence, callback); return sequence; },
    (id: number) => frames.delete(id),
  );
  const tick = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); };
  mount(undefined); // Upstream spawns the actor after children mount.
  assert.equal(listeners.size, 0);
  mount(overlays);
  listeners.get("opened")!(); modalCount = 1;
  root.activeElement = inner;
  listeners.get("opened")!(); modalCount = 2;
  listeners.get("closed")!(); tick();
  assert.deepEqual(focused, []); // Native top-layer dialog is still exiting.
  modalCount = 1; tick();
  assert.deepEqual(focused, ["Browse relationships"]);
  listeners.get("closed")!(); modalCount = 0; tick();
  assert.deepEqual(focused, ["Browse relationships", "Open details"]);
  root.activeElement = inner;
  listeners.get("opened")!(); inner.isConnected = false;
  listeners.get("closed")!(); tick();
  assert.equal(focused.length, 2); // Never focus detached controls after navigation.
  listeners.get("opened")!(); listeners.get("closed")!();
  cleanup!();
  assert.equal(frames.size, 0);
  assert.equal(listeners.size, 0);
});
