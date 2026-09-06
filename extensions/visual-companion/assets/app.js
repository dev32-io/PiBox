const viewerIds = ["story-board", "architecture", "mockup", "scratch"];
const tabs = new Map(viewerIds.map((id) => [id, document.querySelector(`#tab-${id}`)]));
const panels = new Map(viewerIds.map((id) => [id, document.querySelector(`#panel-${id}`)]));
let registered = new Set();
let activeViewer;
let registryRequest;
let registryController;
let registryGeneration = 0;
let registryTimer;
const retainedRoutes = new Map();
const ACTIVITY_MESSAGE = "visual-companion:activity";
const REGISTRY_INTERVAL_MS = 5_000;

function notifyActivity(id, active) {
  const frame = panels.get(id).querySelector(".viewer-frame");
  if (!frame?.dataset.mounted || !frame.contentWindow) return;
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
  if (!viewerIds.includes(id) || tabs.get(id).hidden) id = "story-board";
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

function visibleViewerIds() {
  return viewerIds.filter((id) => !tabs.get(id).hidden);
}

function unmountScratch() {
  const panel = panels.get("scratch");
  const frame = panel.querySelector(".viewer-frame");
  notifyActivity("scratch", false);
  frame.remove();
  const replacement = document.createElement("iframe");
  replacement.className = "viewer-frame";
  replacement.title = "Session Scratch";
  replacement.dataset.viewer = "scratch";
  replacement.hidden = true;
  panel.append(replacement);
  retainedRoutes.delete("scratch");
  setBoundary("scratch", "Scratch is not available in this session.", "error");
}

function applyRegistry(viewers, { initial = false } = {}) {
  const hadScratch = registered.has("scratch");
  registered = new Set(Array.isArray(viewers) ? viewers : []);
  const hasScratch = registered.has("scratch");
  const scratchHadFocus = document.activeElement === tabs.get("scratch") || document.activeElement === panels.get("scratch").querySelector(".viewer-frame");
  tabs.get("scratch").hidden = !hasScratch;

  if (hadScratch && !hasScratch) unmountScratch();
  if (activeViewer === "scratch" && !hasScratch) {
    activate("story-board");
    history.replaceState({ viewer: "story-board" }, "", routeFor("story-board"));
    if (scratchHadFocus) tabs.get("story-board").focus();
    return;
  }
  if (initial) {
    const requested = routeViewer();
    const selected = requested === "scratch" && !hasScratch ? "story-board" : requested;
    rememberRoute(selected);
    activate(selected);
    if (selected !== requested) history.replaceState({ viewer: selected }, "", routeFor(selected));
  } else if (activeViewer && registered.has(activeViewer)) {
    // Recover a previously unavailable viewer after registry refresh succeeds.
    mount(activeViewer);
  }
}

async function refreshRegistry(options = {}) {
  if (document.hidden && !options.initial) return;
  if (registryRequest) return registryRequest;
  const generation = ++registryGeneration;
  const controller = new AbortController();
  registryController = controller;
  registryRequest = (async () => {
    try {
      const response = await fetch("/api/viewers", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("registry unavailable");
      const payload = await response.json();
      if (generation === registryGeneration) applyRegistry(payload.viewers, options);
    } catch (error) {
      if (error.name === "AbortError" || generation !== registryGeneration) return;
      if (options.initial) {
        const requested = routeViewer();
        const selected = requested === "scratch" ? "story-board" : requested;
        rememberRoute(selected);
        activate(selected);
        setBoundary(selected, "Unable to load the viewer registry.", "error");
      }
    } finally {
      if (generation === registryGeneration) {
        registryRequest = undefined;
        registryController = undefined;
      }
    }
  })();
  return registryRequest;
}

function restartRegistryTimer() {
  clearInterval(registryTimer);
  registryTimer = undefined;
  if (!document.hidden) registryTimer = setInterval(() => { void refreshRegistry(); }, REGISTRY_INTERVAL_MS);
}

for (const [id, tab] of tabs) {
  tab.addEventListener("click", (event) => {
    event.preventDefault();
    if (!tab.hidden) activate(id, { updateHistory: id !== activeViewer });
  });
  tab.addEventListener("keydown", (event) => {
    const available = visibleViewerIds();
    const index = available.indexOf(id);
    let next;
    if (event.key === "ArrowRight") next = available[(index + 1) % available.length];
    if (event.key === "ArrowLeft") next = available[(index - 1 + available.length) % available.length];
    if (event.key === "Home") next = available[0];
    if (event.key === "End") next = available.at(-1);
    if (!next) return;
    event.preventDefault();
    activate(next, { updateHistory: next !== activeViewer });
    tabs.get(next).focus();
  });
}

addEventListener("popstate", () => { const id = routeViewer(); rememberRoute(id); activate(id); });
addEventListener("focus", () => { void refreshRegistry(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearInterval(registryTimer);
    registryTimer = undefined;
    registryController?.abort();
    registryGeneration += 1;
    registryRequest = undefined;
    registryController = undefined;
  } else {
    void refreshRegistry();
    restartRegistryTimer();
  }
});
addEventListener("pagehide", () => {
  clearInterval(registryTimer);
  registryController?.abort();
  registryGeneration += 1;
  registryRequest = undefined;
  registryController = undefined;
});

await refreshRegistry({ initial: true });
restartRegistryTimer();
