function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function safeLink(href) {
  const value = href.trim();
  return /^(?:https?:\/\/|mailto:)/i.test(value) ? value : "";
}

function inlineMarkdown(source) {
  const text = String(source);
  let output = "";
  let offset = 0;
  const token = /`([^`]+)`|!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_/g;
  for (let match; (match = token.exec(text));) {
    output += escapeHtml(text.slice(offset, match.index));
    if (match[1] !== undefined) output += `<code>${escapeHtml(match[1])}</code>`;
    else if (match[2] !== undefined) output += `<span class="inert-image" aria-label="Image: ${escapeHtml(match[2] || "unlabelled")}">Image: ${escapeHtml(match[2] || "unlabelled")}</span>`;
    else if (match[4] !== undefined) {
      const href = safeLink(match[5]);
      output += href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(match[4])}</a>`
        : escapeHtml(match[4]);
    } else if (match[6] !== undefined || match[7] !== undefined) output += `<strong>${escapeHtml(match[6] ?? match[7])}</strong>`;
    else output += `<em>${escapeHtml(match[8] ?? match[9])}</em>`;
    offset = token.lastIndex;
  }
  return output + escapeHtml(text.slice(offset));
}

export function renderMarkdown(markdown = "") {
  const lines = String(markdown).replace(/\r/g, "").split("\n");
  const output = [];
  let listType = "";
  let paragraph = [];
  let fence = null;

  const closeList = () => {
    if (listType) output.push(`</${listType}>`);
    listType = "";
  };
  const closeParagraph = () => {
    if (paragraph.length) output.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`);
    paragraph = [];
  };
  const closeBlocks = () => { closeParagraph(); closeList(); };

  for (const line of lines) {
    if (fence) {
      if (/^\s*```/.test(line)) {
        output.push(`<pre><code>${escapeHtml(fence.join("\n"))}</code></pre>`);
        fence = null;
      } else fence.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) {
      closeBlocks();
      fence = [];
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeBlocks();
      output.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    const checklist = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/);
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const item = checklist?.[2] ?? unordered?.[1] ?? ordered?.[1];
    if (item !== undefined) {
      closeParagraph();
      const nextType = ordered ? "ol" : "ul";
      if (listType !== nextType) { closeList(); output.push(`<${nextType}>`); listType = nextType; }
      const checkbox = checklist ? `<input type="checkbox" disabled${checklist[1].toLowerCase() === "x" ? " checked" : ""} aria-label="${checklist[1].toLowerCase() === "x" ? "Completed" : "Not completed"}"> ` : "";
      output.push(`<li>${checkbox}${inlineMarkdown(item)}</li>`);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      closeBlocks();
      output.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }
    if (!line.trim()) closeBlocks();
    else { closeList(); paragraph.push(line); }
  }
  if (fence) output.push(`<pre><code>${escapeHtml(fence.join("\n"))}</code></pre>`);
  closeBlocks();
  return output.join("\n");
}
