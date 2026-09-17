import { validateTweaksDefinition, valuesFor } from "./tweaks.js";

const CHANNEL = "visual-companion:tweaks";
const frame = document.querySelector("#mockup");
const status = document.querySelector("#status");
const panel = document.querySelector("#tweaks");
const controls = document.querySelector("#tweak-controls");
const tweakError = document.querySelector("#tweak-error");
const reset = document.querySelector("#tweak-reset");
const copy = document.querySelector("#tweak-copy");
const copyStatus = document.querySelector("#tweak-copy-status");
let revision = 0;
let artifact;
let definition;
let values = {};
let token;
let reloadedState;
let documentGeneration = 0;
let renderGeneration = 0;
let reloadPending = false;

function showError(message) {
  status.dataset.state = "error";
  status.setAttribute("role", "alert");
  status.textContent = message;
  status.hidden = false;
  frame.hidden = true;
}

function sendState() {
  if (token && frame.contentWindow) frame.contentWindow.postMessage({ channel: CHANNEL, token, type: "state", values }, "*");
}

function renderControls() {
  controls.replaceChildren();
  for (const control of definition.controls) {
    const label = document.createElement("label");
    label.className = "tweak-control";
    const caption = document.createElement("span");
    caption.textContent = control.label;
    let input;
    if (control.type === "choice") {
      input = document.createElement("select");
      for (const option of control.options) input.add(new Option(option.label, option.value));
    } else {
      input = document.createElement("input");
      input.type = control.type === "toggle" ? "checkbox" : "range";
      if (control.type === "range") {
        input.min = String(control.min); input.max = String(control.max); input.step = String(control.step);
      }
    }
    input.dataset.key = control.key;
    if (control.type === "toggle") input.checked = values[control.key];
    else input.value = String(values[control.key]);
    label.append(caption, input);
    controls.append(label);
  }
}

function clearReloadIfChanged() {
  if (reloadedState !== undefined && JSON.stringify(values) !== reloadedState) reloadedState = undefined;
}

async function loadDefinition(preserve, generation, nextRevision) {
  try {
    const response = await fetch(`./content/tweaks.json?revision=${nextRevision}`, { cache: "no-store" });
    if (generation !== renderGeneration) return false;
    tweakError.hidden = true;
    copyStatus.textContent = "";
    if (response.status === 404) {
      definition = undefined; values = {}; reloadedState = undefined; controls.replaceChildren(); panel.hidden = true;
      return true;
    }
    if (!response.ok) throw new Error(`tweaks.json returned ${response.status}.`);
    const nextDefinition = validateTweaksDefinition(await response.json());
    if (generation !== renderGeneration) return false;
    definition = nextDefinition;
    values = valuesFor(definition, preserve ? values : {});
    clearReloadIfChanged();
    renderControls();
    panel.hidden = false;
  } catch (error) {
    if (generation !== renderGeneration) return false;
    definition = undefined; controls.replaceChildren(); panel.hidden = false;
    tweakError.textContent = error instanceof Error ? error.message : String(error);
    tweakError.hidden = false;
  }
  return true;
}

async function loadMockup(preserve = true) {
  const generation = ++renderGeneration;
  token = undefined;
  const nextRevision = ++revision;
  if (!await loadDefinition(preserve, generation, nextRevision) || generation !== renderGeneration) return;
  token = crypto.randomUUID();
  status.dataset.state = "loading";
  status.setAttribute("role", "status");
  status.textContent = "Loading mockup…";
  status.hidden = false;
  frame.addEventListener("load", () => {
    if (generation !== renderGeneration) return;
    frame.hidden = false;
    status.hidden = true;
  }, { once: true });
  frame.src = `./content/?revision=${nextRevision}#tweaks=${encodeURIComponent(token)}`;
}

async function currentDocument(reload = false) {
  if (reload) reloadPending = true;
  const generation = ++documentGeneration;
  try {
    const response = await fetch("./api/document", { cache: "no-store" });
    if (generation !== documentGeneration) return;
    if (!response.ok) throw new Error(`Mockup document returned ${response.status}.`);
    const payload = await response.json();
    if (generation !== documentGeneration) return;
    if (!payload.ok || !payload.document) throw new Error(payload.errors?.join("; ") || "Mockup is unavailable.");
    const nextArtifact = payload.document.entry;
    const switched = artifact !== undefined && artifact !== nextArtifact;
    if (switched) { values = {}; reloadedState = undefined; }
    if (reloadPending || artifact !== nextArtifact) {
      reloadPending = false;
      artifact = nextArtifact;
      await loadMockup(!switched);
    }
  } catch (error) {
    if (generation === documentGeneration) throw error;
  }
}

controls.addEventListener("input", (event) => {
  const input = event.target;
  const control = definition?.controls.find((item) => item.key === input.dataset.key);
  if (!control) return;
  values = { ...values, [control.key]: control.type === "toggle" ? input.checked : control.type === "range" ? Number(input.value) : input.value };
  clearReloadIfChanged();
  copyStatus.textContent = "";
  sendState();
});

reset.addEventListener("click", () => {
  if (!definition) return;
  values = valuesFor(definition);
  clearReloadIfChanged();
  renderControls();
  copyStatus.textContent = "Reset.";
  sendState();
});

copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(values, null, 2));
    copyStatus.textContent = "Copied.";
  } catch { copyStatus.textContent = "Copy failed."; }
});

addEventListener("message", (event) => {
  const message = event.data;
  if (event.source !== frame.contentWindow || event.origin !== "null" || !message || typeof message !== "object" || message.channel !== CHANNEL || message.token !== token) return;
  if (message.type === "ready") sendState();
  if (message.type === "reload") {
    const signature = JSON.stringify(values);
    if (signature === reloadedState) return;
    reloadedState = signature;
    void loadMockup(true);
  }
});

try {
  await currentDocument(true);
  const events = new EventSource("./events");
  events.addEventListener("ready", () => { void currentDocument(false).catch((error) => showError(error instanceof Error ? error.message : String(error))); });
  events.addEventListener("changed", (event) => {
    const update = JSON.parse(event.data);
    if (update.ok) void currentDocument(true).catch((error) => showError(error instanceof Error ? error.message : String(error)));
    else showError(update.errors?.join("; ") || "The mockup could not be refreshed.");
  });
  events.addEventListener("error", () => {
    if (!frame.hidden) return;
    showError("The live mockup connection was interrupted.");
  });
} catch (error) {
  showError(error instanceof Error ? error.message : String(error));
}
