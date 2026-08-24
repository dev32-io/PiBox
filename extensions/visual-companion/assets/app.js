const picker = document.querySelector("#viewer");
const frame = document.querySelector("#content");
const empty = document.querySelector("#empty");

const response = await fetch("/api/viewers");
const { viewers, selected } = await response.json();
const requested = new URL(location.href).searchParams.get("viewer");
for (const id of viewers) picker.add(new Option(id, id));
const active = viewers.includes(requested) ? requested : viewers.includes(selected) ? selected : viewers[0];

function show(id) {
  if (!id) return;
  picker.value = id;
  frame.src = `/v/${encodeURIComponent(id)}/`;
  frame.hidden = false;
  empty.hidden = true;
  history.replaceState(null, "", `/?viewer=${encodeURIComponent(id)}`);
}
picker.addEventListener("change", () => show(picker.value));
show(active);
