const frame = document.querySelector("#mockup");
const status = document.querySelector("#status");
let revision = 0;

function showError(message) {
  status.dataset.state = "error";
  status.setAttribute("role", "alert");
  status.textContent = message;
  status.hidden = false;
  frame.hidden = true;
}

function loadMockup() {
  revision += 1;
  status.dataset.state = "loading";
  status.setAttribute("role", "status");
  status.textContent = "Loading mockup…";
  status.hidden = false;
  frame.addEventListener("load", () => {
    frame.hidden = false;
    status.hidden = true;
  }, { once: true });
  frame.src = `./content/?revision=${revision}`;
}

try {
  const response = await fetch("./api/document", { cache: "no-store" });
  if (!response.ok) throw new Error(`Mockup document returned ${response.status}.`);
  const payload = await response.json();
  if (!payload.ok || !payload.document) throw new Error(payload.errors?.join("; ") || "Mockup is unavailable.");
  loadMockup();
  const events = new EventSource("./events");
  events.addEventListener("changed", (event) => {
    const update = JSON.parse(event.data);
    if (update.ok) loadMockup();
    else showError(update.errors?.join("; ") || "The mockup could not be refreshed.");
  });
  events.addEventListener("error", () => {
    if (!frame.hidden) return;
    showError("The live mockup connection was interrupted.");
  });
} catch (error) {
  showError(error instanceof Error ? error.message : String(error));
}
