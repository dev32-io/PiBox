const title = document.querySelector("#title");
const description = document.querySelector("#description");
const viewSelect = document.querySelector("#view");
const layoutSelect = document.querySelector("#layout");
const groupsToggle = document.querySelector("#groups");
const fitButton = document.querySelector("#fit");
const status = document.querySelector("#status");
const details = document.querySelector("#details");

let documentModel;
let cy;
let firstRender = true;

const nodeStyles = {
  note: { background: "#5a451f", border: "#dcae51", shape: "round-rectangle" },
  label: { background: "#192536", border: "#607690", shape: "round-rectangle" },
  actor: { background: "#173a51", border: "#65b8ff", shape: "round-rectangle" },
  decision: { background: "#45324f", border: "#bc87e8", shape: "diamond" },
  database: { background: "#23443e", border: "#71d1b4", shape: "barrel" },
};

function valueText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(valueText).filter(Boolean).join("\n");
  return JSON.stringify(value, null, 2);
}

function labelFor(item) {
  return item.label ?? item.title ?? item.name ?? item.text ?? item.id;
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

function graphElements(view) {
  const elements = [];
  const groupIds = new Set((view.groups ?? []).map((group) => group.id));
  if (groupsToggle.checked) {
    for (const group of view.groups ?? []) {
      elements.push({ data: { id: `group:${group.id}`, label: labelFor(group), kind: "group", raw: group } });
    }
  }
  for (const item of [...(view.nodes ?? []), ...(view.annotations ?? [])]) {
    const kind = item.kind ?? item.type ?? ((view.annotations ?? []).includes(item) ? "note" : "concept");
    const semantic = nodeStyles[kind] ?? {};
    const group = item.group ?? item.groupId ?? item.parent;
    elements.push({
      data: {
        id: item.id,
        label: labelFor(item),
        kind,
        raw: item,
        parent: groupsToggle.checked && groupIds.has(group) ? `group:${group}` : undefined,
        background: semantic.background ?? "#17304a",
        border: semantic.border ?? "#4b8fc2",
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

function renderDetails(raw, kind, isEdge = false) {
  details.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = labelFor(raw);
  const kindLine = document.createElement("div");
  kindLine.className = "kind";
  kindLine.textContent = kind || (isEdge ? "relationship" : "concept");
  details.append(heading, kindLine);

  const preferred = ["description", "summary", "details", "content"];
  for (const key of preferred) {
    if (raw[key] === undefined) continue;
    const section = document.createElement("h3");
    section.textContent = key;
    const body = document.createElement("p");
    body.textContent = valueText(raw[key]);
    details.append(section, body);
  }

  const omitted = new Set(["id", "label", "title", "name", "text", "kind", "type", "description", "summary", "details", "content", "source", "target", "from", "to"]);
  const rest = Object.fromEntries(Object.entries(raw).filter(([key]) => !omitted.has(key)));
  if (Object.keys(rest).length) {
    const section = document.createElement("h3");
    section.textContent = "Additional data";
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(rest, null, 2);
    details.append(section, pre);
  }
}

function renderGraph({ preserveViewport = false } = {}) {
  const view = selectedView();
  if (!view) return;
  const viewport = cy && preserveViewport ? { zoom: cy.zoom(), pan: cy.pan() } : undefined;
  cy?.destroy();
  cy = cytoscape({
    container: document.querySelector("#canvas"),
    elements: graphElements(view),
    wheelSensitivity: 0.2,
    minZoom: 0.12,
    maxZoom: 2.5,
    style: [
      { selector: "node", style: { "background-color": "data(background)", "border-color": "data(border)", "border-width": 1.5, shape: "data(shape)", label: "data(label)", color: "#e7edf6", "font-size": 12, "font-weight": 600, "text-wrap": "wrap", "text-max-width": 155, width: 175, height: 64, padding: 12, "text-valign": "center", "text-halign": "center" } },
      { selector: "node[kind = 'label']", style: { "background-opacity": 0.45, "border-style": "dashed", "font-weight": 400 } },
      { selector: "node[kind = 'note']", style: { "text-valign": "top", "text-margin-y": 11, "font-weight": 400, height: 78 } },
      { selector: ":parent", style: { "background-color": "#192334", "background-opacity": 0.55, "border-color": "#52657d", "border-style": "dashed", "border-width": 1.5, label: "data(label)", color: "#91a1b7", "font-size": 11, "text-valign": "top", "text-halign": "center", padding: 28 } },
      { selector: "edge", style: { width: 1.6, "line-color": "#6f829a", "target-arrow-color": "#6f829a", "target-arrow-shape": "triangle", "curve-style": "bezier", label: "data(label)", color: "#b9c6d6", "font-size": 10, "text-background-color": "#0b1018", "text-background-opacity": 0.86, "text-background-padding": 3, "text-rotation": "autorotate", "arrow-scale": 0.85 } },
      { selector: ":selected", style: { "border-color": "#ffffff", "border-width": 3, "line-color": "#65b8ff", "target-arrow-color": "#65b8ff" } },
    ],
    layout: layoutOptions(layoutSelect.value),
  });
  cy.on("tap", "node, edge", (event) => {
    const data = event.target.data();
    renderDetails(data.raw, data.kind, event.target.isEdge());
  });
  if (viewport) {
    cy.zoom(viewport.zoom);
    cy.pan(viewport.pan);
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
  const previousView = viewSelect.value;
  const response = await fetch("./api/document", { cache: "no-store" });
  const payload = await response.json();
  status.style.display = payload.errors?.length ? "block" : "none";
  status.textContent = payload.errors?.join("\n") ?? "";
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
fitButton.addEventListener("click", () => cy?.fit(undefined, 54));

const events = new EventSource("./events");
events.addEventListener("changed", loadDocument);
events.addEventListener("error", () => {
  status.style.display = "block";
  status.textContent = "Live update connection lost; retrying…";
});

loadDocument().catch((error) => {
  status.style.display = "block";
  status.textContent = error.message;
});
