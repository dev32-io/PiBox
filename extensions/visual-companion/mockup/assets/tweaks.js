const CHANNEL = "visual-companion:tweaks";
const MAX_CONTROLS = 32;
const MAX_TEXT = 100;

function plainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT) throw new Error(`${name} must be 1-${MAX_TEXT} characters.`);
  return value;
}

function validateControl(control, keys) {
  if (!plainRecord(control)) throw new Error("Each control must be an object.");
  const key = text(control.key, "Control key");
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) throw new Error(`Control key "${key}" is invalid.`);
  if (keys.has(key)) throw new Error(`Control key "${key}" is duplicated.`);
  keys.add(key);
  const label = text(control.label, `Label for "${key}"`);

  if (control.type === "toggle") {
    if (typeof control.default !== "boolean") throw new Error(`Toggle "${key}" needs a boolean default.`);
    return { key, label, type: "toggle", default: control.default };
  }
  if (control.type === "choice") {
    if (!Array.isArray(control.options) || !control.options.length || control.options.length > 50) throw new Error(`Choice "${key}" needs 1-50 options.`);
    const values = new Set();
    const options = control.options.map((option) => {
      if (!plainRecord(option)) throw new Error(`Options for "${key}" must be objects.`);
      const value = text(option.value, `Option value for "${key}"`);
      if (values.has(value)) throw new Error(`Choice "${key}" has duplicate value "${value}".`);
      values.add(value);
      return { value, label: text(option.label, `Option label for "${key}"`) };
    });
    if (!values.has(control.default)) throw new Error(`Choice "${key}" default must match an option.`);
    return { key, label, type: "choice", options, default: control.default };
  }
  if (control.type === "range") {
    const { min, max, step = 1 } = control;
    if (![min, max, step, control.default].every(Number.isFinite) || min >= max || step <= 0 || control.default < min || control.default > max) {
      throw new Error(`Range "${key}" needs finite min < max, positive step, and an in-range default.`);
    }
    return { key, label, type: "range", min, max, step, default: control.default };
  }
  throw new Error(`Control "${key}" has unsupported type.`);
}

export function validateTweaksDefinition(value) {
  if (!plainRecord(value) || !Array.isArray(value.controls)) throw new Error("Tweaks definition must contain a controls array.");
  if (!value.controls.length || value.controls.length > MAX_CONTROLS) throw new Error(`Tweaks definition needs 1-${MAX_CONTROLS} controls.`);
  const keys = new Set();
  return { controls: value.controls.map((control) => validateControl(control, keys)) };
}

export function valuesFor(definition, previous = {}) {
  return Object.fromEntries(definition.controls.map((control) => {
    const value = previous[control.key];
    const valid = control.type === "toggle" ? typeof value === "boolean"
      : control.type === "choice" ? control.options.some((option) => option.value === value)
      : typeof value === "number" && Number.isFinite(value) && value >= control.min && value <= control.max;
    return [control.key, valid ? value : control.default];
  }));
}

function token() {
  return new URLSearchParams(location.hash.slice(1)).get("tweaks");
}

export function connectTweaks(onChange) {
  if (typeof onChange !== "function") throw new TypeError("connectTweaks needs an onChange function.");
  const session = token();
  if (!session) return () => {};
  const receive = (event) => {
    const message = event.data;
    if (event.source !== parent || !plainRecord(message) || message.channel !== CHANNEL || message.token !== session || message.type !== "state" || !plainRecord(message.values)) return;
    const values = {};
    for (const [key, value] of Object.entries(message.values)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) || !["string", "number", "boolean"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value))) return;
      values[key] = value;
    }
    onChange(Object.freeze(values));
  };
  addEventListener("message", receive);
  parent.postMessage({ channel: CHANNEL, token: session, type: "ready" }, "*");
  return () => removeEventListener("message", receive);
}

export function requestTweaksReload() {
  const session = token();
  if (session) parent.postMessage({ channel: CHANNEL, token: session, type: "reload" }, "*");
}
