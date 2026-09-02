const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLUMNS = ["To do", "In progress", "Done"];
const COMPLETE_TASK_STATUSES = new Set(["accepted", "merged", "staged", "integrated", "completed", "cancelled"]);
const ACTIVE_TASK_STATUSES = new Set(["implementing", "check_pending", "checking", "repair_pending", "repairing", "interrupted"]);
const FAILURE_STATUSES = new Set(["failed", "protocol_failed", "changes_requested", "blocked", "stopped", "attention"]);
const SHELL_ACTIVITY_MESSAGE = "visual-companion:activity";

export function parseRoute(pathname) {
  const parts = pathname.split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return ""; }
  });
  if (parts[0] !== "story-board") return { view: "catalog" };
  const storyId = parts[1];
  if (!storyId || !ID.test(storyId)) return { view: "catalog" };
  const section = parts[2] || "workflow";
  if (section === "workflow") {
    const detailKind = parts[3];
    const detailId = parts[4];
    if (parts.length === 5 && detailId && ID.test(detailId) && detailKind === "task") return { view: "workflow", storyId, taskId: detailId };
    if (parts.length === 5 && detailId && ID.test(detailId) && detailKind === "report") return { view: "workflow", storyId, reportId: detailId };
    return { view: "workflow", storyId };
  }
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
  return { view: "workflow", storyId };
}

export function pathFor(route) {
  if (!route.storyId) return "/story-board";
  const base = `/story-board/${encodeURIComponent(route.storyId)}`;
  if (route.view === "workflow") {
    if (route.taskId) return `${base}/workflow/task/${encodeURIComponent(route.taskId)}`;
    if (route.reportId) return `${base}/workflow/report/${encodeURIComponent(route.reportId)}`;
    return `${base}/workflow`;
  }
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

export function renderDeliveryHistory(history) {
  if (!history) return "";
  const rows = [["Execution mode", history.executionMode], ["Completed commit", history.completedCommit], ["Merged commit", history.mergedCommit]].filter(([, value]) => value);
  return rows.length ? `<section><h3>Delivery history</h3><dl class="metadata">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd><code>${escapeHtml(value)}</code></dd></div>`).join("")}</dl></section>` : "";
}

function diagnostics(items = []) {
  if (!items.length) return "";
  return `<ul class="diagnostics" aria-label="Diagnostics">${items.map((item) => `<li><code>${escapeHtml(item.path)}</code> ${escapeHtml(item.message)}</li>`).join("")}</ul>`;
}
function normalizedStatus(value) { return String(value || "unknown").trim().toLowerCase().replace(/[\s-]+/g, "_"); }
function statusTone(value) {
  const status = normalizedStatus(value);
  if (["complete", "completed", "accepted", "merged", "staged", "integrated", "passed", "written", "success"].includes(status)) return "success";
  if (["failed", "protocol_failed", "stopped", "changes_requested", "error"].includes(status)) return "danger";
  if (["paused", "blocked", "attention", "needs_user", "warning", "awaiting_ci", "repair_pending", "fix_pending", "interrupted"].includes(status)) return "warning";
  if (["running", "implementing", "checking", "repairing", "reviewing", "fixing", "testing", "integrating", "merging", "active"].includes(status)) return "active";
  return "neutral";
}
function badge(text, className = "") { return `<span class="badge ${className} tone-${statusTone(text)}">${escapeHtml(String(text ?? "unknown").replaceAll("_", " "))}</span>`; }
function errorRegion(message, retry) {
  return `<section class="boundary error" role="alert"><h2>Unable to load</h2><p>${escapeHtml(message)}</p><button type="button" data-action="${retry}">Retry</button></section>`;
}
function number(value, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function titleCase(value = "") { return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function taskIsComplete(task) { return COMPLETE_TASK_STATUSES.has(normalizedStatus(task?.status)); }
function taskNeedsAttention(task) { return FAILURE_STATUSES.has(normalizedStatus(task?.status)) || number(task?.checks?.failed) > 0 || Boolean(task?.failure); }
function attentionEntries(attention) {
  if (typeof attention === "number") return attention > 0 ? [["Attention", attention]] : [];
  if (!attention || typeof attention !== "object") return [];
  const entries = Object.entries(attention).filter(([key, value]) => key !== "total" && number(value) > 0).map(([key, value]) => [titleCase(key), number(value)]);
  if (!entries.length && number(attention.total) > 0) return [["Attention", number(attention.total)]];
  return entries;
}
function attentionTotal(attention) {
  if (typeof attention === "number") return Math.max(0, attention);
  if (!attention || typeof attention !== "object") return 0;
  if (Number.isFinite(Number(attention.total))) return Math.max(0, number(attention.total));
  return attentionEntries(attention).reduce((sum, [, value]) => sum + value, 0);
}

export function createStoryBoardApp({ root, fetchImpl = fetch, navigationWindow = window.parent } = {}) {
  const state = {
    route: parseRoute(navigationWindow.location.pathname), catalog: undefined, workspace: undefined, observation: undefined,
    detail: undefined, error: undefined, loading: true, detailLoading: false, etag: undefined, stale: undefined,
    ui: { density: "comfortable", filter: "all", collapseCompleted: false },
  };
  const pageGate = createRequestGate();
  const detailGate = createRequestGate();
  const pollGate = createRequestGate();
  let returnFocus;
  let drawerVisible = false;
  let pollTimer;
  let pollFailures = 0;
  let shellActive = true;
  let pageHidden = false;
  let destroyed = false;

  async function requestResponse(path, options) {
    const response = await fetchImpl(path, { cache: "no-store", ...options });
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      const error = new Error(payload.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return { response, payload };
  }
  async function request(path, options) { return (await requestResponse(path, options)).payload; }
  function currentPath() { return navigationWindow.location.pathname; }
  function isCurrentWorkspace() { return state.workspace?.story?.format === "current"; }
  function workflowStatus() { return normalizedStatus(state.observation?.status || state.workspace?.workflow?.status); }
  function pollingDelay() {
    const status = workflowStatus();
    const outcome = normalizedStatus(state.observation?.outcomeStatus || state.workspace?.workflow?.outcomeStatus);
    if (["running", "completed_pending"].includes(status) || (status === "completed" && outcome !== "written")) return 3000;
    if (["ready", "paused", "attention", "needs_user"].includes(status) || attentionTotal(state.workspace?.workflow?.attention) > 0) return 12000;
    return undefined;
  }
  function pollingAllowed() {
    if (destroyed || pageHidden || document.visibilityState === "hidden" || !shellActive || state.route.view !== "workflow" || !isCurrentWorkspace()) return false;
    const status = workflowStatus();
    const outcome = normalizedStatus(state.observation?.outcomeStatus || state.workspace?.workflow?.outcomeStatus);
    return !["failed", "stopped"].includes(status) && !(status === "completed" && outcome === "written") && pollingDelay() !== undefined;
  }
  function clearPollTimer() { if (pollTimer !== undefined) { clearTimeout(pollTimer); pollTimer = undefined; } }
  function stopPolling() { clearPollTimer(); pollGate.cancel(); }
  function schedulePoll(delay) {
    clearPollTimer();
    if (!pollingAllowed()) return;
    pollTimer = setTimeout(() => { pollTimer = undefined; void pollWorkspace(); }, delay);
  }
  function syncPolling({ immediate = false } = {}) {
    stopPolling();
    if (pollingAllowed()) schedulePoll(immediate ? 0 : pollingDelay());
  }
  async function pollWorkspace() {
    if (!pollingAllowed()) return;
    const token = pollGate.next();
    try {
      let response;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        response = await fetchImpl(`api/workspace?story=${encodeURIComponent(state.route.storyId)}`, {
          cache: "no-store", signal: token.signal, headers: state.etag ? { "If-None-Match": state.etag } : {},
        });
        if (response.status !== 409 || attempt === 1) break;
      }
      if (!pollGate.current(token.generation)) return;
      if (response.status === 304) {
        pollFailures = 0;
        state.stale = undefined;
        root.querySelector(".stale-indicator")?.remove();
        schedulePoll(pollingDelay());
        return;
      }
      let payload = {};
      try { payload = await response.json(); } catch {}
      if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
      if (!payload.workspace) throw new Error("Workspace response was incomplete");
      const etag = response.headers?.get?.("etag") || state.etag;
      const interaction = captureInteractionState();
      Object.assign(state, { workspace: payload.workspace, observation: payload.observation, etag, stale: undefined });
      pollFailures = 0;
      render(); restoreInteractionState(interaction);
      if (state.route.taskId || state.route.reportId) void loadDetail(interaction);
      schedulePoll(pollingDelay());
    } catch (error) {
      if (!pollGate.current(token.generation) || error?.name === "AbortError") return;
      const interaction = captureInteractionState();
      pollFailures += 1;
      state.stale = `Live updates paused after ${pollFailures} failed ${pollFailures === 1 ? "request" : "requests"}.`;
      render(); restoreInteractionState(interaction);
      const delays = [5000, 15000, 30000];
      if (pollFailures <= delays.length) schedulePoll(delays[pollFailures - 1]);
    }
  }
  function setRoute(route, { replace = false } = {}) {
    stopPolling();
    const path = pathFor(route);
    const canReuseWorkspace = Boolean(route.storyId && state.workspace?.story?.id === route.storyId);
    state.route = route;
    navigationWindow.history[replace ? "replaceState" : "pushState"]({ storyBoard: true }, "", path);
    if (canReuseWorkspace) {
      pageGate.cancel(); detailGate.cancel(); state.detail = undefined; state.detailLoading = false; render();
      if (route.taskId || route.documentId || route.reportId) void loadDetail();
      syncPolling();
    } else void loadRoute();
  }
  async function loadCatalog() {
    stopPolling();
    const token = pageGate.next();
    Object.assign(state, { loading: true, error: undefined, workspace: undefined, observation: undefined, etag: undefined, detail: undefined, stale: undefined }); render();
    try {
      const payload = await request("api/catalog", { signal: token.signal });
      if (!pageGate.current(token.generation)) return;
      state.catalog = payload.stories || []; state.loading = false; render();
    } catch (error) { if (pageGate.current(token.generation) && error?.name !== "AbortError") { state.loading = false; state.error = error.message; render(); } }
  }
  async function loadRoute() {
    stopPolling();
    state.route = parseRoute(currentPath());
    detailGate.cancel();
    if (state.route.view === "catalog") return loadCatalog();
    const token = pageGate.next();
    Object.assign(state, { loading: true, error: undefined, workspace: undefined, observation: undefined, etag: undefined, detail: undefined, detailLoading: false, stale: undefined }); render();
    try {
      let result;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { result = await requestResponse(`api/workspace?story=${encodeURIComponent(state.route.storyId)}`, { signal: token.signal }); break; }
        catch (error) { if (error?.status !== 409 || attempt === 1) throw error; }
      }
      const { response, payload } = result;
      if (!pageGate.current(token.generation)) return;
      state.workspace = payload.workspace;
      state.observation = payload.observation;
      state.etag = response.headers?.get?.("etag") || undefined;
      state.loading = false;
      if (state.route.view === "workflow" && state.workspace?.story?.format !== "current") {
        state.route = { view: "board", storyId: state.route.storyId };
        navigationWindow.history.replaceState({ storyBoard: true }, "", pathFor(state.route));
      }
      render();
      if (state.route.taskId || state.route.documentId || state.route.reportId) void loadDetail();
      pollFailures = 0;
      syncPolling();
    } catch (error) { if (pageGate.current(token.generation) && error?.name !== "AbortError") { state.loading = false; state.error = error.message; render(); } }
  }
  async function loadDetail(preservedInteraction) {
    const { storyId, taskId, documentId, reportId } = state.route;
    const kind = taskId ? "task" : documentId ? "document" : "report";
    const id = taskId || documentId || reportId;
    if (!id) return;
    const token = detailGate.next(); const openingInteraction = preservedInteraction ?? captureInteractionState(); state.detailLoading = true; state.detail = undefined; render(); restoreInteractionState(openingInteraction);
    try {
      const payload = await request(`api/${kind}?story=${encodeURIComponent(storyId)}&${kind}=${encodeURIComponent(id)}`, { signal: token.signal });
      if (!detailGate.current(token.generation)) return;
      const settledInteraction = preservedInteraction ?? captureInteractionState(); state.detail = payload[kind]; state.detailLoading = false; render(); restoreInteractionState(settledInteraction);
    } catch (error) { if (detailGate.current(token.generation) && error?.name !== "AbortError") { const settledInteraction = preservedInteraction ?? captureInteractionState(); state.detailLoading = false; state.detail = { error: error.message }; render(); restoreInteractionState(settledInteraction); } }
  }
  async function refresh() {
    stopPolling();
    const token = pageGate.next();
    const button = root.querySelector('[data-action="refresh"]'); if (button) button.disabled = true;
    try {
      await request("api/refresh", { method: "POST", signal: token.signal });
      if (pageGate.current(token.generation)) await loadRoute();
    } catch (error) {
      if (pageGate.current(token.generation) && error?.name !== "AbortError") { state.error = error.message; state.loading = false; render(); }
    }
  }

  function header(workspace) {
    const current = workspace.story?.format === "current";
    const views = current ? [["workflow", "Workflow"], ["board", "Tasks"], ["documents", "Documents"], ["reports", "Reports"]] : [["board", "Tasks"], ["documents", "Documents"], ["reports", "Reports"]];
    return `<header class="workspace-header"><div><button class="link-button" data-action="catalog">← All stories</button><h1>${escapeHtml(workspace.story?.title || workspace.story?.id)}</h1></div><button type="button" data-action="refresh">Refresh</button></header>
      <nav class="local-nav" aria-label="Story sections">${views.map(([view, label]) => `<a href="${pathFor({ view, storyId: state.route.storyId })}" data-route data-view="${view}" ${state.route.view === view ? 'aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
  }
  function catalog() {
    if (state.loading) return `<section class="boundary" role="status"><span class="spinner" aria-hidden="true"></span> Loading stories…</section>`;
    if (state.error) return errorRegion(state.error, "retry");
    const stories = state.catalog || [];
    return `<header class="catalog-header"><div><p class="eyebrow">Visual Companion</p><h1>Story Board</h1><p>Browse delivery stories, tasks, documents, and reports.</p></div><button type="button" data-action="refresh">Refresh</button></header>${stories.length ? `<section class="catalog" aria-label="Stories">${stories.map((story) => `<article class="story-card ${story.degraded ? "degraded" : ""}"><div class="card-heading"><h2><a href="${pathFor({ view: story.format === "current" ? "workflow" : "board", storyId: story.id })}" data-route>${escapeHtml(story.title || story.id)}</a></h2>${story.degraded ? badge("Degraded", "warning") : ""}</div><p>${escapeHtml(story.intentExcerpt || "No intent excerpt available.")}</p><dl class="metadata"><div><dt>Kind</dt><dd>${escapeHtml(story.kind)}</dd></div><div><dt>Phase</dt><dd>${escapeHtml(story.phase)}</dd></div><div><dt>State</dt><dd>${escapeHtml(story.state)}</dd></div>${story.planningRevision == null ? "" : `<div><dt>Revision</dt><dd>${story.planningRevision}</dd></div>`}<div><dt>Tasks</dt><dd>${number(story.taskCount)}</dd></div><div><dt>Reports</dt><dd>${number(story.reportCount)}</dd></div></dl>${diagnostics(story.diagnostics)}</article>`).join("")}</section>` : `<section class="boundary"><h2>No stories found</h2><p>There are no persisted stories to browse.</p></section>`}`;
  }
  function taskChecks(task) {
    const checks = task?.checks || {};
    const passed = number(checks.passed); const failed = number(checks.failed); const running = number(checks.running); const total = number(checks.total, passed + failed + running);
    return `<span class="task-checks"><span><strong>${passed}</strong> passed</span><span><strong>${failed}</strong> failed</span><span><strong>${running}</strong> running</span><span><strong>${total}</strong> total</span></span>`;
  }
  function summaryLine(label, value, className = "") {
    if (value == null || value === "") return "";
    const content = typeof value === "object" ? [value.code, value.summary].filter(Boolean).join(" · ") : value;
    return content ? `<p class="${className}"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(content)}</p>` : "";
  }
  function workflowTask(task, index) {
    const wait = number(task?.incompleteDependencyCount);
    const retries = number(task?.repairCount);
    return `<li class="workflow-task tone-border-${statusTone(task?.status)}"><button type="button" data-task="${escapeHtml(task?.id)}"><span class="sr-only">Open task detail. </span><span class="task-topline"><span class="task-sequence" aria-hidden="true">${index + 1}</span>${badge(task?.status || "unknown", "status")}</span><strong class="task-title">${escapeHtml(task?.title || task?.id)}</strong><code class="task-id">${escapeHtml(task?.id)}</code>${taskChecks(task)}<span class="task-signals"><span>Retries <strong>${retries}</strong></span><span>Dependency wait <strong>${wait}</strong></span></span>${task?.dependsOn?.length ? `<span class="task-dependencies ${wait ? "is-waiting" : ""}">${wait ? `Waiting on ${wait} incomplete dependencies · ` : "Depends on "}${task.dependsOn.map(escapeHtml).join(", ")}</span>` : ""}${summaryLine("Result", task?.result, "task-result")}${summaryLine("Failure", task?.failure, "task-failure")}</button></li>`;
  }
  function gateDetails(gate) {
    if (!gate) return "";
    const checks = gate.checks || {};
    const checkTotal = number(checks.total, number(checks.passed) + number(checks.failed) + number(checks.running));
    const findings = gate.findings || gate.findingSeverityTotals || gate.findingSeverities;
    const findingText = findings && typeof findings === "object" ? Object.entries(findings).filter(([severity, count]) => severity !== "total" && number(count) > 0).map(([severity, count]) => `${number(count)} ${severity}`).join(" · ") : "";
    return `${checkTotal ? `<span>${number(checks.passed)}/${checkTotal} checks passed${number(checks.failed) ? ` · ${number(checks.failed)} failed` : ""}${number(checks.running) ? ` · ${number(checks.running)} running` : ""}</span>` : ""}${number(gate.repairCount) ? `<span>${number(gate.repairCount)} repairs</span>` : ""}${findingText ? `<span>${escapeHtml(findingText)} findings</span>` : ""}${summaryLine("Result", gate.result)}${summaryLine("Failure", gate.failure, "task-failure")}`;
  }
  function gate(label, value, kind = "gate") {
    const content = `<span class="gate-name">${escapeHtml(label)}</span>${badge(value?.status || "pending", "status")}<div class="gate-detail">${gateDetails(value)}</div>`;
    const action = value?.reportId ? { attribute: `data-report="${escapeHtml(value.reportId)}"`, label: "Open report. " } : value?.documentId ? { attribute: `data-document="${escapeHtml(value.documentId)}"`, label: "Open document. " } : undefined;
    return `<li class="workflow-gate ${kind} tone-border-${statusTone(value?.status)}">${action ? `<button type="button" ${action.attribute}><span class="sr-only">${action.label}</span>${content}</button>` : `<div>${content}</div>`}</li>`;
  }
  function stageTasks(workspace, stage) {
    const projected = Array.isArray(stage.tasks) && stage.tasks.length ? stage.tasks : (stage.taskIds || []).map((id) => (workspace.tasks || []).find((task) => task.id === id) || { id, title: id, status: "unknown" });
    if (state.ui.filter === "active") return projected.filter((task) => ACTIVE_TASK_STATUSES.has(normalizedStatus(task.status)));
    if (state.ui.filter === "attention") return projected.filter(taskNeedsAttention);
    if (state.ui.filter === "incomplete") return projected.filter((task) => !taskIsComplete(task));
    return projected;
  }
  function stageComplete(stage) { return ["completed", "complete", "integrated", "accepted"].includes(normalizedStatus(stage?.status)); }
  function workflowStage(workspace, stage, index) {
    const progress = stage.progress || {};
    const tasks = stageTasks(workspace, stage);
    const total = number(progress.total, (stage.tasks || stage.taskIds || []).length);
    const completed = number(progress.completed, (stage.tasks || []).filter(taskIsComplete).length);
    const percent = total ? Math.min(100, Math.round(completed / total * 100)) : 0;
    const collapsed = state.ui.collapseCompleted && stageComplete(stage);
    const concurrent = stage.mode === "concurrent"; const sequential = stage.mode === "sequential";
    return `<li class="pipeline-stage tone-border-${statusTone(stage.status)} ${normalizedStatus(stage.status) === "running" ? "is-active" : ""}"><article><header class="stage-header"><span class="stage-number" aria-hidden="true">${index + 1}</span><div><p class="eyebrow">Stage ${index + 1} · ${escapeHtml(stage.mode || "unknown")}</p><h3>${escapeHtml(stage.title || stage.id)}</h3><code>${escapeHtml(stage.id)}</code></div>${badge(stage.status || "pending", "status")}</header><div class="stage-progress" role="progressbar" aria-label="${escapeHtml(stage.id)} task progress" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${completed}"><span style="width:${percent}%"></span></div><p class="stage-progress-label">${completed} of ${total} tasks complete · ${percent}%</p>${collapsed ? `<p class="collapsed-stage">Completed stage collapsed</p>` : `<div class="stage-work ${concurrent ? "is-concurrent" : sequential ? "is-sequential" : "is-unknown"}">${concurrent ? `<p class="fork-label"><span aria-hidden="true">⑂</span> Fork · ${tasks.length} parallel workstreams</p>` : ""}<ol class="stage-task-list ${concurrent ? "concurrent-grid" : sequential ? "sequential-chain" : "unknown-chain"}" aria-label="Tasks in ${escapeHtml(stage.id)}">${tasks.map(workflowTask).join("") || `<li class="filtered-empty">No tasks match this filter.</li>`}</ol>${concurrent ? `<p class="join-label"><span aria-hidden="true">⑂</span> Join · all workstreams converge</p>` : ""}</div><footer class="gate-footer" aria-label="${escapeHtml(stage.id)} gates"><ol>${gate("Tasks", { status: total && completed === total ? "completed" : stage.status }, "tasks-gate")}${gate("Integration", stage.integration)}${gate("Verification", stage.verification)}${gate("Review", stage.review)}</ol></footer>`}</article></li>`;
  }
  function metric(label, value, detail = "") { return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>${detail ? `<span>${escapeHtml(detail)}</span>` : ""}</div>`; }
  function duration(value) {
    const milliseconds = number(value);
    if (!milliseconds) return "0s";
    if (milliseconds < 60000) return `${Math.round(milliseconds / 1000)}s`;
    const minutes = Math.floor(milliseconds / 60000); const seconds = Math.round(milliseconds % 60000 / 1000);
    return `${minutes}m ${seconds}s`;
  }
  function workflowMetrics(workspace) {
    const workflow = workspace.workflow || {};
    const tasks = (workspace.stages || []).flatMap((stage) => stage.tasks || []);
    const totalTasks = number(workflow.totals?.tasks?.total ?? workflow.totals?.tasks ?? workflow.aggregates?.taskTotal, tasks.length || workspace.tasks?.length);
    const completeTasks = number(workflow.totals?.tasks?.completed ?? workflow.aggregates?.tasksCompleted, tasks.filter(taskIsComplete).length);
    const checks = workflow.totals?.checks || workflow.aggregates?.checks || {};
    const repairs = number(workflow.totals?.repairs ?? workflow.aggregates?.repairCount ?? workflow.metrics?.repairCount);
    const evidence = number(workflow.evidenceCount);
    const metrics = workflow.metrics || {};
    const runtime = metrics.workflowMs == null ? "" : metric("Runtime", duration(metrics.workflowMs), metrics.incompleteIntervals ? "timing in progress" : "workflow time");
    return `<dl class="metric-strip" aria-label="Workflow metrics">${metric("Tasks", `${completeTasks}/${totalTasks}`, "complete")}${metric("Checks", `${number(checks.passed)}/${number(checks.total, number(checks.passed) + number(checks.failed) + number(checks.running))}`, number(checks.failed) ? `${number(checks.failed)} failed` : "passed / total")}${metric("Repairs", repairs)}${metric("Evidence", evidence, evidence === 1 ? "item" : "items")}${runtime}</dl>`;
  }
  function workflowHero(workspace) {
    const workflow = workspace.workflow || {};
    const total = (workspace.stages || []).reduce((sum, stage) => sum + number(stage.progress?.total, stage.tasks?.length || stage.taskIds?.length), 0);
    const completed = (workspace.stages || []).reduce((sum, stage) => sum + number(stage.progress?.completed, (stage.tasks || []).filter(taskIsComplete).length), 0);
    const percent = total ? Math.min(100, Math.round(completed / total * 100)) : 0;
    const current = workflow.currentStageId || workflow.currentPhase;
    return `<section class="workflow-hero" aria-labelledby="workflow-title"><p class="sr-only" role="status" aria-live="polite">Workflow ${escapeHtml(workflow.status || "unknown")}; ${completed} of ${total} tasks complete.</p><div class="hero-copy"><p class="eyebrow">Delivery operations</p><h2 id="workflow-title">Workflow</h2><p>${current ? `Current focus · ${escapeHtml(current)}` : "Ordered execution and quality gates"}</p></div><div class="hero-status">${badge(workflow.status || "unknown", "status hero-badge")}<span>Outcome · ${escapeHtml(workflow.outcomeStatus || "pending")}</span></div><div class="hero-progress"><div><strong>${percent}%</strong><span>${completed} of ${total} tasks</span></div><div class="workflow-progress" role="progressbar" aria-label="Overall workflow progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div></div>${state.stale ? `<p class="stale-indicator" role="status"><span aria-hidden="true">↻</span> ${escapeHtml(state.stale)} <button type="button" class="link-button" data-action="retry-live">Retry live updates</button></p>` : ""}</section>`;
  }
  function workflowControls() {
    const filters = [["all", "All"], ["active", "Active"], ["attention", "Attention"], ["incomplete", "Incomplete"]];
    return `<section class="workflow-controls" aria-label="Workflow display controls"><div class="segmented" aria-label="Task filter">${filters.map(([value, label]) => `<button type="button" data-filter="${value}" aria-pressed="${state.ui.filter === value}">${label}</button>`).join("")}</div><div class="control-cluster"><div class="segmented density-control" aria-label="Display density"><button type="button" data-density="compact" aria-pressed="${state.ui.density === "compact"}">Compact</button><button type="button" data-density="comfortable" aria-pressed="${state.ui.density === "comfortable"}">Comfortable</button></div><button type="button" class="collapse-control" data-action="collapse-completed" aria-pressed="${state.ui.collapseCompleted}">Collapse completed</button></div></section>`;
  }
  function endCap(workspace) {
    const workflow = workspace.workflow || {};
    const outcomeStatus = workflow.outcomeStatus || "pending";
    return `<section class="workflow-endcap" aria-labelledby="endcap-title"><div><p class="eyebrow">Completion path</p><h2 id="endcap-title">Final assurance</h2></div><ol>${gate("Whole-branch review", workspace.finalReview, "final-gate")}${gate("Final E2E", workspace.finalE2E, "final-gate")}${gate("Outcome", { status: outcomeStatus, ...(normalizedStatus(outcomeStatus) === "written" ? { documentId: "outcome" } : {}) }, "outcome-gate")}</ol></section>`;
  }
  function workflowView(workspace) {
    const attention = attentionEntries(workspace.workflow?.attention);
    const topAttention = workspace.workflow?.topAttention;
    return `<div class="workflow-view density-${state.ui.density}">${workflowHero(workspace)}${workflowMetrics(workspace)}${attention.length ? `<aside class="attention-rail" aria-label="Workflow attention"><strong>${attentionTotal(workspace.workflow?.attention)} need attention</strong><ul>${attention.map(([label, count]) => `<li><span>${escapeHtml(label)}</span><strong>${count}</strong></li>`).join("")}</ul>${topAttention ? `<p>${escapeHtml([topAttention.code, topAttention.summary].filter(Boolean).join(" · "))}</p>` : ""}</aside>` : ""}${workflowControls()}<section class="workflow-pipeline-section" aria-labelledby="pipeline-title"><div class="section-heading"><div><p class="eyebrow">Global sequence</p><h2 id="pipeline-title">Stage pipeline</h2></div><span>${number(workspace.stages?.length)} ordered stages</span></div><ol class="workflow-pipeline">${(workspace.stages || []).map((stage, index) => workflowStage(workspace, stage, index)).join("") || `<li class="boundary"><p>No delivery stages are available.</p></li>`}</ol></section>${endCap(workspace)}</div>`;
  }
  function board(workspace) {
    return `<section><div class="section-heading"><h2>Task board</h2><span>${workspace.tasks?.length || 0} tasks</span></div><div class="board" aria-label="Task board">${COLUMNS.map((column) => { const tasks = workspace.columns?.[column] || []; return `<section class="column" aria-labelledby="column-${column.replaceAll(" ", "-")}"><h2 id="column-${column.replaceAll(" ", "-")}">${column} <span>${tasks.length}</span></h2><div class="cards">${tasks.map((task) => `<article class="task-card"><button type="button" data-task="${escapeHtml(task.id)}" aria-label="Open task ${escapeHtml(task.title)}"><strong>${escapeHtml(task.title)}</strong>${badge(task.status, "status")}${task.stage ? `<span>Stage: ${escapeHtml(task.stage)}</span>` : ""}${task.dependsOn?.length ? `<span>Depends on: ${task.dependsOn.map(escapeHtml).join(", ")}</span>` : ""}${task.degraded ? badge("Degraded", "warning") : ""}</button>${diagnostics(task.diagnostics)}</article>`).join("") || `<p class="empty-column">No tasks</p>`}</div></section>`; }).join("")}</div></section>`;
  }
  function documents(workspace) {
    return `<section class="document-groups"><h2>Documents</h2>${(workspace.documentGroups || []).map(({ group, documents }) => `<details><summary>${escapeHtml(group)} <span>${documents.length}</span></summary><ul>${documents.map((document) => `<li><button type="button" data-document="${escapeHtml(document.id)}" ${document.available ? "" : "disabled"}>${escapeHtml(document.title)} ${badge(document.status)}</button>${diagnostics(document.diagnostics)}</li>`).join("")}</ul></details>`).join("")}</section>`;
  }
  function reports(workspace) {
    const items = workspace.reports || [];
    return `<section><h2>Reports</h2>${items.length ? `<ul class="report-list">${items.map((report) => `<li><button type="button" data-report="${escapeHtml(report.id)}" ${report.available ? "" : "disabled"}><strong>${escapeHtml(report.id)}</strong>${badge(report.verdict || report.status)}<span>${escapeHtml(report.scope?.kind)}${report.scope?.id ? ` · ${escapeHtml(report.scope.id)}` : ""}</span><span>${report.attempt ? `Attempt ${report.attempt} · ` : ""}${number(report.findingCount)} findings${report.hasRiskAcceptance ? " · accepted risk" : ""}</span></button>${diagnostics(report.diagnostics)}</li>`).join("")}</ul>` : `<div class="boundary"><p>No reports available.</p></div>`}</section>`;
  }
  function markdownSection(title, body) { return body ? `<section><h3>${title}</h3><div class="markdown">${renderMarkdown(body)}</div></section>` : ""; }
  function taskDetail(task) {
    return `<p>${badge(task.status, "status")}${task.stage ? ` ${badge(`Stage: ${task.stage}`)}` : ""}</p>${task.dependsOn?.length ? `<p><strong>Dependencies:</strong> ${task.dependsOn.map(escapeHtml).join(", ")}</p>` : ""}${markdownSection("Description", task.brief)}${markdownSection("Scope", task.scope)}${task.assignment ? `<section><h3>Assignment</h3><p>${escapeHtml(task.assignment.agent)}${task.assignment.tier ? ` · ${escapeHtml(task.assignment.tier)}` : ""}</p>${task.assignment.rationale ? `<p>${escapeHtml(task.assignment.rationale)}</p>` : ""}</section>` : ""}${markdownSection("Delivery", task.delivery)}${markdownSection("Acceptance", task.acceptance)}<section><h3>Verification</h3><ul>${[...(task.verification?.methods || []), ...(task.verification?.taskChecks || [])].map((check) => `<li><code>${escapeHtml(check)}</code></li>`).join("") || "<li>Not specified</li>"}</ul></section>${renderDeliveryHistory(task.deliveryHistory)}${task.relatedReportIds?.length ? `<section><h3>Related reports</h3><ul>${task.relatedReportIds.map((id) => `<li><button class="link-button" data-related-report="${escapeHtml(id)}">${escapeHtml(id)}</button></li>`).join("")}</ul></section>` : ""}${diagnostics(task.diagnostics)}`;
  }
  function evidence(report) {
    if (!report.evidence?.length) return "";
    return `<section><h3>Evidence</h3><ul class="evidence">${report.evidence.map((item) => { const mode = evidencePresentation(item); const label = item.description || item.path || item.id; const member = item.memberPath || item.path?.split(`/evidence/${report.id}/`)[1]; if (mode === "image" && member) { const src = `api/evidence?story=${encodeURIComponent(state.route.storyId)}&evaluation=${encodeURIComponent(report.id)}&path=${encodeURIComponent(member)}`; return `<li><figure><img src="${src}" alt="${escapeHtml(label)}" loading="lazy"><figcaption>${escapeHtml(label)}</figcaption></figure></li>`; } if (mode === "text" && member) return `<li><a href="api/evidence?story=${encodeURIComponent(state.route.storyId)}&evaluation=${encodeURIComponent(report.id)}&path=${encodeURIComponent(member)}" target="_blank">${escapeHtml(label)} (text evidence)</a></li>`; return `<li><strong>${escapeHtml(label)}</strong>: ${mode === "missing" ? "Evidence missing" : "Unsupported evidence type"}${diagnostics(item.diagnostics)}</li>`; }).join("")}</ul></section>`;
  }
  function reportDetail(report) {
    return `<p>${badge(report.verdict || report.status)} ${badge(`${report.scope?.kind || "report"}${report.scope?.id ? `: ${report.scope.id}` : ""}`)}${report.attempt ? ` ${badge(`Attempt ${report.attempt}`)}` : ""}</p>${report.taskId ? `<button type="button" data-go-task="${escapeHtml(report.taskId)}">Go to task</button>` : ""}${markdownSection("Result", report.body)}${report.history?.length ? `<section><h3>Attempts</h3><ol>${report.history.map((attempt) => `<li><strong>Attempt ${attempt.attempt}</strong>${attempt.available ? renderMarkdown(attempt.body || "No detail recorded.") : " — missing"}</li>`).join("")}</ol></section>` : ""}<section><h3>Findings</h3>${report.findings?.length ? `<ul>${report.findings.map((finding) => `<li>${badge(finding.severity)} ${badge(finding.status)} <div class="markdown">${renderMarkdown(finding.summary)}</div>${finding.location ? `<code>${escapeHtml(finding.location)}</code>` : ""}</li>`).join("")}</ul>` : "<p>No findings.</p>"}</section>${markdownSection("Accepted risk", report.riskAcceptance)}${evidence(report)}${diagnostics(report.diagnostics)}`;
  }
  function drawer() {
    const id = state.route.taskId || state.route.documentId || state.route.reportId;
    if (!id) return "";
    let title = id; let content;
    if (state.detailLoading) content = `<p role="status">Loading detail…</p>`;
    else if (state.detail?.error) content = errorRegion(state.detail.error, "retry-detail");
    else if (state.detail) { title = state.detail.title || state.detail.id; content = state.route.taskId ? taskDetail(state.detail) : state.route.documentId ? markdownSection("Document", state.detail.body) || "<p>Document content is missing.</p>" : reportDetail(state.detail); }
    return `<aside class="drawer detail-sheet" role="dialog" aria-modal="true" aria-labelledby="detail-title"><header><h2 id="detail-title">${escapeHtml(title)}</h2><button type="button" data-action="close-detail" aria-label="Close detail">×</button></header><div class="drawer-content">${content || ""}</div></aside><div class="scrim" data-action="close-detail" aria-hidden="true"></div>`;
  }
  function workspace() {
    if (state.loading) return `<section class="boundary" role="status"><span class="spinner" aria-hidden="true"></span> Loading story…</section>`;
    if (state.error) return errorRegion(state.error, "retry");
    const workspace = state.workspace;
    const body = state.route.view === "workflow" ? workflowView(workspace) : state.route.view === "documents" ? documents(workspace) : state.route.view === "reports" ? reports(workspace) : board(workspace);
    return `${header(workspace)}<div class="workspace-body">${workspace.story?.degraded ? `<div class="degraded-banner" role="status">Some story content is degraded.${diagnostics(workspace.diagnostics)}</div>` : ""}${body}</div>${drawer()}`;
  }
  function focusSelector(element) {
    if (!element || !root.contains(element)) return undefined;
    for (const attribute of ["data-task", "data-report", "data-related-report", "data-go-task", "data-document", "data-filter", "data-density", "data-action", "data-view", "href"]) {
      if (element.hasAttribute?.(attribute)) return `[${attribute}="${String(element.getAttribute(attribute)).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`;
    }
    return element.id ? `#${CSS.escape(element.id)}` : undefined;
  }
  function captureInteractionState() {
    return { focus: focusSelector(document.activeElement), drawerScrollTop: root.querySelector(".drawer")?.scrollTop };
  }
  function restoreInteractionState(interaction) {
    if (!interaction) return;
    if (Number.isFinite(interaction.drawerScrollTop)) { const drawer = root.querySelector(".drawer"); if (drawer) drawer.scrollTop = interaction.drawerScrollTop; }
    if (interaction.focus) (root.querySelector(interaction.focus) ?? root.querySelector('.drawer [data-action="close-detail"]') ?? root.querySelector(`[data-view="${state.route.view}"]`))?.focus({ preventScroll: true });
  }
  function render() {
    const willShowDrawer = Boolean(state.route.taskId || state.route.documentId || state.route.reportId);
    root.innerHTML = state.route.view === "catalog" ? catalog() : workspace();
    if (willShowDrawer && !drawerVisible) queueMicrotask(() => root.querySelector('[data-action="close-detail"]')?.focus());
    drawerVisible = willShowDrawer;
  }
  function closeDetail() {
    const route = { view: state.route.view, storyId: state.route.storyId };
    const focusTarget = returnFocus;
    returnFocus = undefined;
    detailGate.cancel(); setRoute(route);
    queueMicrotask(() => { const target = focusTarget ? root.querySelector(focusTarget) : undefined; (target ?? root.querySelector(`[data-view="${route.view}"]`))?.focus(); });
  }
  function updateUi(key, value, focusSelector) {
    state.ui[key] = value;
    render();
    queueMicrotask(() => root.querySelector(focusSelector)?.focus());
  }
  root.addEventListener("click", (event) => {
    const target = event.target.closest("a,button,[data-action]"); if (!target) return;
    if (target.matches("[data-route]")) { event.preventDefault(); setRoute(parseRoute(new URL(target.href).pathname)); return; }
    if (target.dataset.filter) updateUi("filter", target.dataset.filter, `[data-filter="${target.dataset.filter}"]`);
    else if (target.dataset.density) updateUi("density", target.dataset.density, `[data-density="${target.dataset.density}"]`);
    else if (target.dataset.task) { returnFocus = `[data-task="${target.dataset.task}"]`; setRoute({ view: state.route.view === "workflow" ? "workflow" : "board", storyId: state.route.storyId, taskId: target.dataset.task }); }
    else if (target.dataset.document) { returnFocus = `[data-document="${target.dataset.document}"]`; setRoute({ view: "documents", storyId: state.route.storyId, documentId: target.dataset.document }); }
    else if (target.dataset.report) { returnFocus = `[data-report="${target.dataset.report}"]`; setRoute({ view: state.route.view === "workflow" ? "workflow" : "reports", storyId: state.route.storyId, reportId: target.dataset.report }); }
    else if (target.dataset.relatedReport) { returnFocus = state.route.view === "workflow" ? '[data-view="workflow"]' : `[data-report="${target.dataset.relatedReport}"]`; setRoute({ view: state.route.view === "workflow" ? "workflow" : "reports", storyId: state.route.storyId, reportId: target.dataset.relatedReport }); }
    else if (target.dataset.goTask) { returnFocus = `[data-task="${target.dataset.goTask}"]`; setRoute({ view: state.route.view === "workflow" ? "workflow" : "board", storyId: state.route.storyId, taskId: target.dataset.goTask }); }
    else if (target.dataset.action === "catalog") setRoute({ view: "catalog" });
    else if (target.dataset.action === "refresh") void refresh();
    else if (target.dataset.action === "retry") void loadRoute();
    else if (target.dataset.action === "retry-live") { pollFailures = 0; state.stale = undefined; syncPolling({ immediate: true }); render(); }
    else if (target.dataset.action === "retry-detail") void loadDetail();
    else if (target.dataset.action === "collapse-completed") updateUi("collapseCompleted", !state.ui.collapseCompleted, '[data-action="collapse-completed"]');
    else if (target.dataset.action === "close-detail") closeDetail();
  });
  root.addEventListener("keydown", (event) => {
    const open = state.route.taskId || state.route.documentId || state.route.reportId;
    if (event.key === "Escape" && open) { closeDetail(); return; }
    if (event.key !== "Tab" || !open) return;
    const drawer = root.querySelector(".drawer");
    const controls = [...drawer.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (!controls.length) return;
    const first = controls[0]; const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  function handleVisibility() {
    if (document.visibilityState === "hidden") { stopPolling(); return; }
    if (!pageHidden) syncPolling({ immediate: true });
  }
  function handlePageHide() { pageHidden = true; stopPolling(); }
  function handlePageShow() { pageHidden = false; syncPolling({ immediate: true }); }
  function handlePopState() { if (currentPath() === "/story-board" || currentPath().startsWith("/story-board/")) void loadRoute(); }
  function handleShellActivity(event) {
    if (event.source !== navigationWindow || event.origin !== navigationWindow.location.origin || event.data?.type !== SHELL_ACTIVITY_MESSAGE) return;
    const next = event.data.active === true;
    if (next === shellActive) return;
    shellActive = next;
    if (shellActive) syncPolling({ immediate: true }); else stopPolling();
  }
  navigationWindow.addEventListener("popstate", handlePopState);
  window.addEventListener("message", handleShellActivity);
  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("pageshow", handlePageShow);
  document.addEventListener("visibilitychange", handleVisibility);
  void loadRoute();
  return {
    state, loadRoute,
    destroy() {
      destroyed = true; stopPolling(); pageGate.cancel(); detailGate.cancel();
      navigationWindow.removeEventListener("popstate", handlePopState);
      window.removeEventListener("message", handleShellActivity);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
      document.removeEventListener("visibilitychange", handleVisibility);
    },
  };
}

if (typeof document !== "undefined") createStoryBoardApp({ root: document.querySelector("#app") });
