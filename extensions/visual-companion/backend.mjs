import { createReadStream, existsSync, watch } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendFile(response, path) {
  response.writeHead(200, {
    "content-type": contentTypes[extname(path)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(path).pipe(response);
}

function viewerPath(viewer, relativePath) {
  const path = resolve(viewer.assetsDir, relativePath);
  const root = resolve(viewer.assetsDir);
  return path === root || path.startsWith(`${root}${sep}`) ? path : undefined;
}

/**
 * One loopback HTTP server that can host any registered visual companion.
 * Viewer adapters own document loading; the backend only manages transport,
 * watches, static assets, and per-viewer live-update channels.
 */
export async function createVisualCompanionBackend({ viewers, host = "127.0.0.1", port = 0 } = {}) {
  const registry = new Map((viewers ?? []).map((viewer) => [viewer.id, viewer]));
  if (registry.size === 0) throw new Error("At least one visual companion viewer is required.");

  const states = new Map();

  function notify(viewerId, state) {
    const message = `event: changed\ndata: ${JSON.stringify({ ok: state.latest.ok, errors: state.latest.errors })}\n\n`;
    for (const client of state.clients) client.write(message);
  }

  function refresh(viewerId) {
    const viewer = registry.get(viewerId);
    const state = states.get(viewerId);
    if (!viewer || !state) return;
    state.latest = viewer.loadDocument(state.artifactPath);
    if (state.latest.ok) state.lastValid = state.latest.document;
    notify(viewerId, state);
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}`);
    const match = url.pathname.match(/^\/v\/([^/]+)(?:\/(.*))?$/);
    if (!match) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const viewerId = decodeURIComponent(match[1] ?? "");
    const route = match[2] ?? "";
    const viewer = registry.get(viewerId);
    const state = states.get(viewerId);
    if (!viewer || !state) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Visual companion not active");
      return;
    }

    if (route === "api/document") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: state.latest.ok, document: state.lastValid, errors: state.latest.errors }));
      return;
    }
    if (route === "events") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write("event: ready\ndata: {}\n\n");
      state.clients.add(response);
      request.on("close", () => state.clients.delete(response));
      return;
    }

    const explicit = viewer.routes?.[`/${route}`];
    const file = explicit ?? viewerPath(viewer, route || "index.html");
    if (!file || !existsSync(file)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    sendFile(response, file);
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolveListen);
  });
  // The companion is session-owned convenience UI. It must never keep Pi's
  // process alive if an abrupt quit bypasses the normal session_shutdown hook.
  server.unref();
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const baseUrl = `http://${host}:${actualPort}`;

  return {
    host,
    port: actualPort,
    url: baseUrl,
    viewers: [...registry.keys()],
    show({ viewerId, artifactPath }) {
      const viewer = registry.get(viewerId);
      if (!viewer) throw new Error(`Unknown visual companion: ${viewerId}`);
      const resolvedArtifact = resolve(artifactPath);
      if (!existsSync(resolvedArtifact)) throw new Error(`Visualization file not found: ${resolvedArtifact}`);

      const previous = states.get(viewerId);
      if (previous) {
        clearTimeout(previous.timer);
        previous.watcher.close();
        for (const client of previous.clients) client.end();
      }
      const latest = viewer.loadDocument(resolvedArtifact);
      const state = {
        artifactPath: resolvedArtifact,
        latest,
        lastValid: latest.ok ? latest.document : undefined,
        clients: new Set(),
        watcher: undefined,
        timer: undefined,
      };
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
        url: `${baseUrl}/v/${encodeURIComponent(viewerId)}/`,
        valid: latest.ok,
        errors: latest.errors,
      };
    },
    async close() {
      for (const state of states.values()) {
        clearTimeout(state.timer);
        state.watcher.close();
        for (const client of state.clients) client.end();
      }
      states.clear();
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
        server.closeAllConnections?.();
      });
    },
  };
}
