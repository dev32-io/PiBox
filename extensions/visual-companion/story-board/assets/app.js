const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLUMNS = ["To do", "In progress", "Done"];
const COMPLETE_TASK_STATUSES = new Set(["accepted", "merged", "staged", "integrated", "completed", "cancelled"]);
const ACTIVE_STAGE_TASK_STATUSES = new Set(["implementing", "check_pending", "checking", "repairing"]);
const ACTIVE_STAGE_OPERATION_STATUSES = {
  integration: new Set(["integrating", "repairing"]),
  verification: new Set(["checking", "repairing"]),
  review: new Set(["reviewing", "fixing"]),
};
const DISCLOSURE_ATTENTION_STATUSES = new Set(["attention", "interrupted"]);
const DISCLOSURE_COMPLETED_STATUSES = new Set(["complete", "completed", "accepted", "merged", "staged", "integrated", "passed", "written", "success", "cancelled"]);
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
function stageChildren(stage) { return [...(stage?.tasks || []), stage?.integration, stage?.verification, stage?.review].filter(Boolean); }
export function stageHasActiveChildWork(stage) {
  if ((stage?.tasks || []).some((task) => ACTIVE_STAGE_TASK_STATUSES.has(normalizedStatus(task?.status)))) return true;
  return Object.entries(ACTIVE_STAGE_OPERATION_STATUSES).some(([phase, statuses]) => statuses.has(normalizedStatus(stage?.[phase]?.status)));
}
export function stageDefaultExpanded(stage) {
  return ["attention", "interrupted", "active"].includes(stageDisclosureLifecycle(stage));
}
export function stageDisclosureLifecycle(stage) {
  const statuses = [stage?.status, ...stageChildren(stage).map((child) => child?.status)].map(normalizedStatus);
  if (statuses.includes("attention")) return "attention";
  if (statuses.includes("interrupted")) return "interrupted";
  if (stageHasActiveChildWork(stage)) return "active";
  const stageStatus = normalizedStatus(stage?.status);
  if (stageStatus === "running") return "capacity/idle-running";
  if (DISCLOSURE_COMPLETED_STATUSES.has(stageStatus)) return "completed";
  return "pending/other";
}
export function stageIsExpanded(storyId, stage, manualChoices = {}) {
  const choice = manualChoices?.[storyId]?.[stage?.id];
  return choice?.lifecycle === stageDisclosureLifecycle(stage) ? Boolean(choice.expanded) : stageDefaultExpanded(stage);
}
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
    ui: { stageDisclosureChoices: {} },
  };
  const pageGate = createRequestGate();
  const detailGate = createRequestGate();
  const pollGate = createRequestGate();
  let returnFocus;
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
        refreshTimingLabels();
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
      if (state.route.taskId || state.route.reportId) void loadDetail(interaction, { preserveContent: true });
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
      const hasDetail = Boolean(route.taskId || route.documentId || route.reportId);
      pageGate.cancel(); detailGate.cancel(); state.detail = undefined; state.detailLoading = hasDetail; render();
      if (hasDetail) void loadDetail(undefined, { preserveContent: true });
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
  async function loadDetail(preservedInteraction, { preserveContent = false } = {}) {
    const { storyId, taskId, documentId, reportId } = state.route;
    const kind = taskId ? "task" : documentId ? "document" : "report";
    const id = taskId || documentId || reportId;
    if (!id) return;
    const token = detailGate.next(); const openingInteraction = preservedInteraction ?? captureInteractionState();
    if (!preserveContent || !state.detail) { state.detailLoading = true; if (!preserveContent) state.detail = undefined; render(); restoreInteractionState(openingInteraction); }
    try {
      const payload = await request(`api/${kind}?story=${encodeURIComponent(storyId)}&${kind}=${encodeURIComponent(id)}`, { signal: token.signal });
      if (!detailGate.current(token.generation)) return;
      const settledInteraction = captureInteractionState(); state.detail = payload[kind]; state.detailLoading = false; render(); restoreInteractionState(settledInteraction);
    } catch (error) { if (detailGate.current(token.generation) && error?.name !== "AbortError") { const settledInteraction = captureInteractionState(); state.detailLoading = false; state.detail = { error: error.message }; render(); restoreInteractionState(settledInteraction); } }
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
    if (!total) return "";
    const pending = Math.max(0, total - passed - failed - running);
    const detail = [`${passed} passed`, failed ? `${failed} failed` : "", running ? `${running} running` : "", pending ? `${pending} pending` : ""].filter(Boolean).join(", ");
    return `<span class="task-tag task-checks" title="${escapeHtml(detail)}">${dashboardIcon("checks")}<span class="sr-only">Checks: ${escapeHtml(detail)}. </span><span aria-hidden="true">${passed}/${total}</span></span>`;
  }
  function summaryLine(label, value, className = "") {
    if (value == null || value === "") return "";
    const content = typeof value === "object" ? [value.code, value.summary].filter(Boolean).join(" · ") : value;
    return content ? `<p class="${className}"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(content)}</p>` : "";
  }
  function workflowTask(task, executionMode) {
    const wait = number(task?.incompleteDependencyCount);
    const repairs = number(task?.repairCount);
    const dependencies = task?.dependsOn || [];
    const mode = executionMode === "concurrent" ? "concurrent" : executionMode === "sequential" ? "sequential" : "unknown";
    const dependencyLabel = dependencies.length ? dependencies.join(", ") : `${wait} incomplete`;
    const dependencyTag = dependencies.length || wait ? `<span class="task-tag task-dependency-tag ${wait ? "is-waiting" : ""}" title="${escapeHtml(`Dependencies: ${dependencyLabel}`)}">${dashboardIcon(wait ? "waiting" : "dependencies")}<span class="sr-only">${wait ? `Waiting on ${wait} incomplete dependencies` : `Dependencies: ${dependencyLabel}`}. </span><span aria-hidden="true">${wait ? `${wait} waiting` : `${dependencies.length} dependencies`}</span></span>` : "";
    const repairTag = repairs ? `<span class="task-tag task-repair-tag">${dashboardIcon("repairs")}<span>${repairs} ${repairs === 1 ? "repair" : "repairs"}</span></span>` : "";
    return `<li class="workflow-task is-${mode}-task tone-border-${statusTone(task?.status)}"><button type="button" data-task="${escapeHtml(task?.id)}"><span class="sr-only">Open task detail. </span><span class="task-primary-row"><span class="task-marker" aria-hidden="true">${dashboardIcon(mode)}</span><strong class="task-title">${escapeHtml(task?.title || task?.id)}</strong><span class="task-status-text tone-${statusTone(task?.status)}">${escapeHtml(titleCase(task?.status || "unknown"))}</span></span><span class="task-metadata-row"><code class="task-id">${escapeHtml(task?.id)}</code>${taskChecks(task)}${dependencyTag}${repairTag}</span>${summaryLine("Failure", task?.failure, "task-failure")}</button></li>`;
  }
  function gateDetails(gate) {
    if (!gate) return "";
    const checks = gate.checks || {};
    const passed = number(checks.passed); const failed = number(checks.failed); const running = number(checks.running);
    const checkTotal = number(checks.total, passed + failed + running); const pending = Math.max(0, checkTotal - passed - failed - running);
    const checkText = [passed ? `${passed} passed` : "", failed ? `${failed} failed` : "", running ? `${running} running` : "", pending ? `${pending} pending` : ""].filter(Boolean).join(" · ");
    const findings = gate.findings || gate.findingSeverityTotals || gate.findingSeverities;
    const findingText = findings && typeof findings === "object" ? Object.entries(findings).filter(([severity, count]) => severity !== "total" && number(count) > 0).map(([severity, count]) => `${number(count)} ${severity}`).join(" · ") : "";
    return `${gate.caption ? `<span>${escapeHtml(gate.caption)}</span>` : ""}${checkTotal ? `<span>${escapeHtml(checkText || `${checkTotal} checks`)}</span>` : ""}${number(gate.repairCount) ? `<span>${number(gate.repairCount)} repairs</span>` : ""}${findingText ? `<span>${escapeHtml(findingText)} findings</span>` : ""}${summaryLine("Failure", gate.failure, "task-failure")}`;
  }
  function gate(label, value, kind = "gate") {
    const iconKind = label === "Implementation" ? "implementation" : label === "Integration" ? "integration" : label === "Verification" ? "verification" : label === "Final E2E" ? "e2e" : label === "Outcome" ? "outcome" : "review";
    const content = `<span class="gate-icon" aria-hidden="true">${dashboardIcon(iconKind)}</span><span class="gate-name">${escapeHtml(label)}</span>${badge(value?.status || "pending", "status")}<div class="gate-detail">${gateDetails(value)}</div>`;
    const action = value?.reportId ? { attribute: `data-report="${escapeHtml(value.reportId)}"`, label: "Open report. " } : value?.documentId ? { attribute: `data-document="${escapeHtml(value.documentId)}"`, label: "Open document. " } : undefined;
    return `<li class="workflow-gate phase-${iconKind} ${kind} tone-border-${statusTone(value?.status)}">${action ? `<button type="button" ${action.attribute}><span class="sr-only">${action.label}</span>${content}</button>` : `<div>${content}</div>`}</li>`;
  }
  function stageTasks(workspace, stage) {
    return Array.isArray(stage.tasks) && stage.tasks.length ? stage.tasks : (stage.taskIds || []).map((id) => (workspace.tasks || []).find((task) => task.id === id) || { id, title: id, status: "unknown" });
  }
  function timingMilliseconds(timing, category) {
    if (!timing) return 0;
    let milliseconds = number(category ? timing.categories?.[category] : timing.workflowMs);
    if ((!category || timing.activeCategory === category) && timing.activeSince) {
      const since = Date.parse(timing.activeSince); if (Number.isFinite(since)) milliseconds += Math.max(0, Date.now() - since);
    }
    return milliseconds;
  }
  function timingValue(timing, category) {
    if (!timing) return `<span class="timing-unavailable">Not recorded</span>`;
    const base = number(category ? timing.categories?.[category] : timing.workflowMs);
    const active = Boolean(timing.activeSince && (!category || timing.activeCategory === category));
    return `<span data-timing-base="${base}"${active ? ` data-timing-since="${escapeHtml(timing.activeSince)}"` : ""}>${duration(timingMilliseconds(timing, category))}</span>`;
  }
  function stageTiming(stage) {
    const timing = stage.timing;
    if (!timing) return `<p class="stage-timing-unavailable">Stage timing was not recorded for this run.</p>`;
    const categories = [["Implementation", "implementation"], ["Integration", "integration"], ["Verification", "verification"], ["Review", "review"]];
    return `<section class="stage-timing" aria-label="${escapeHtml(stage.id)} timing"><div><strong>Stage time</strong>${timingValue(timing)}</div>${categories.map(([label, category]) => `<div><span>${label}</span>${timingValue(timing, category)}</div>`).join("")}${timing.incompleteIntervals ? `<p>${number(timing.incompleteIntervals)} interrupted timing ${number(timing.incompleteIntervals) === 1 ? "interval was" : "intervals were"} excluded.</p>` : ""}</section>`;
  }
  function stageExceptionCount(stage) {
    const children = stageChildren(stage);
    const childExceptions = children.reduce((total, child) => {
      const findings = child?.findings || child?.findingSeverityTotals || child?.findingSeverities;
      const findingCount = findings && typeof findings === "object" ? number(findings.total, Object.entries(findings).filter(([severity]) => severity !== "total").reduce((sum, [, count]) => sum + number(count), 0)) : 0;
      return total + number(child?.repairCount) + number(child?.checks?.failed) + findingCount + (child?.failure ? 1 : 0) + (DISCLOSURE_ATTENTION_STATUSES.has(normalizedStatus(child?.status)) ? 1 : 0);
    }, 0);
    return childExceptions + (DISCLOSURE_ATTENTION_STATUSES.has(normalizedStatus(stage?.status)) ? 1 : 0);
  }
  function stageDisclosureLabel({ expanded, title, modeName, status, completed, total, timing, exceptions }) {
    return [
      `${expanded ? "Collapse" : "Expand"} ${title}`,
      `${modeName} mode`,
      `Status: ${titleCase(status || "pending")}`,
      `${completed} of ${total} tasks complete`,
      timing ? `Duration: ${duration(timingMilliseconds(timing))}` : "",
      exceptions ? `${exceptions} ${exceptions === 1 ? "exception" : "exceptions"}` : "",
    ].filter(Boolean).join(". ");
  }
  function workflowStage(workspace, stage, index) {
    const progress = stage.progress || {};
    const tasks = stageTasks(workspace, stage);
    const total = number(progress.total, (stage.tasks || stage.taskIds || []).length);
    const completed = number(progress.completed, (stage.tasks || []).filter(taskIsComplete).length);
    const percent = total ? Math.min(100, Math.round(completed / total * 100)) : 0;
    const storyId = workspace.story?.id || state.route.storyId;
    const expanded = stageIsExpanded(storyId, stage, state.ui.stageDisclosureChoices);
    const collapsed = !expanded;
    const mode = stage.mode === "concurrent" ? "concurrent" : stage.mode === "sequential" ? "sequential" : "unknown";
    const modeName = mode === "concurrent" ? "Concurrent" : mode === "sequential" ? "Sequential" : "Unknown";
    const modeLabel = mode === "concurrent" ? `Concurrent · ${tasks.length} workstreams` : mode === "sequential" ? `Sequential · ${tasks.length} ordered tasks` : "Execution mode unknown";
    const taskClass = mode === "concurrent" ? "parallel-list" : mode === "sequential" ? "sequential-chain" : "unknown-chain";
    const title = stage.title || stage.id;
    const stageIdLabel = title === stage.id ? "" : `<code>${escapeHtml(stage.id)}</code>`;
    const exceptions = stageExceptionCount(stage);
    const exceptionSummary = exceptions ? `<span>${exceptions} ${exceptions === 1 ? "exception" : "exceptions"}</span>` : "";
    const disclosureLabel = stageDisclosureLabel({ expanded, title, modeName, status: stage.status, completed, total, timing: stage.timing, exceptions });
    const headingId = `stage-${stage.id}-title`;
    const detailsId = `stage-${stage.id}-details`;
    return `<li class="pipeline-stage mode-${mode} tone-border-${statusTone(stage.status)} ${stageHasActiveChildWork(stage) ? "is-active" : ""} ${expanded ? "is-expanded" : "is-collapsed"}"><article><h3 id="${escapeHtml(headingId)}" class="sr-only">${escapeHtml(title)}</h3><button type="button" class="stage-header stage-disclosure" data-stage-disclosure="${escapeHtml(stage.id)}" aria-expanded="${expanded}" aria-controls="${escapeHtml(detailsId)}" aria-label="${escapeHtml(disclosureLabel)}"><span class="stage-number" aria-hidden="true">${index + 1}</span><span class="stage-heading"><span class="stage-mode-label"><span class="mode-icon" aria-hidden="true">${dashboardIcon(mode)}</span><span>Stage ${index + 1} · ${modeName}</span></span><span class="stage-title" aria-hidden="true">${escapeHtml(title)}</span>${stageIdLabel}</span><span class="stage-state">${badge(stage.status || "pending", "status")}<span class="stage-collapsed-summary"${expanded ? " hidden" : ""}><span>${completed}/${total} complete</span><span>${timingValue(stage.timing)}</span>${exceptionSummary}</span><span class="stage-chevron" aria-hidden="true">${dashboardIcon("chevron")}</span></span></button><div id="${escapeHtml(detailsId)}" class="stage-details"${collapsed ? " hidden" : ""}><div class="stage-progress" role="progressbar" aria-label="${escapeHtml(stage.id)} task progress" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${completed}"><span style="width:${percent}%"></span></div><p class="stage-progress-label">${completed} of ${total} tasks complete · ${percent}%</p>${stageTiming(stage)}<div class="stage-work mode-${mode}"><p class="execution-mode"><span class="mode-icon" aria-hidden="true">${dashboardIcon(mode)}</span><span>${escapeHtml(modeLabel)}</span></p><ol class="stage-task-list ${taskClass}" aria-label="Tasks in ${escapeHtml(stage.id)}">${tasks.map((task) => workflowTask(task, mode)).join("") || `<li class="filtered-empty">No tasks available.</li>`}</ol>${mode === "concurrent" ? `<p class="join-label"><span aria-hidden="true">${dashboardIcon("join")}</span><span>Join · all workstreams converge before integration</span></p>` : ""}</div><footer class="gate-footer" aria-label="${escapeHtml(stage.id)} gates"><ol>${gate("Implementation", { status: total && completed === total ? "completed" : stage.status, caption: `${completed} of ${total} tasks delivered` }, "tasks-gate")}${gate("Integration", stage.integration)}${gate("Verification", stage.verification)}${gate("Review", stage.review)}</ol></footer></div></article></li>`;
  }
  function dashboardIcon(kind) {
    const paths = {
      tasks: '<path d="M5 6h14M5 12h14M5 18h9"/><path d="m3 6 .5.5L5 5m-2 7 .5.5L5 11m-2 7 .5.5L5 17"/>',
      gates: '<path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
      repairs: '<path d="M20 7h-6V1"/><path d="M20 7a9 9 0 1 0 1 8"/>',
      evidence: '<rect x="4" y="3" width="13" height="16" rx="2"/><path d="M8 7h5M8 11h5M8 15h3M17 7h3v14H8v-2"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      sequential: '<circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/><path d="M12 7v3m0 4v3"/>',
      concurrent: '<path d="M12 4v4m0 8v4M12 8 6 12m6-4 6 4M6 12v5m12-5v5"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/>',
      unknown: '<circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.4 2.4 0 1 1 3.4 2.2c-.8.4-1.2.9-1.2 1.8m0 3h.01"/>',
      chevron: '<path d="m8 10 4 4 4-4"/>',
      join: '<path d="M6 5v5l6 4 6-4V5M12 14v5"/>',
      checks: '<path d="m5 12 4 4L19 6"/>',
      dependencies: '<circle cx="6" cy="12" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="m8 12 8-5m-8 5 8 5"/>',
      waiting: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      implementation: '<path d="M4 19h16M6 16l4-4 3 3 5-7"/>',
      integration: '<path d="M5 6h5a4 4 0 0 1 4 4v8m5-12h-1a4 4 0 0 0-4 4"/><path d="m11 15 3 3 3-3"/>',
      verification: '<path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
      review: '<path d="M4 5h16v12H8l-4 4V5Z"/><path d="M8 9h8m-8 4h5"/>',
      e2e: '<path d="M4 12h5l2-5 3 10 2-5h4"/>',
      outcome: '<path d="M6 3h9l3 3v15H6V3Z"/><path d="M15 3v4h4M9 12h6m-6 4h6"/>',
    };
    return `<svg class="dashboard-icon icon-${escapeHtml(kind)}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[kind] || paths.clock}</svg>`;
  }
  function metricCard(kind, label, value, detail, progress) {
    const bounded = Math.max(0, Math.min(100, number(progress)));
    return `<article class="metric-card metric-${kind}"><div class="metric-icon">${dashboardIcon(kind)}</div><div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></div>${progress == null ? "" : `<div class="metric-mini" aria-hidden="true"><span style="width:${bounded}%"></span></div>`}</article>`;
  }
  function duration(value) {
    const milliseconds = number(value);
    if (!milliseconds) return "0s";
    if (milliseconds < 1000) return "<1s";
    const totalSeconds = Math.round(milliseconds / 1000);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60); const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
  }
  function refreshTimingLabels() {
    for (const element of root.querySelectorAll("[data-timing-base]:not([data-timing-segment])")) {
      const since = Date.parse(element.dataset.timingSince || "");
      const elapsed = Number.isFinite(since) ? Math.max(0, Date.now() - since) : 0;
      element.textContent = duration(number(element.dataset.timingBase) + elapsed);
    }
    for (const chart of root.querySelectorAll(".timing-bar")) {
      const segments = [...chart.querySelectorAll("[data-timing-segment]")];
      const values = segments.map((segment) => {
        const since = Date.parse(segment.dataset.timingSince || "");
        return number(segment.dataset.timingBase) + (Number.isFinite(since) ? Math.max(0, Date.now() - since) : 0);
      });
      const total = Math.max(1, values.reduce((sum, value) => sum + value, 0));
      segments.forEach((segment, index) => {
        const label = segment.dataset.timingLabel || "Activity"; const value = duration(values[index]);
        segment.style.width = `${values[index] / total * 100}%`;
        segment.dataset.tooltip = `${label} · ${value}`; segment.setAttribute("aria-label", `${label}: ${value}`);
      });
      const largestIndex = values.indexOf(Math.max(...values)); const caption = chart.parentElement?.querySelector("[data-timing-caption]");
      if (caption && largestIndex >= 0) caption.textContent = `${segments[largestIndex]?.dataset.timingLabel || "Activity"} is the largest activity`;
    }
  }
  function workflowMetrics(workspace) {
    const workflow = workspace.workflow || {};
    const tasks = (workspace.stages || []).flatMap((stage) => stage.tasks || []);
    const totalTasks = number(workflow.totals?.tasks?.total ?? workflow.totals?.tasks ?? workflow.aggregates?.taskTotal, tasks.length || workspace.tasks?.length);
    const completeTasks = number(workflow.totals?.tasks?.completed ?? workflow.aggregates?.tasksCompleted, tasks.filter(taskIsComplete).length);
    const gates = (workspace.stages || []).flatMap((stage) => [stage.integration, stage.verification, stage.review]);
    const completeGates = gates.filter((gate) => ["completed", "skipped"].includes(normalizedStatus(gate?.status))).length;
    const repairs = number(workflow.totals?.repairs ?? workflow.aggregates?.repairCount ?? workflow.metrics?.repairCount);
    const evidence = number(workflow.evidenceCount);
    return `<section class="metric-strip" aria-label="Workflow at a glance">${metricCard("tasks", "Tasks", `${completeTasks} / ${totalTasks}`, "delivered", totalTasks ? completeTasks / totalTasks * 100 : 0)}${metricCard("gates", "Quality gates", `${completeGates} / ${gates.length}`, "integration · verification · review", gates.length ? completeGates / gates.length * 100 : 0)}${metricCard("repairs", "Repairs", String(repairs), repairs ? "recovery passes" : "clean run")}${metricCard("evidence", "Evidence", String(evidence), "final E2E items")}</section>`;
  }
  function workflowTiming(workspace) {
    const timing = workspace.workflow?.metrics;
    if (!timing) return "";
    const categories = [["Implementation", "implementation"], ["Integration", "integration"], ["Verification", "verification"], ["Review", "review"], ["E2E", "e2e"]];
    const values = categories.map(([label, category]) => ({ label, category, milliseconds: timingMilliseconds(timing, category) }));
    const total = Math.max(1, values.reduce((sum, item) => sum + item.milliseconds, 0));
    const segments = values.filter((item) => item.milliseconds > 0 || timing.activeCategory === item.category).map((item) => { const active = timing.activeCategory === item.category && timing.activeSince; return `<span class="timing-segment timing-${item.category}" style="width:${item.milliseconds / total * 100}%" data-timing-segment data-timing-label="${escapeHtml(item.label)}" data-timing-base="${number(timing.categories?.[item.category])}"${active ? ` data-timing-since="${escapeHtml(timing.activeSince)}"` : ""} data-tooltip="${escapeHtml(`${item.label} · ${duration(item.milliseconds)}`)}" aria-label="${escapeHtml(`${item.label}: ${duration(item.milliseconds)}`)}"></span>`; }).join("");
    const largest = [...values].sort((left, right) => right.milliseconds - left.milliseconds)[0];
    return `<section class="workflow-timing" aria-labelledby="workflow-timing-title"><div class="timing-heading"><div class="timing-title"><span class="metric-icon">${dashboardIcon("clock")}</span><div><p>Workflow time</p><h2 id="workflow-timing-title">Activity mix</h2></div></div><strong>${timingValue(timing)}</strong></div><figure class="timing-chart"><div class="timing-bar" role="group" aria-label="Workflow time distributed across implementation, integration, verification, review, and E2E">${segments}</div><figcaption data-timing-caption>${largest?.milliseconds ? `${escapeHtml(largest.label)} is the largest activity` : "Timing begins when workflow execution starts"}</figcaption></figure><dl class="timing-legend">${values.map(({ label, category }) => `<div class="timing-${category}" tabindex="0" data-chart-category="${category}"><dt><span aria-hidden="true"></span>${label}</dt><dd>${timingValue(timing, category)}</dd></div>`).join("")}</dl>${timing.incompleteIntervals ? `<p>${number(timing.incompleteIntervals)} interrupted timing ${number(timing.incompleteIntervals) === 1 ? "interval was" : "intervals were"} excluded.</p>` : ""}</section>`;
  }
  function workflowHero(workspace) {
    const workflow = workspace.workflow || {};
    const total = (workspace.stages || []).reduce((sum, stage) => sum + number(stage.progress?.total, stage.tasks?.length || stage.taskIds?.length), 0);
    const completed = (workspace.stages || []).reduce((sum, stage) => sum + number(stage.progress?.completed, (stage.tasks || []).filter(taskIsComplete).length), 0);
    const percent = total ? Math.min(100, Math.round(completed / total * 100)) : 0;
    const current = workflow.currentStageId || workflow.currentPhase;
    return `<section class="workflow-hero" aria-labelledby="workflow-title"><p class="sr-only" role="status" aria-live="polite">Workflow ${escapeHtml(workflow.status || "unknown")}; ${completed} of ${total} tasks complete.</p><div class="hero-copy"><p class="eyebrow">Managed delivery</p><h2 id="workflow-title">Workflow</h2><p>${current ? `Now · ${escapeHtml(current)}` : "Implementation to final assurance"}</p><div class="hero-status">${badge(workflow.status || "unknown", "status hero-badge")}<span>Outcome ${escapeHtml(workflow.outcomeStatus || "pending")}</span></div></div><div class="hero-visual"><div class="progress-orbit${percent === 100 ? " is-complete" : ""}" style="--workflow-progress:${percent * 3.6}deg" role="progressbar" aria-label="Overall workflow progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><div><strong>${percent}%</strong><span>${completed} / ${total} tasks</span></div></div></div>${state.stale ? `<p class="stale-indicator" role="status"><span aria-hidden="true">↻</span> ${escapeHtml(state.stale)} <button type="button" class="link-button" data-action="retry-live">Retry live updates</button></p>` : ""}</section>`;
  }
  function endCap(workspace) {
    const workflow = workspace.workflow || {};
    const outcomeStatus = workflow.outcomeStatus || "pending";
    return `<section class="workflow-endcap" aria-labelledby="endcap-title"><div><p class="eyebrow">Completion path</p><h2 id="endcap-title">Final assurance</h2></div><ol>${gate("Whole-branch review", workspace.finalReview, "final-gate")}${gate("Final E2E", workspace.finalE2E, "final-gate")}${gate("Outcome", { status: outcomeStatus, ...(normalizedStatus(outcomeStatus) === "written" ? { documentId: "outcome" } : {}) }, "outcome-gate")}</ol></section>`;
  }
  function workflowView(workspace) {
    const attention = attentionEntries(workspace.workflow?.attention);
    const topAttention = workspace.workflow?.topAttention;
    return `<div class="workflow-view">${workflowHero(workspace)}${workflowMetrics(workspace)}${attention.length ? `<aside class="attention-rail" aria-label="Workflow attention"><strong>${attentionTotal(workspace.workflow?.attention)} need attention</strong><ul>${attention.map(([label, count]) => `<li><span>${escapeHtml(label)}</span><strong>${count}</strong></li>`).join("")}</ul>${topAttention ? `<p>${escapeHtml([topAttention.code, topAttention.summary].filter(Boolean).join(" · "))}</p>` : ""}</aside>` : ""}<section class="workflow-pipeline-section" aria-labelledby="pipeline-title"><div class="section-heading"><div><p class="eyebrow">Delivery path</p><h2 id="pipeline-title">Stages</h2></div><span>${number(workspace.stages?.length)} ordered stages</span></div><ol class="workflow-pipeline">${(workspace.stages || []).map((stage, index) => workflowStage(workspace, stage, index)).join("") || `<li class="boundary"><p>No delivery stages are available.</p></li>`}</ol></section>${endCap(workspace)}${workflowTiming(workspace)}</div>`;
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
    if (state.detailLoading && !state.detail) content = `<p role="status">Loading detail…</p>`;
    else if (state.detail?.error) content = errorRegion(state.detail.error, "retry-detail");
    else if (state.detail) { title = state.detail.title || state.detail.id; content = state.route.taskId ? taskDetail(state.detail) : state.route.documentId ? markdownSection("Document", state.detail.body) || "<p>Document content is missing.</p>" : reportDetail(state.detail); }
    return `<div class="detail-layer"><div class="scrim" data-action="close-detail" aria-hidden="true"></div><aside class="drawer detail-sheet" role="dialog" aria-modal="true" aria-labelledby="detail-title"><header><h2 id="detail-title">${escapeHtml(title)}</h2><button type="button" data-action="close-detail" aria-label="Close detail">×</button></header><div class="drawer-content">${content || ""}</div></aside></div>`;
  }
  function workspace() {
    if (state.loading) return `<section class="boundary" role="status"><span class="spinner" aria-hidden="true"></span> Loading story…</section>`;
    if (state.error) return errorRegion(state.error, "retry");
    const workspace = state.workspace;
    const body = state.route.view === "workflow" ? workflowView(workspace) : state.route.view === "documents" ? documents(workspace) : state.route.view === "reports" ? reports(workspace) : board(workspace);
    const modalOpen = Boolean(state.route.taskId || state.route.documentId || state.route.reportId);
    return `<div class="workspace-surface"${modalOpen ? " inert aria-hidden=\"true\"" : ""}>${header(workspace)}<div class="workspace-body">${workspace.story?.degraded ? `<div class="degraded-banner" role="status">Some story content is degraded.${diagnostics(workspace.diagnostics)}</div>` : ""}${body}</div></div>${drawer()}`;
  }
  function focusSelector(element) {
    if (!element || !root.contains(element)) return undefined;
    for (const attribute of ["data-task", "data-report", "data-related-report", "data-go-task", "data-document", "data-stage-disclosure", "data-chart-category", "data-action", "data-view", "href"]) {
      if (element.hasAttribute?.(attribute)) return `[${attribute}="${String(element.getAttribute(attribute)).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`;
    }
    return element.id ? `#${CSS.escape(element.id)}` : undefined;
  }
  function captureInteractionState() {
    return { focus: focusSelector(document.activeElement), drawerScrollTop: root.querySelector(".drawer-content")?.scrollTop };
  }
  function restoreInteractionState(interaction) {
    if (!interaction) return;
    if (Number.isFinite(interaction.drawerScrollTop)) { const drawer = root.querySelector(".drawer-content"); if (drawer) drawer.scrollTop = interaction.drawerScrollTop; }
    if (interaction.focus) (root.querySelector(interaction.focus) ?? root.querySelector('.drawer [data-action="close-detail"]') ?? root.querySelector(`[data-view="${state.route.view}"]`))?.focus({ preventScroll: true });
  }
  function render() {
    const willShowDrawer = Boolean(state.route.taskId || state.route.documentId || state.route.reportId);
    root.innerHTML = state.route.view === "catalog" ? catalog() : workspace();
    if (willShowDrawer) queueMicrotask(() => { const drawer = root.querySelector(".drawer"); if (drawer && !drawer.contains(document.activeElement)) drawer.querySelector('[data-action="close-detail"]')?.focus(); });
  }
  function closeDetail() {
    const route = { view: state.route.view, storyId: state.route.storyId };
    const focusTarget = returnFocus;
    returnFocus = undefined;
    detailGate.cancel(); setRoute(route);
    queueMicrotask(() => { const target = focusTarget ? root.querySelector(focusTarget) : undefined; (target ?? root.querySelector(`[data-view="${route.view}"]`))?.focus(); });
  }
  function toggleStage(target) {
    const stageId = target.dataset.stageDisclosure;
    const stage = (state.workspace?.stages || []).find((candidate) => candidate.id === stageId);
    const storyId = state.workspace?.story?.id || state.route.storyId;
    if (!stageId || !stage || !storyId) return;
    const expanded = !stageIsExpanded(storyId, stage, state.ui.stageDisclosureChoices);
    state.ui.stageDisclosureChoices[storyId] ??= {};
    state.ui.stageDisclosureChoices[storyId][stageId] = { lifecycle: stageDisclosureLifecycle(stage), expanded };
    const collapsed = !expanded;
    const total = number(stage.progress?.total, (stage.tasks || stage.taskIds || []).length);
    const completed = number(stage.progress?.completed, (stage.tasks || []).filter(taskIsComplete).length);
    const modeName = stage.mode === "concurrent" ? "Concurrent" : stage.mode === "sequential" ? "Sequential" : "Unknown";
    const label = stageDisclosureLabel({ expanded, title: stage.title || stageId, modeName, status: stage.status, completed, total, timing: stage.timing, exceptions: stageExceptionCount(stage) });
    const details = root.querySelector(`#stage-${stageId}-details`);
    const summary = target.querySelector(".stage-collapsed-summary");
    target.setAttribute("aria-expanded", String(expanded));
    target.setAttribute("aria-label", label);
    if (summary) summary.hidden = expanded;
    target.closest(".pipeline-stage")?.classList.toggle("is-expanded", expanded);
    target.closest(".pipeline-stage")?.classList.toggle("is-collapsed", collapsed);
    target.focus({ preventScroll: true });
    if (!details) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (reducedMotion || typeof details.animate !== "function") { details.hidden = collapsed; return; }
    if (expanded) details.hidden = false;
    details.style.overflow = "hidden";
    const height = details.scrollHeight;
    const animation = details.animate(collapsed ? [{ height: `${height}px`, opacity: 1 }, { height: "0px", opacity: 0 }] : [{ height: "0px", opacity: 0 }, { height: `${height}px`, opacity: 1 }], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
    void animation.finished.then(() => {
      if (stageIsExpanded(storyId, stage, state.ui.stageDisclosureChoices) === expanded) details.hidden = collapsed;
      details.style.overflow = "";
    }).catch(() => {});
  }
  root.addEventListener("click", (event) => {
    const target = event.target.closest("a,button,[data-action]"); if (!target) return;
    if (target.matches("[data-route]")) { event.preventDefault(); setRoute(parseRoute(new URL(target.href).pathname)); return; }
    if (target.dataset.stageDisclosure) toggleStage(target);
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
