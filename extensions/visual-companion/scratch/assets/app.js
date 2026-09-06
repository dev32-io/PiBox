import { renderMarkdown } from "./markdown.js";

const noteIds = ["plan", "ledger"];
const tabs = new Map(noteIds.map((id) => [id, document.querySelector(`#tab-${id}`)]));
const panels = new Map(noteIds.map((id) => [id, document.querySelector(`#panel-${id}`)]));
const status = document.querySelector("#status");
const refreshButton = document.querySelector("#refresh");
const ACTIVITY_MESSAGE = "visual-companion:activity";
let selectedNote = "plan";
let notes;
let requestGeneration = 0;
let requestController;

function showStatus(message, state = "status") {
  status.textContent = message;
  status.dataset.state = state;
  status.setAttribute("role", state === "error" ? "alert" : "status");
}

function activateNote(id, { focus = false } = {}) {
  if (!noteIds.includes(id)) return;
  selectedNote = id;
  for (const noteId of noteIds) {
    const selected = id === noteId;
    tabs.get(noteId).setAttribute("aria-selected", String(selected));
    tabs.get(noteId).tabIndex = selected ? 0 : -1;
    panels.get(noteId).hidden = !selected;
  }
  if (focus) tabs.get(id).focus();
}

function renderNote(id, note) {
  const panel = panels.get(id);
  const article = panel.querySelector(".markdown");
  const noteState = panel.querySelector(".note-state");
  const markdown = typeof note?.markdown === "string" && note.markdown.trim() ? note.markdown : "";
  article.innerHTML = markdown ? renderMarkdown(markdown) : "";
  article.hidden = !markdown;
  noteState.hidden = Boolean(markdown) && !note?.truncated;
  if (!markdown) {
    noteState.dataset.state = "empty";
    noteState.textContent = `No ${id} notes are available.`;
  } else if (note.truncated) {
    noteState.dataset.state = "truncated";
    noteState.textContent = `This ${id} note was truncated for display.`;
  }
}

function renderNotes(payload, scrollPositions) {
  notes = payload;
  for (const id of noteIds) renderNote(id, payload[id]);
  requestAnimationFrame(() => {
    for (const id of noteIds) panels.get(id).querySelector(".markdown").scrollTop = scrollPositions[id] ?? 0;
  });
}

function clearNotes(message) {
  notes = undefined;
  for (const id of noteIds) {
    const panel = panels.get(id);
    panel.querySelector(".markdown").replaceChildren();
    panel.querySelector(".markdown").hidden = true;
    const noteState = panel.querySelector(".note-state");
    noteState.hidden = false;
    noteState.dataset.state = "error";
    noteState.textContent = message;
  }
}

async function refreshNotes() {
  const scrollPositions = Object.fromEntries(noteIds.map((id) => [id, panels.get(id).querySelector(".markdown").scrollTop]));
  requestController?.abort();
  const generation = ++requestGeneration;
  requestController = new AbortController();
  refreshButton.disabled = true;
  showStatus("Refreshing scratch notes…");
  try {
    const response = await fetch("/v/scratch/api/notes", { cache: "no-store", signal: requestController.signal });
    if (generation !== requestGeneration) return;
    if (response.status === 404) {
      clearNotes("Scratch notes are no longer available for this session.");
      showStatus("Scratch notes are unavailable.", "error");
      return;
    }
    if (!response.ok) throw new Error("request failed");
    const payload = await response.json();
    if (generation !== requestGeneration) return;
    renderNotes(payload, scrollPositions);
    showStatus("Scratch notes refreshed.");
  } catch (error) {
    if (error.name === "AbortError" || generation !== requestGeneration) return;
    if (!notes) clearNotes("Scratch notes could not be loaded.");
    showStatus(notes ? "Unable to refresh scratch notes. Previously loaded notes remain visible." : "Unable to load scratch notes.", "error");
  } finally {
    if (generation === requestGeneration) {
      requestController = undefined;
      refreshButton.disabled = false;
    }
  }
}

for (const [id, tab] of tabs) {
  tab.addEventListener("click", () => activateNote(id));
  tab.addEventListener("keydown", (event) => {
    const index = noteIds.indexOf(id);
    let next;
    if (event.key === "ArrowRight") next = noteIds[(index + 1) % noteIds.length];
    if (event.key === "ArrowLeft") next = noteIds[(index - 1 + noteIds.length) % noteIds.length];
    if (event.key === "Home") next = noteIds[0];
    if (event.key === "End") next = noteIds.at(-1);
    if (!next) return;
    event.preventDefault();
    activateNote(next, { focus: true });
  });
}

refreshButton.addEventListener("click", () => { void refreshNotes(); });
addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== parent || event.data?.type !== ACTIVITY_MESSAGE) return;
  if (event.data.active === true) void refreshNotes();
  else if (event.data.active === false) requestController?.abort();
});
addEventListener("pagehide", () => {
  requestGeneration += 1;
  requestController?.abort();
});

activateNote(selectedNote);
void refreshNotes();
