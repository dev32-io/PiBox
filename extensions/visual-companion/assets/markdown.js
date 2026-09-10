/** Dependencies are local, bounded browser assets. Injection keeps DOM tests real. */
export function renderMarkdown(markdown = "", { story = false, marked = globalThis.marked, purifier = globalThis.DOMPurify } = {}) {
  if (!marked?.Marked || !purifier?.isSupported || !purifier?.sanitize) throw new Error("Markdown sanitizer is unavailable");
  const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const external = (url) => /^(?:https?:\/\/|mailto:)/i.test(url) && !/[\u0000-\u0020\\]/.test(url);
  const evidence = (url) => {
    if (!story || !url.startsWith("/v/story-board/api/evidence?")) return false;
    const parsed = new URL(url, "http://companion.invalid");
    const params = parsed.searchParams;
    return !parsed.hash && [...params.keys()].sort().join() === "evaluation,path,story" &&
      [params.get("story"), params.get("evaluation")].every((id) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id || "")) &&
      Boolean(params.get("path")) && !params.get("path").includes("\\") &&
      params.get("path").split("/").every((part) => part && part !== "." && part !== "..");
  };
  const parser = new marked.Marked({ gfm: true, breaks: false, renderer: {
    html({ text }) { return escape(text); },
    image({ href, text }) {
      if (evidence(href)) return `<img src="${escape(href)}" alt="${escape(text)}" loading="lazy">`;
      return story && external(href) ? `<a href="${escape(href)}">${escape(text || "External image")}</a>` : `<span>Image: ${escape(text || "unlabelled")}</span>`;
    },
  } });
  // No resource-bearing markup reaches a live DOM before URL policy runs.
  const fragment = purifier.sanitize(parser.parse(String(markdown)), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ["p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "del", "a", "img", "span", "ul", "ol", "li", "input", "pre", "code", "blockquote", "hr", "table", "thead", "tbody", "tr", "th", "td"],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "align", "start", "type", "checked", "disabled", "loading"],
  });
  for (const link of fragment.querySelectorAll("a")) {
    const href = link.getAttribute("href") || "";
    if (!external(href) && !evidence(href)) link.removeAttribute("href");
    else { link.setAttribute("target", "_blank"); link.setAttribute("rel", "noopener noreferrer"); }
  }
  for (const image of fragment.querySelectorAll("img")) {
    if (!evidence(image.getAttribute("src") || "")) image.replaceWith(image.ownerDocument.createTextNode(image.getAttribute("alt") || "Image unavailable"));
  }
  for (const input of fragment.querySelectorAll("input")) { input.setAttribute("type", "checkbox"); input.setAttribute("disabled", ""); }
  for (const cell of fragment.querySelectorAll("[align]")) {
    const align = cell.getAttribute("align");
    cell.removeAttribute("align");
    if (["left", "center", "right"].includes(align)) cell.classList.add(`align-${align}`);
  }
  for (const table of fragment.querySelectorAll("table")) {
    const wrapper = table.ownerDocument.createElement("div");
    wrapper.className = "markdown-table"; wrapper.tabIndex = 0; wrapper.setAttribute("role", "region"); wrapper.setAttribute("aria-label", "Table");
    table.replaceWith(wrapper); wrapper.append(table);
  }
  const container = fragment.ownerDocument.createElement("div");
  container.append(fragment);
  return container.innerHTML;
}
