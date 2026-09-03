const title = document.querySelector("#title");
const description = document.querySelector("#description");
const viewSelect = document.querySelector("#view");
const layoutSelect = document.querySelector("#layout");
const groupsToggle = document.querySelector("#groups");
const fitButton = document.querySelector("#fit");
const refreshButton = document.querySelector("#refresh");
const canvas = document.querySelector("#canvas");
const status = document.querySelector("#status");
const selectionStatus = document.querySelector("#selection-status");
const details = document.querySelector("#details");
const detailContent = document.querySelector("#detail-content");
const closeDetails = document.querySelector("#close-details");

let documentModel;
let cy;
let firstRender = true;
let loadGeneration = 0;
const forcedColorsQuery = matchMedia("(forced-colors: active)");

function cssToken(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function graphTheme() {
  if (forcedColorsQuery.matches) {
    const systemColor = (name) => {
      const probe = document.createElement("span");
      probe.style.color = name;
      probe.style.position = "fixed";
      probe.style.visibility = "hidden";
      document.body.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved || name;
    };
    const canvasColor = systemColor("Canvas");
    const textColor = systemColor("CanvasText");
    const highlightColor = systemColor("Highlight");
    return {
      canvas: canvasColor,
      surface: canvasColor,
      raised: canvasColor,
      strong: canvasColor,
      border: textColor,
      borderStrong: textColor,
      text: textColor,
      textSecondary: textColor,
      textMuted: textColor,
      accent: highlightColor,
      accentSoft: canvasColor,
      success: highlightColor,
      successSoft: canvasColor,
      warning: highlightColor,
      warningSoft: canvasColor,
      info: highlightColor,
      infoSoft: canvasColor,
    };
  }
  const token = (name, fallback) => cssToken(`--color-${name}`, fallback);
  return {
    canvas: token("canvas", "black"),
    surface: token("surface", "black"),
    raised: token("surface-raised", "black"),
    strong: token("surface-strong", "gray"),
    border: token("border", "gray"),
    borderStrong: token("border-strong", "gray"),
    text: token("text", "white"),
    textSecondary: token("text-secondary", "white"),
    textMuted: token("text-muted", "silver"),
    accent: token("accent", "blue"),
    accentSoft: token("accent-soft", "gray"),
    success: token("success", "green"),
    successSoft: token("success-soft", "gray"),
    warning: token("warning", "orange"),
    warningSoft: token("warning-soft", "gray"),
    info: token("info", "deepskyblue"),
    infoSoft: token("info-soft", "gray"),
  };
}

function nodeStyles(theme) {
  return {
    note: { background: theme.warningSoft, border: theme.warning, shape: "round-rectangle" },
    label: { background: theme.raised, border: theme.borderStrong, shape: "round-rectangle" },
    actor: { background: theme.infoSoft, border: theme.info, shape: "round-rectangle" },
    decision: { background: theme.accentSoft, border: theme.accent, shape: "diamond" },
    database: { background: theme.successSoft, border: theme.success, shape: "barrel" },
  };
}

function valueText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(valueText).filter(Boolean).join("\n");
  return JSON.stringify(value, null, 2);
}

function labelFor(item) {
  return item.label ?? item.title ?? item.name ?? item.text ?? item.id;
}

function announceSelection(element) {
  const data = element.data();
  const elements = cy.elements("node, edge").toArray();
  const index = elements.findIndex((candidate) => candidate.id() === element.id());
  const label = data.label || labelFor(data.raw ?? {}) || (element.isEdge() ? `${data.source} to ${data.target}` : data.id) || "Unnamed element";
  const kind = data.kind || (element.isEdge() ? "relationship" : "concept");
  const position = index >= 0 ? ` Item ${index + 1} of ${elements.length} in keyboard navigation order.` : "";
  selectionStatus.textContent = `Selected ${label}. ${kind}.${position}`;
}

function selectedView() {
  return documentModel?.views.find((view) => view.id === viewSelect.value) ?? documentModel?.views[0];
}

function layoutOptions(name) {
  const common = { animate: false, fit: true, padding: 54 };
  if (name === "breadthfirst") return { ...common, name, directed: true, circle: false, grid: true, spacingFactor: 1.25 };
  if (name === "concentric") return { ...common, name, minNodeSpacing: 70, levelWidth: () => 2 };
  if (name === "circle") return { ...common, name, spacingFactor: 1.2 };
  return { ...common, name: "grid", avoidOverlap: true, avoidOverlapPadding: 30, condense: false };
}

function graphElements(view, theme) {
  const elements = [];
  const semanticStyles = nodeStyles(theme);
  const groupIds = new Set((view.groups ?? []).map((group) => group.id));
  if (groupsToggle.checked) {
    for (const group of view.groups ?? []) {
      elements.push({ data: { id: `group:${group.id}`, label: labelFor(group), kind: "group", raw: group } });
    }
  }
  for (const item of [...(view.nodes ?? []), ...(view.annotations ?? [])]) {
    const kind = item.kind ?? item.type ?? ((view.annotations ?? []).includes(item) ? "note" : "concept");
    const semantic = semanticStyles[kind] ?? {};
    const group = item.group ?? item.groupId ?? item.parent;
    elements.push({
      data: {
        id: item.id,
        label: labelFor(item),
        kind,
        raw: item,
        parent: groupsToggle.checked && groupIds.has(group) ? `group:${group}` : undefined,
        background: semantic.background ?? theme.strong,
        border: semantic.border ?? theme.accent,
        shape: semantic.shape ?? "round-rectangle",
      },
    });
  }
  for (const [index, edge] of (view.edges ?? []).entries()) {
    const source = edge.source ?? edge.from;
    const target = edge.target ?? edge.to;
    elements.push({
      data: {
        id: `edge:${edge.id ?? `${index}:${source}:${target}`}`,
        source,
        target,
        label: edge.label ?? edge.title ?? edge.kind ?? "",
        kind: edge.kind ?? edge.type ?? "relationship",
        raw: edge,
      },
    });
  }
  return elements;
}

function renderDetails(raw, kind, isEdge = false, focus = true) {
  detailContent.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = labelFor(raw);
  const kindLine = document.createElement("div");
  kindLine.className = "kind";
  kindLine.textContent = kind || (isEdge ? "relationship" : "concept");
  detailContent.append(heading, kindLine);

  const preferred = ["description", "summary", "details", "content"];
  for (const key of preferred) {
    if (raw[key] === undefined) continue;
    const section = document.createElement("h3");
    section.textContent = key;
    const body = document.createElement("p");
    body.textContent = valueText(raw[key]);
    detailContent.append(section, body);
  }

  const omitted = new Set(["id", "label", "title", "name", "text", "kind", "type", "description", "summary", "details", "content", "source", "target", "from", "to"]);
  const rest = Object.fromEntries(Object.entries(raw).filter(([key]) => !omitted.has(key)));
  if (Object.keys(rest).length) {
    const section = document.createElement("h3");
    section.textContent = "Additional data";
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(rest, null, 2);
    detailContent.append(section, pre);
  }
  details.dataset.open = "true";
  if (focus && matchMedia("(max-width: 820px)").matches) details.focus();
}

function renderGraph({ preserveViewport = false } = {}) {
  const view = selectedView();
  if (!view) return;
  const viewport = cy && preserveViewport ? { zoom: cy.zoom(), pan: cy.pan() } : undefined;
  const selectedId = cy?.elements(":selected").first().id();
  const theme = graphTheme();
  cy?.destroy();
  cy = cytoscape({
    container: canvas,
    elements: graphElements(view, theme),
    wheelSensitivity: 0.2,
    minZoom: 0.12,
    maxZoom: 2.5,
    style: [
      { selector: "node", style: { "background-color": "data(background)", "border-color": "data(border)", "border-width": 1.5, shape: "data(shape)", label: "data(label)", color: theme.text, "font-size": 12, "font-weight": 600, "text-wrap": "wrap", "text-max-width": 155, width: 175, height: 64, padding: 12, "text-valign": "center", "text-halign": "center" } },
      { selector: "node[kind = 'label']", style: { "background-opacity": 0.45, "border-style": "dashed", "font-weight": 400 } },
      { selector: "node[kind = 'note']", style: { "text-valign": "top", "text-margin-y": 11, "font-weight": 400, height: 78 } },
      { selector: ":parent", style: { "background-color": theme.raised, "background-opacity": 0.55, "border-color": theme.borderStrong, "border-style": "dashed", "border-width": 1.5, label: "data(label)", color: theme.textMuted, "font-size": 11, "text-valign": "top", "text-halign": "center", padding: 28 } },
      { selector: "edge", style: { width: 1.6, "line-color": theme.textMuted, "target-arrow-color": theme.textMuted, "target-arrow-shape": "triangle", "curve-style": "bezier", label: "data(label)", color: theme.textSecondary, "font-size": 10, "text-background-color": theme.canvas, "text-background-opacity": 0.86, "text-background-padding": 3, "text-rotation": "autorotate", "arrow-scale": 0.85 } },
      { selector: ":selected", style: { "border-color": theme.text, "border-width": 3, "line-color": theme.accent, "target-arrow-color": theme.accent, "overlay-color": theme.accent, "overlay-opacity": 0.16 } },
    ],
    layout: layoutOptions(layoutSelect.value),
  });
  cy.on("select", "node, edge", (event) => announceSelection(event.target));
  cy.on("tap", "node, edge", (event) => {
    const data = event.target.data();
    renderDetails(data.raw, data.kind, event.target.isEdge());
  });
  if (viewport) {
    cy.zoom(viewport.zoom);
    cy.pan(viewport.pan);
  }
  const restored = selectedId && cy.getElementById(selectedId);
  if (restored?.length) {
    restored.select();
    const data = restored.data();
    renderDetails(data.raw, data.kind, restored.isEdge(), false);
  }
}

function populateViews(previous) {
  viewSelect.replaceChildren();
  for (const view of documentModel.views) {
    const option = document.createElement("option");
    option.value = view.id;
    option.textContent = view.title ?? view.label ?? view.id;
    viewSelect.append(option);
  }
  if (documentModel.views.some((view) => view.id === previous)) viewSelect.value = previous;
}

async function loadDocument() {
  const generation = ++loadGeneration;
  const previousView = viewSelect.value;
  const response = await fetch("./api/document", { cache: "no-store" });
  if (!response.ok) throw new Error(`Document request failed (${response.status}).`);
  const payload = await response.json();
  if (generation !== loadGeneration) return;
  status.style.display = payload.errors?.length ? "block" : "none";
  status.setAttribute("role", payload.errors?.length ? "alert" : "status");
  status.textContent = payload.errors?.length
    ? `${payload.document ? "Showing the last valid document. " : ""}${payload.errors.join("\n")}`
    : "";
  if (!payload.document) return;
  documentModel = payload.document;
  title.textContent = documentModel.title ?? "Architecture Visualizer";
  description.textContent = documentModel.description ?? "";
  populateViews(previousView);
  renderGraph({ preserveViewport: !firstRender });
  firstRender = false;
}

viewSelect.addEventListener("change", () => renderGraph());
layoutSelect.addEventListener("change", () => renderGraph());
groupsToggle.addEventListener("change", () => renderGraph({ preserveViewport: true }));
forcedColorsQuery.addEventListener("change", () => {
  if (cy && documentModel) renderGraph({ preserveViewport: true });
});
fitButton.addEventListener("click", () => cy?.fit(undefined, 54));
refreshButton.addEventListener("click", async () => {
  refreshButton.disabled = true;
  try { await loadDocument(); } catch (error) { showLoadError(error); }
  finally { refreshButton.disabled = false; }
});
function closeDetailSheet() {
  details.dataset.open = "false";
  cy?.elements(":selected").unselect();
  canvas.focus();
}
closeDetails.addEventListener("click", closeDetailSheet);
details.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { event.preventDefault(); closeDetailSheet(); return; }
  if (event.key !== "Tab" || !matchMedia("(max-width: 820px)").matches) return;
  const controls = [...details.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')];
  if (!controls.length) return;
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && (document.activeElement === first || document.activeElement === details)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || document.activeElement === details)) { event.preventDefault(); first.focus(); }
});
canvas.addEventListener("keydown", (event) => {
  if (!cy || !["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) return;
  const elements = cy.elements("node, edge").toArray();
  if (!elements.length) return;
  const selectedIndex = elements.findIndex((element) => element.selected());
  if (event.key === "Enter") {
    const selected = elements[selectedIndex];
    if (!selected) return;
    event.preventDefault();
    const data = selected.data();
    renderDetails(data.raw, data.kind, selected.isEdge());
    return;
  }
  event.preventDefault();
  let nextIndex = event.key === "Home" ? 0 : event.key === "End" ? elements.length - 1 : selectedIndex;
  if (event.key === "ArrowRight") nextIndex = (selectedIndex + 1) % elements.length;
  if (event.key === "ArrowLeft") nextIndex = (selectedIndex - 1 + elements.length) % elements.length;
  cy.elements(":selected").unselect();
  elements[nextIndex].select();
});

function showLoadError(error) {
  status.style.display = "block";
  status.setAttribute("role", "alert");
  status.textContent = `Unable to refresh the architecture document. ${error.message}`;
}

const events = new EventSource("./events");
events.addEventListener("changed", () => loadDocument().catch(showLoadError));
events.addEventListener("error", () => {
  status.style.display = "block";
  status.setAttribute("role", "alert");
  status.textContent = "Live update connection lost; retrying…";
});

loadDocument().catch(showLoadError);
