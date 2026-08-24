import { createReadStream, existsSync, watch } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const defaultCommonAssetsDir = resolve(dirname(fileURLToPath(import.meta.url)), "assets");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function notFound(response, message = "Not found") {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}

function sendFile(response, path) {
  response.writeHead(200, {
    "content-type": contentTypes[extname(path)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(path).once("error", () => response.destroy()).pipe(response);
}

function containedPath(rootDirectory, relativePath) {
  const root = resolve(rootDirectory);
  const path = resolve(root, relativePath);
  return path === root || path.startsWith(`${root}${sep}`) ? path : undefined;
}

function normalizeRoutes(routes, label) {
  const normalized = new Map();
  for (const [route, value] of Object.entries(routes ?? {})) {
    if (!route.startsWith("/") || route.includes("?") || route.includes("#") || route.split("/").includes("..")) {
      throw new Error(`${label} route must be an absolute, bounded path: ${route}`);
    }
    normalized.set(route, value);
  }
  return normalized;
}

function loopbackHost(host) {
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function hostForUrl(host) {
  return host.includes(":") ? `[${host}]` : host;
}

/**
 * Create one session-owned loopback host. Viewers may be registered after the
 * shell is listening, so viewer discovery/loading is never a prerequisite for
 * making the companion URL available.
 */
export async function createVisualCompanionBackend({
  viewers = [],
  host = "127.0.0.1",
  port = 0,
  commonAssetsDir = defaultCommonAssetsDir,
  commonRoutes,
  commonHandlers,
} = {}) {
  if (!loopbackHost(host)) throw new Error(`Visual Companion must bind to a loopback host, not ${host}.`);

  const registry = new Map();
  const states = new Map();
  const pendingDisposals = new Set();
  const commonStaticRoutes = normalizeRoutes(commonRoutes, "Common");
  const commonDynamicHandlers = normalizeRoutes(commonHandlers, "Common handler");
  let selectedViewer;
  let closed = false;
  let closePromise;

  function disposeState(viewerId) {
    const state = states.get(viewerId);
    if (!state) return;
    states.delete(viewerId);
    clearTimeout(state.timer);
    state.watcher?.close();
    for (const client of state.clients) client.end();
    state.clients.clear();
  }

  function notify(state) {
    const message = `event: changed\ndata: ${JSON.stringify({ ok: state.latest.ok, errors: state.latest.errors })}\n\n`;
    for (const client of state.clients) client.write(message);
  }

  function refresh(viewerId) {
    const registration = registry.get(viewerId);
    const state = states.get(viewerId);
    if (!registration || !state || !registration.viewer.loadDocument) return;
    state.latest = registration.viewer.loadDocument(state.artifactPath);
    if (state.latest.ok) state.lastValid = state.latest.document;
    notify(state);
  }

  function disposeRegistration(registration) {
    if (registration.disposed) return;
    registration.disposed = true;
    const pending = Promise.resolve().then(() => registration.viewer.close?.());
    pendingDisposals.add(pending);
    void pending.catch(() => {}).finally(() => pendingDisposals.delete(pending));
  }

  function registerViewer(viewer) {
    if (closed) throw new Error("Visual Companion backend is closed.");
    if (!viewer?.id || typeof viewer.id !== "string" || viewer.id.includes("/") || viewer.id === "." || viewer.id === "..") {
      throw new Error("A viewer id must be a non-empty path segment.");
    }
    const registration = {
      viewer,
      staticRoutes: normalizeRoutes(viewer.routes, `Viewer ${viewer.id}`),
      handlers: normalizeRoutes(viewer.handlers, `Viewer ${viewer.id} handler`),
      disposed: false,
    };
    const previous = registry.get(viewer.id);
    if (previous) {
      disposeState(viewer.id);
      disposeRegistration(previous);
    }
    registry.set(viewer.id, registration);
    return () => {
      if (registry.get(viewer.id) !== registration) return;
      registry.delete(viewer.id);
      disposeState(viewer.id);
      if (selectedViewer === viewer.id) selectedViewer = undefined;
      disposeRegistration(registration);
    };
  }

  for (const viewer of viewers) registerViewer(viewer);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${hostForUrl(host)}`);
      const commonHandler = commonDynamicHandlers.get(url.pathname);
      if (commonHandler) {
        await commonHandler(request, response, { url, backend: api });
        return;
      }
      const commonExplicit = commonStaticRoutes.get(url.pathname);
      if (commonExplicit) {
        if (existsSync(commonExplicit)) sendFile(response, commonExplicit);
        else notFound(response);
        return;
      }
      if (url.pathname === "/api/viewers") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ viewers: [...registry.keys()], selected: selectedViewer }));
        return;
      }
      if (url.pathname === "/") {
        const shell = containedPath(commonAssetsDir, "index.html");
        if (shell && existsSync(shell)) sendFile(response, shell);
        else notFound(response);
        return;
      }
      if (url.pathname.startsWith("/assets/")) {
        const file = containedPath(commonAssetsDir, url.pathname.slice("/assets/".length));
        if (file && existsSync(file)) sendFile(response, file);
        else notFound(response);
        return;
      }

      const match = url.pathname.match(/^\/v\/([^/]+)(\/.*)?$/);
      if (!match) return notFound(response);
      let viewerId;
      try { viewerId = decodeURIComponent(match[1]); }
      catch { return notFound(response); }
      const registration = registry.get(viewerId);
      if (!registration) return notFound(response, "Visual companion not registered");
      const route = match[2] ?? "/";
      const state = states.get(viewerId);

      const handler = registration.handlers.get(route);
      if (handler) {
        await handler(request, response, { url, viewerId, state, backend: api });
        return;
      }
      if (route === "/api/document") {
        if (!state) return notFound(response, "Visual companion not active");
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ ok: state.latest.ok, document: state.lastValid, errors: state.latest.errors }));
        return;
      }
      if (route === "/events") {
        if (!state) return notFound(response, "Visual companion not active");
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        response.write("event: ready\ndata: {}\n\n");
        state.clients.add(response);
        request.once("close", () => state.clients.delete(response));
        return;
      }

      const explicit = registration.staticRoutes.get(route);
      const file = explicit ?? (registration.viewer.assetsDir ? containedPath(registration.viewer.assetsDir, route === "/" ? "index.html" : route.slice(1)) : undefined);
      if (file && existsSync(file)) sendFile(response, file);
      else notFound(response);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolveListen);
  });
  server.unref();
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const baseUrl = `http://${hostForUrl(host)}:${actualPort}`;

  const api = {
    host,
    port: actualPort,
    url: baseUrl,
    get viewers() { return [...registry.keys()]; },
    get selectedViewer() { return selectedViewer; },
    registerViewer,
    select(viewerId) {
      if (!registry.has(viewerId)) throw new Error(`Unknown visual companion: ${viewerId}`);
      selectedViewer = viewerId;
      return `${baseUrl}/?viewer=${encodeURIComponent(viewerId)}`;
    },
    show({ viewerId, artifactPath }) {
      const registration = registry.get(viewerId);
      if (!registration) throw new Error(`Unknown visual companion: ${viewerId}`);
      if (!artifactPath) return { viewerId, url: api.select(viewerId), viewerUrl: `${baseUrl}/v/${encodeURIComponent(viewerId)}/` };
      if (!registration.viewer.loadDocument) throw new Error(`Visual companion ${viewerId} does not load artifacts.`);
      const resolvedArtifact = resolve(artifactPath);
      if (!existsSync(resolvedArtifact)) throw new Error(`Visualization file not found: ${resolvedArtifact}`);

      disposeState(viewerId);
      const latest = registration.viewer.loadDocument(resolvedArtifact);
      const state = { artifactPath: resolvedArtifact, latest, lastValid: latest.ok ? latest.document : undefined, clients: new Set(), watcher: undefined, timer: undefined };
      state.watcher = watch(resolvedArtifact, () => {
        clearTimeout(state.timer);
        state.timer = setTimeout(() => refresh(viewerId), 60);
        state.timer.unref?.();
      });
      state.watcher.unref?.();
      states.set(viewerId, state);
      return {
        viewerId,
        artifactPath: resolvedArtifact,
        url: api.select(viewerId),
        viewerUrl: `${baseUrl}/v/${encodeURIComponent(viewerId)}/`,
        valid: latest.ok,
        errors: latest.errors,
      };
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        for (const viewerId of [...states.keys()]) disposeState(viewerId);
        for (const registration of registry.values()) disposeRegistration(registration);
        registry.clear();
        const disposalResults = await Promise.allSettled([...pendingDisposals]);
        await new Promise((resolveClose, rejectClose) => {
          server.close((error) => error ? rejectClose(error) : resolveClose());
          server.closeAllConnections?.();
        });
        const failedDisposal = disposalResults.find((result) => result.status === "rejected");
        if (failedDisposal) throw failedDisposal.reason;
      })();
      return closePromise;
    },
  };
  return api;
}
