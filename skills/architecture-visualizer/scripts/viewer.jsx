import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { LikeC4Model } from "@likec4/core/model";
import { LikeC4ModelProvider, ReactLikeC4, useDiagramSelector } from "likec4/react";
import { domToPng } from "modern-screenshot";
import shadowCss from "./shadow.css";

// Resolve shared tokens once; the shadow tree receives theme hooks plus its own
// stylesheet through ReactLikeC4's supported children slot, never DOM patching.
const tokens = getComputedStyle(document.documentElement);
const color = name => tokens.getPropertyValue(`--color-${name}`).trim();
const mantineTheme = {
  primaryColor: "copper",
  colors: {
    copper: Array(10).fill(color("accent")),
    dark: ["text", "text-secondary", "text-muted", "border-strong", "border", "surface-hover", "surface-strong", "surface", "canvas-soft", "canvas"].map(color),
  },
  fontFamily: '"IBM Plex Sans Variable", system-ui, sans-serif',
};

// Native dialogs remember document.activeElement (the shadow host), not the
// focused control inside it. Follow the native overlay stack, including nested
// details/browser dialogs, and wait for upstream exit animations before return.
function DialogFocusReturn() {
  const overlays = useDiagramSelector(state => state.children.overlays);
  const anchor = useRef(null);
  useEffect(() => {
    if (!overlays) return;
    const root = anchor.current.getRootNode();
    const openers = [];
    let frame;
    const opened = overlays.on("opened", () => {
      cancelAnimationFrame(frame);
      openers.push(root.activeElement);
    });
    const closed = overlays.on("closed", () => {
      const opener = openers.pop();
      cancelAnimationFrame(frame);
      const restore = () => {
        if (root.querySelectorAll("dialog:modal").length > openers.length) {
          frame = requestAnimationFrame(restore);
        } else if (opener?.isConnected) {
          opener.focus({ preventScroll: true });
        }
      };
      frame = requestAnimationFrame(restore);
    });
    return () => {
      opened.unsubscribe();
      closed.unsubscribe();
      cancelAnimationFrame(frame);
    };
  }, [overlays]);
  return <span hidden ref={anchor} />;
}

function App() {
  const [payload, setPayload] = useState(null);
  const [errors, setErrors] = useState([]);
  const [selection, setSelection] = useState("");
  const [selected, setSelected] = useState("overview");
  const [trail, setTrail] = useState([]);
  const graph = useRef(null);
  const capturing = useRef(false);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState("");
  const [initialized, setInitialized] = useState(false);
  const [ready, setReady] = useState(false);
  const generation = useRef(0);
  const model = useMemo(() => payload ? LikeC4Model.create(payload.model) : null, [payload]);
  const views = model ? [...model.views()] : [];
  const view = model?.findView(selected) ? selected : views[0]?.id;
  useEffect(() => {
    setReady(false);
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setReady(initialized));
    });
    return () => cancelAnimationFrame(frame);
  }, [initialized, payload, view]);
  const saveScreenshot = async () => {
    if (capturing.current || !ready || !graph.current) return;
    capturing.current = true;
    setCaptureBusy(true);
    setCaptureError("");
    const element = graph.current;
    const revision = element.dataset.revision;
    const viewId = element.dataset.view;
    const unchanged = () => element.dataset.revision === revision && element.dataset.view === viewId;
    try {
      await document.fonts.ready;
      if (!unchanged()) throw new Error("View changed during capture. Try again.");
      const png = await domToPng(element, { scale: 1, backgroundColor: color("canvas") });
      if (!unchanged()) throw new Error("View changed during capture. Try again.");
      const link = document.createElement("a");
      link.download = `architecture-${viewId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${revision.slice(0, 12)}.png`;
      link.href = png;
      link.click();
    } catch (error) {
      setCaptureError(`Screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      capturing.current = false;
      setCaptureBusy(false);
    }
  };
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const response = await fetch("./api/document", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      if (request !== generation.current) return;
      setErrors(result.errors);
      // The backend owns last-valid state, including after a browser reload.
      if (result.document) setPayload(previous => previous?.revision === result.document.revision ? previous : result.document);
    } catch (error) {
      if (request === generation.current) setErrors([String(error)]);
    }
  }, []);
  useEffect(() => {
    const events = new EventSource("./events");
    events.addEventListener("ready", refresh);
    events.addEventListener("changed", refresh);
    events.onerror = () => setErrors(["Live connection lost. Display may be stale; reconnecting…"]);
    return () => { generation.current++; events.close(); };
  }, [refresh]);
  const navigate = id => {
    if (id === view || !model.findView(id)) return;
    setTrail(previous => [...previous, view]);
    setSelected(id);
    setSelection("");
  };
  const back = () => {
    const remaining = trail.filter(id => model.findView(id));
    const id = remaining.pop();
    setTrail(remaining);
    if (id) setSelected(id);
  };
  return <>
    <header>
      <nav aria-label="Architecture views">
        <button onClick={back} disabled={!trail.some(id => model?.findView(id))}>Back</button>
        <label>View <select value={view ?? ""} onChange={event => navigate(event.target.value)} disabled={!model}>
          {views.map(item => <option key={item.id} value={item.id}>{item.title || item.id}</option>)}
        </select></label>
      </nav>
      <div role="group" aria-label="Graph controls">
        <button onClick={refresh}>Refresh</button>
        <button onClick={saveScreenshot} disabled={!ready || captureBusy} aria-busy={captureBusy}>Save screenshot</button>
      </div>
      <output data-testid="revision" data-revision={payload?.revision ?? ""} data-view={view ?? ""}>
        {view ? `${view} · ${payload.revision.slice(0, 12)}` : "Loading architecture…"}
      </output>
    </header>
    {errors.length > 0 && <pre role="alert">{payload ? "Invalid or stale source — showing the last valid document.\n" : "Architecture unavailable.\n"}{errors.join("\n")}</pre>}
    {captureError && <pre role="alert">{captureError}</pre>}
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{selection}</p>
    <main ref={graph} aria-label="Interactive architecture graph" data-revision={payload?.revision ?? ""} data-view={view ?? ""}>
      {model && view && <LikeC4ModelProvider likec4model={model}>
        <ReactLikeC4 viewId={view} onNavigateTo={navigate} colorScheme="dark" mantineTheme={mantineTheme}
          injectFontCss={false} keepAspectRatio={false} style={{ width: "100%", height: "100%" }}
          background="solid" pannable zoomable fitView nodesSelectable controls showNavigationButtons={false}
          enableElementDetails enableRelationshipDetails enableSearch={true} enableFocusMode={true}
          enableRelationshipBrowser={true} enableDynamicViewWalkthrough={true} enableCompareWithLatest={false} enableNotes={false}
          renderIcon={() => null}
          onInitialized={() => setInitialized(true)}
          reactFlowProps={{ nodesFocusable: true, edgesFocusable: true,
            onSelectionChange: ({ nodes, edges }) => setSelection([...nodes, ...edges].map(item => `Selected ${item.data.title || item.data.label || item.id}`).join(". ")) }}>
          <style>{shadowCss}</style>
          <DialogFocusReturn />
        </ReactLikeC4>
      </LikeC4ModelProvider>}
    </main>
    <footer><span>Search in diagram toolbar. Select an element for focus and relationships. Dynamic views offer walkthrough controls. Tab to graph items; Enter selects. Drag to pan.</span><a href="./notices/THIRD-PARTY.txt" target="_blank" rel="noreferrer">Third-party licenses</a></footer>
  </>;
}
createRoot(document.getElementById("root")).render(<App />);
