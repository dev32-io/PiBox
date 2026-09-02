const viewerIds = ["story-board", "architecture", "mockup"];
const tabs = new Map(viewerIds.map((id) => [id, document.querySelector(`#tab-${id}`)]));
const panels = new Map(viewerIds.map((id) => [id, document.querySelector(`#panel-${id}`)]));
let registered = new Set();
let activeViewer;
const retainedRoutes = new Map();
const ACTIVITY_MESSAGE = "visual-companion:activity";

function notifyActivity(id, active) {
  const frame = panels.get(id).querySelector(".viewer-frame");
  if (!frame.dataset.mounted || !frame.contentWindow) return;
  frame.contentWindow.postMessage({ type: ACTIVITY_MESSAGE, active }, location.origin);
}

function routeViewer(url = new URL(location.href)) {
  const requested = url.searchParams.get("viewer");
  if (viewerIds.includes(requested)) return requested;
  const segment = url.pathname.split("/").filter(Boolean)[0];
  return viewerIds.includes(segment) ? segment : "story-board";
}

function rememberRoute(id, url = new URL(location.href)) {
  const route = `/${id}`;
  if (routeViewer(url) === id && (url.pathname === route || url.pathname.startsWith(`${route}/`))) retainedRoutes.set(id, `${url.pathname}${url.search}${url.hash}`);
}

function routeFor(id) {
  const current = new URL(location.href);
  const route = `/${id}`;
  const currentViewer = routeViewer(current);
  if (currentViewer === id && (current.pathname === route || current.pathname.startsWith(`${route}/`))) return `${current.pathname}${current.search}${current.hash}`;
  return retainedRoutes.get(id) ?? route;
}

function setBoundary(id, message, state = "loading") {
  const boundary = panels.get(id).querySelector(".viewer-boundary");
  boundary.dataset.state = state;
  boundary.setAttribute("role", state === "error" ? "alert" : "status");
  boundary.textContent = message;
  boundary.hidden = false;
}

function mount(id) {
  const panel = panels.get(id);
  const frame = panel.querySelector(".viewer-frame");
  if (frame.dataset.mounted) return;
  if (!registered.has(id)) {
    setBoundary(id, `${tabs.get(id).textContent} is not available in this session.`, "error");
    return;
  }
  frame.dataset.mounted = "true";
  frame.addEventListener("load", () => {
    frame.hidden = false;
    panel.querySelector(".viewer-boundary").hidden = true;
    notifyActivity(id, id === activeViewer);
  }, { once: true });
  frame.addEventListener("error", () => setBoundary(id, `Unable to load ${tabs.get(id).textContent}.`, "error"), { once: true });
  frame.src = `/v/${encodeURIComponent(id)}/`;
}

function activate(id, { updateHistory = false } = {}) {
  if (!viewerIds.includes(id)) id = "story-board";
  if (updateHistory && activeViewer) rememberRoute(activeViewer);
  activeViewer = id;
  for (const viewerId of viewerIds) {
    const selected = viewerId === id;
    tabs.get(viewerId).setAttribute("aria-selected", String(selected));
    tabs.get(viewerId).tabIndex = selected ? 0 : -1;
    panels.get(viewerId).hidden = !selected;
    notifyActivity(viewerId, selected);
  }
  // Mount lazily: a direct viewer route never initializes the other viewers.
  mount(id);
  if (updateHistory) history.pushState({ viewer: id }, "", routeFor(id));
}

for (const [id, tab] of tabs) {
  tab.addEventListener("click", (event) => {
    event.preventDefault();
    activate(id, { updateHistory: id !== activeViewer });
  });
  tab.addEventListener("keydown", (event) => {
    const index = viewerIds.indexOf(id);
    let next;
    if (event.key === "ArrowRight") next = viewerIds[(index + 1) % viewerIds.length];
    if (event.key === "ArrowLeft") next = viewerIds[(index - 1 + viewerIds.length) % viewerIds.length];
    if (event.key === "Home") next = viewerIds[0];
    if (event.key === "End") next = viewerIds.at(-1);
    if (!next) return;
    event.preventDefault();
    activate(next, { updateHistory: next !== activeViewer });
    tabs.get(next).focus();
  });
}

addEventListener("popstate", () => { const id = routeViewer(); rememberRoute(id); activate(id); });

try {
  const response = await fetch("/api/viewers", { cache: "no-store" });
  if (!response.ok) throw new Error(`Viewer registry returned ${response.status}.`);
  const payload = await response.json();
  registered = new Set(payload.viewers ?? []);
  const selected = routeViewer(); rememberRoute(selected); activate(selected);
} catch (error) {
  const selected = routeViewer();
  rememberRoute(selected); activate(selected);
  setBoundary(selected, `Unable to load the viewer registry. ${error.message}`, "error");
}
