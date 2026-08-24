const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLUMNS = ["To do", "In progress", "Done"];

export function parseRoute(pathname) {
  const parts = pathname.split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return ""; }
  });
  if (parts[0] !== "story-board") return { view: "catalog" };
  const storyId = parts[1];
  if (!storyId || !ID.test(storyId)) return { view: "catalog" };
  const section = parts[2] || "board";
  if (section === "board") {
    const taskId = parts[3] === "task" ? parts[4] : undefined;
    return taskId && ID.test(taskId) && parts.length === 5 ? { view: "board", storyId, taskId } : { view: "board", storyId };
  }
  if (section === "documents") {
    const documentId = parts[3];
    return documentId && ID.test(documentId) && parts.length === 4 ? { view: "documents", storyId, documentId } : { view: "documents", storyId };
  }
  if (section === "reports") {
    const reportId = parts[3];
    return reportId && ID.test(reportId) && parts.length === 4 ? { view: "reports", storyId, reportId } : { view: "reports", storyId };
  }
  return { view: "board", storyId };
}

export function pathFor(route) {
  if (!route.storyId) return "/story-board";
  const base = `/story-board/${encodeURIComponent(route.storyId)}`;
  if (route.view === "documents") return `${base}/documents${route.documentId ? `/${encodeURIComponent(route.documentId)}` : ""}`;
  if (route.view === "reports") return `${base}/reports${route.reportId ? `/${encodeURIComponent(route.reportId)}` : ""}`;
  return `${base}/board${route.taskId ? `/task/${encodeURIComponent(route.taskId)}` : ""}`;
}

export function createRequestGate() {
  let generation = 0;
  let controller;
  return {
    next() { controller?.abort(); controller = new AbortController(); generation += 1; return { generation, signal: controller.signal }; },
    current(value) { return value === generation; },
    cancel() { generation += 1; controller?.abort(); },
  };
}

export function evidencePresentation(item) {
  if (!item?.available) return "missing";
  if (!item.supported) return "unsupported";
  if (item.mediaType?.startsWith("image/") && item.manifestMember) return "image";
  if (/^(?:text\/|application\/(?:json|yaml))/.test(item.mediaType || "")) return "text";
  return "unsupported";
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
function safeHref(value = "") {
  const trimmed = String(value).trim().replaceAll("&amp;", "&");
  if (/^\/v\/story-board\/api\/evidence\?/.test(trimmed) || /^(?:https?:|mailto:)/i.test(trimmed)) return trimmed;
  return "";
}
function inlineMarkdown(value) {
  let text = escapeHtml(value);
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_all, alt, href) => {
    const safe = safeHref(href);
    return safe.startsWith("/v/story-board/api/evidence?") ? `<img src="${escapeHtml(safe)}" alt="${alt}" loading="lazy">` : `<span>${alt || "Image unavailable"}</span>`;
  });
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_all, label, href) => {
    const safe = safeHref(href);
    return safe ? `<a href="${escapeHtml(safe)}"${/^https?:/i.test(safe) ? ' target="_blank" rel="noreferrer"' : ""}>${label}</a>` : label;
  });
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return text;
}
export function renderMarkdown(markdown = "") {
  const lines = String(markdown).replace(/\r/g, "").split("\n");
  const output = [];
  let list = false;
  for (const line of lines) {
    const item = line.match(/^[-*]\s+(.+)/);
    if (item) { if (!list) { output.push("<ul>"); list = true; } output.push(`<li>${inlineMarkdown(item[1])}</li>`); continue; }
    if (list) { output.push("</ul>"); list = false; }
    const heading = line.match(/^(#{1,4})\s+(.+)/);
    if (heading) output.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`);
    else if (line.trim()) output.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  if (list) output.push("</ul>");
  return output.join("");
}

function diagnostics(items = []) {
  if (!items.length) return "";
  return `<ul class="diagnostics" aria-label="Diagnostics">${items.map((item) => `<li><code>${escapeHtml(item.path)}</code> ${escapeHtml(item.message)}</li>`).join("")}</ul>`;
}
function badge(text, className = "") { return `<span class="badge ${className}">${escapeHtml(text)}</span>`; }
function errorRegion(message, retry) {
  return `<section class="boundary error" role="alert"><h2>Unable to load</h2><p>${escapeHtml(message)}</p><button type="button" data-action="${retry}">Retry</button></section>`;
}

export function createStoryBoardApp({ root, fetchImpl = fetch, navigationWindow = window.parent } = {}) {
  const state = { route: parseRoute(navigationWindow.location.pathname), catalog: undefined, workspace: undefined, detail: undefined, error: undefined, loading: true, detailLoading: false };
  const pageGate = createRequestGate();
  const detailGate = createRequestGate();
  let returnFocus;
  let drawerVisible = false;

  async function request(path, options) {
    const response = await fetchImpl(path, { cache: "no-store", ...options });
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  }
  function currentPath() { return navigationWindow.location.pathname; }
  function setRoute(route, { replace = false } = {}) {
    const path = pathFor(route);
    const canReuseWorkspace = Boolean(route.storyId && state.workspace?.story?.id === route.storyId);
    state.route = route;
    navigationWindow.history[replace ? "replaceState" : "pushState"]({ storyBoard: true }, "", path);
    if (canReuseWorkspace) {
      detailGate.cancel(); state.detail = undefined; state.detailLoading = false; render();
      if (route.taskId || route.documentId || route.reportId) void loadDetail();
    } else void loadRoute();
  }
  async function loadCatalog() {
    const token = pageGate.next();
    Object.assign(state, { loading: true, error: undefined, workspace: undefined, detail: undefined }); render();
    try {
      const payload = await request("api/catalog");
      if (!pageGate.current(token.generation)) return;
      state.catalog = payload.stories || []; state.loading = false; render();
    } catch (error) { if (pageGate.current(token.generation)) { state.loading = false; state.error = error.message; render(); } }
  }
  async function loadRoute() {
    state.route = parseRoute(currentPath());
    detailGate.cancel();
    if (state.route.view === "catalog") return loadCatalog();
    const token = pageGate.next();
    Object.assign(state, { loading: true, error: undefined, workspace: undefined, detail: undefined, detailLoading: false }); render();
    try {
      const payload = await request(`api/workspace?story=${encodeURIComponent(state.route.storyId)}`);
      if (!pageGate.current(token.generation)) return;
      state.workspace = payload.workspace; state.loading = false; render();
      if (state.route.taskId || state.route.documentId || state.route.reportId) void loadDetail();
    } catch (error) { if (pageGate.current(token.generation)) { state.loading = false; state.error = error.message; render(); } }
  }
  async function loadDetail() {
    const { storyId, taskId, documentId, reportId } = state.route;
    const kind = taskId ? "task" : documentId ? "document" : "report";
    const id = taskId || documentId || reportId;
    if (!id) return;
    const token = detailGate.next(); state.detailLoading = true; state.detail = undefined; render();
    try {
      const payload = await request(`api/${kind}?story=${encodeURIComponent(storyId)}&${kind}=${encodeURIComponent(id)}`);
      if (!detailGate.current(token.generation)) return;
      state.detail = payload[kind]; state.detailLoading = false; render();
    } catch (error) { if (detailGate.current(token.generation)) { state.detailLoading = false; state.detail = { error: error.message }; render(); } }
  }
  async function refresh() {
    const button = root.querySelector('[data-action="refresh"]'); if (button) button.disabled = true;
    try { await request("api/refresh", { method: "POST" }); await loadRoute(); }
    catch (error) { state.error = error.message; state.loading = false; render(); }
  }

  function header(workspace) {
    return `<header class="workspace-header"><div><button class="link-button" data-action="catalog">← All stories</button><h1>${escapeHtml(workspace.story.title)}</h1></div><button type="button" data-action="refresh">Refresh</button></header>
      <nav class="local-nav" aria-label="Story sections">${["board", "documents", "reports"].map((view) => `<a href="${pathFor({ view, storyId: state.route.storyId })}" data-route data-view="${view}" ${state.route.view === view ? 'aria-current="page"' : ""}>${view[0].toUpperCase() + view.slice(1)}</a>`).join("")}</nav>`;
  }
  function catalog() {
    if (state.loading) return `<section class="boundary" role="status"><span class="spinner" aria-hidden="true"></span> Loading stories…</section>`;
    if (state.error) return errorRegion(state.error, "retry");
    const stories = state.catalog || [];
    return `<header class="catalog-header"><div><p class="eyebrow">Visual Companion</p><h1>Story Board</h1><p>Browse delivery stories, tasks, documents, and reports.</p></div><button type="button" data-action="refresh">Refresh</button></header>${stories.length ? `<section class="catalog" aria-label="Stories">${stories.map((story) => `<article class="story-card ${story.degraded ? "degraded" : ""}"><div class="card-heading"><h2><a href="${pathFor({ view: "board", storyId: story.id })}" data-route>${escapeHtml(story.title || story.id)}</a></h2>${story.degraded ? badge("Degraded", "warning") : ""}</div><p>${escapeHtml(story.intentExcerpt || "No intent excerpt available.")}</p><dl class="metadata"><div><dt>Kind</dt><dd>${escapeHtml(story.kind)}</dd></div><div><dt>Phase</dt><dd>${escapeHtml(story.phase)}</dd></div><div><dt>State</dt><dd>${escapeHtml(story.state)}</dd></div>${story.planningRevision == null ? "" : `<div><dt>Revision</dt><dd>${story.planningRevision}</dd></div>`}<div><dt>Tasks</dt><dd>${story.taskCount}</dd></div><div><dt>Reports</dt><dd>${story.reportCount}</dd></div></dl>${diagnostics(story.diagnostics)}</article>`).join("")}</section>` : `<section class="boundary"><h2>No stories found</h2><p>There are no persisted stories to browse.</p></section>`}`;
  }
  function board(workspace) {
    return `<section class="board" aria-label="Task board">${COLUMNS.map((column) => { const tasks = workspace.columns[column] || []; return `<section class="column" aria-labelledby="column-${column.replaceAll(" ", "-")}"><h2 id="column-${column.replaceAll(" ", "-")}">${column} <span>${tasks.length}</span></h2><div class="cards">${tasks.map((task) => `<article class="task-card"><button type="button" data-task="${task.id}" aria-label="Open task ${escapeHtml(task.title)}"><strong>${escapeHtml(task.title)}</strong>${badge(task.status, "status")}${task.stage ? `<span>Stage: ${escapeHtml(task.stage)}</span>` : ""}${task.dependsOn.length ? `<span>Depends on: ${task.dependsOn.map(escapeHtml).join(", ")}</span>` : ""}${task.degraded ? badge("Degraded", "warning") : ""}</button>${diagnostics(task.diagnostics)}</article>`).join("") || `<p class="empty-column">No tasks</p>`}</div></section>`; }).join("")}</section>`;
  }
  function documents(workspace) {
    return `<section class="document-groups"><h2>Documents</h2>${workspace.documentGroups.map(({ group, documents }) => `<details><summary>${escapeHtml(group)} <span>${documents.length}</span></summary><ul>${documents.map((document) => `<li><button type="button" data-document="${document.id}" ${document.available ? "" : "disabled"}>${escapeHtml(document.title)} ${badge(document.status)}</button>${diagnostics(document.diagnostics)}</li>`).join("")}</ul></details>`).join("")}</section>`;
  }
  function reports(workspace) {
    return `<section><h2>Reports</h2>${workspace.reports.length ? `<ul class="report-list">${workspace.reports.map((report) => `<li><button type="button" data-report="${report.id}" ${report.available ? "" : "disabled"}><strong>${escapeHtml(report.id)}</strong>${badge(report.verdict || report.status)}<span>${escapeHtml(report.scope.kind)}${report.scope.id ? ` · ${escapeHtml(report.scope.id)}` : ""}</span><span>Attempt ${report.attempt} · ${report.findingCount} findings${report.hasRiskAcceptance ? " · accepted risk" : ""}</span></button>${diagnostics(report.diagnostics)}</li>`).join("")}</ul>` : `<div class="boundary"><p>No reports available.</p></div>`}</section>`;
  }
  function markdownSection(title, body) { return body ? `<section><h3>${title}</h3><div class="markdown">${renderMarkdown(body)}</div></section>` : ""; }
  function taskDetail(task) {
    return `<p>${badge(task.status, "status")}${task.stage ? ` ${badge(`Stage: ${task.stage}`)}` : ""}</p>${task.dependsOn?.length ? `<p><strong>Dependencies:</strong> ${task.dependsOn.map(escapeHtml).join(", ")}</p>` : ""}${markdownSection("Brief", task.brief)}${task.assignment ? `<section><h3>Assignment</h3><p>${escapeHtml(task.assignment.agent)}${task.assignment.tier ? ` · ${escapeHtml(task.assignment.tier)}` : ""}</p>${task.assignment.rationale ? `<p>${escapeHtml(task.assignment.rationale)}</p>` : ""}</section>` : ""}${markdownSection("Acceptance", task.acceptance)}<section><h3>Verification</h3><ul>${[...(task.verification?.methods || []), ...(task.verification?.taskChecks || [])].map((check) => `<li><code>${escapeHtml(check)}</code></li>`).join("") || "<li>Not specified</li>"}</ul></section>${task.deliveryHistory ? `<section><h3>Delivery history</h3><pre><code>${escapeHtml(JSON.stringify(task.deliveryHistory, null, 2))}</code></pre></section>` : ""}${task.relatedReportIds?.length ? `<section><h3>Related reports</h3><ul>${task.relatedReportIds.map((id) => `<li><button class="link-button" data-related-report="${id}">${escapeHtml(id)}</button></li>`).join("")}</ul></section>` : ""}${diagnostics(task.diagnostics)}`;
  }
  function evidence(report) {
    if (!report.evidence?.length) return "";
    return `<section><h3>Evidence</h3><ul class="evidence">${report.evidence.map((item) => { const mode = evidencePresentation(item); const label = item.description || item.path || item.id; if (mode === "image") { const member = item.path.split(`/evidence/${report.id}/`)[1]; const src = `api/evidence?story=${encodeURIComponent(state.route.storyId)}&evaluation=${encodeURIComponent(report.id)}&path=${encodeURIComponent(member)}`; return `<li><figure><img src="${src}" alt="${escapeHtml(label)}" loading="lazy"><figcaption>${escapeHtml(label)}</figcaption></figure></li>`; } if (mode === "text") return `<li><a href="api/evidence?story=${encodeURIComponent(state.route.storyId)}&evaluation=${encodeURIComponent(report.id)}&path=${encodeURIComponent(item.path.split(`/evidence/${report.id}/`)[1])}" target="_blank">${escapeHtml(label)} (text evidence)</a></li>`; return `<li><strong>${escapeHtml(label)}</strong>: ${mode === "missing" ? "Evidence missing" : "Unsupported evidence type"}${diagnostics(item.diagnostics)}</li>`; }).join("")}</ul></section>`;
  }
  function reportDetail(report) {
    return `<p>${badge(report.verdict || report.status)} ${badge(`${report.scope.kind}${report.scope.id ? `: ${report.scope.id}` : ""}`)}</p>${report.taskId ? `<button type="button" data-go-task="${report.taskId}">Go to task</button>` : ""}${markdownSection("Result", report.body)}<section><h3>Attempts</h3><ol>${report.history.map((attempt) => `<li><strong>Attempt ${attempt.attempt}</strong>${attempt.available ? renderMarkdown(attempt.body || "No detail recorded.") : " — missing"}</li>`).join("") || "<li>No attempts recorded</li>"}</ol></section><section><h3>Findings</h3>${report.findings.length ? `<ul>${report.findings.map((finding) => `<li>${badge(finding.severity)} ${badge(finding.status)} <div class="markdown">${renderMarkdown(finding.summary)}</div>${finding.location ? `<code>${escapeHtml(finding.location)}</code>` : ""}</li>`).join("")}</ul>` : "<p>No findings.</p>"}</section>${markdownSection("Accepted risk", report.riskAcceptance)}${evidence(report)}${diagnostics(report.diagnostics)}`;
  }
  function drawer() {
    const id = state.route.taskId || state.route.documentId || state.route.reportId;
    if (!id) return "";
    let title = id; let content;
    if (state.detailLoading) content = `<p role="status">Loading detail…</p>`;
    else if (state.detail?.error) content = errorRegion(state.detail.error, "retry-detail");
    else if (state.detail) { title = state.detail.title || state.detail.id; content = state.route.taskId ? taskDetail(state.detail) : state.route.documentId ? markdownSection("Document", state.detail.body) || "<p>Document content is missing.</p>" : reportDetail(state.detail); }
    return `<aside class="drawer detail-sheet" role="dialog" aria-modal="true" aria-labelledby="detail-title"><header><h2 id="detail-title">${escapeHtml(title)}</h2><button type="button" data-action="close-detail" aria-label="Close detail">×</button></header><div class="drawer-content">${content || ""}</div></aside><div class="scrim" data-action="close-detail"></div>`;
  }
  function workspace() {
    if (state.loading) return `<section class="boundary" role="status"><span class="spinner" aria-hidden="true"></span> Loading story…</section>`;
    if (state.error) return errorRegion(state.error, "retry");
    const workspace = state.workspace;
    const body = state.route.view === "documents" ? documents(workspace) : state.route.view === "reports" ? reports(workspace) : board(workspace);
    return `${header(workspace)}<div class="workspace-body">${workspace.story.degraded ? `<div class="degraded-banner" role="status">Some story content is degraded.${diagnostics(workspace.diagnostics)}</div>` : ""}${body}</div>${drawer()}`;
  }
  function render() {
    const willShowDrawer = Boolean(state.route.taskId || state.route.documentId || state.route.reportId);
    root.innerHTML = state.route.view === "catalog" ? catalog() : workspace();
    if (willShowDrawer && !drawerVisible) queueMicrotask(() => root.querySelector('[data-action="close-detail"]')?.focus());
    drawerVisible = willShowDrawer;
  }
  function closeDetail() {
    const route = { view: state.route.view, storyId: state.route.storyId };
    detailGate.cancel(); setRoute(route);
    queueMicrotask(() => { if (returnFocus) root.querySelector(returnFocus)?.focus(); });
  }
  root.addEventListener("click", (event) => {
    const target = event.target.closest("a,button,[data-action]"); if (!target) return;
    if (target.matches("[data-route]")) { event.preventDefault(); setRoute(parseRoute(new URL(target.href).pathname)); return; }
    if (target.dataset.task) { returnFocus = `[data-task="${target.dataset.task}"]`; setRoute({ view: "board", storyId: state.route.storyId, taskId: target.dataset.task }); }
    else if (target.dataset.document) { returnFocus = `[data-document="${target.dataset.document}"]`; setRoute({ view: "documents", storyId: state.route.storyId, documentId: target.dataset.document }); }
    else if (target.dataset.report) { returnFocus = `[data-report="${target.dataset.report}"]`; setRoute({ view: "reports", storyId: state.route.storyId, reportId: target.dataset.report }); }
    else if (target.dataset.relatedReport) setRoute({ view: "reports", storyId: state.route.storyId, reportId: target.dataset.relatedReport });
    else if (target.dataset.goTask) setRoute({ view: "board", storyId: state.route.storyId, taskId: target.dataset.goTask });
    else if (target.dataset.action === "catalog") setRoute({ view: "catalog" });
    else if (target.dataset.action === "refresh") void refresh();
    else if (target.dataset.action === "retry") void loadRoute();
    else if (target.dataset.action === "retry-detail") void loadDetail();
    else if (target.dataset.action === "close-detail") closeDetail();
  });
  root.addEventListener("keydown", (event) => {
    const open = state.route.taskId || state.route.documentId || state.route.reportId;
    if (event.key === "Escape" && open) { closeDetail(); return; }
    if (event.key !== "Tab" || !open) return;
    const drawer = root.querySelector(".drawer");
    const controls = [...drawer.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (!controls.length) return;
    const first = controls[0]; const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  navigationWindow.addEventListener("popstate", loadRoute);
  void loadRoute();
  return { state, loadRoute, destroy() { pageGate.cancel(); detailGate.cancel(); navigationWindow.removeEventListener("popstate", loadRoute); } };
}

if (typeof document !== "undefined") createStoryBoardApp({ root: document.querySelector("#app") });
