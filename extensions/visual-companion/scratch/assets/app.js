import './webawesome.min.js';
import { renderMarkdown } from './markdown.js';

const $ = (selector) => document.querySelector(selector);
const group = $('#tabs'), tree = $('#file-tree'), scroll = $('#document-scroll');
const pinned = new Set(['plan.md', 'ledger.md']);
const open = new Map();
const directories = new Map();
const expanded = new Set();
const labels = { text: 'Plain text', image: 'Image', markdown: 'Markdown' };
const messages = {
  missing: ['File no longer available', 'This tab stays open until you close it or the file reappears.'],
  blocked: ['File blocked', 'Links and special files cannot be opened.'],
  binary: ['Binary file', 'No text preview is available.'],
  unsupported: ['Unsupported image', 'This format cannot be previewed safely.'],
  'too-large': ['File too large to preview', 'Preview size limit reached.'],
  unavailable: ['Scratch unavailable', 'No workspace is bound to this session. Visiting this view does not create one.'],
  loading: ['Checking workspace…', 'Revalidating current session before showing files.'],
  'too-large-root': ['Workspace too large to list', 'Directory listing limit reached.'],
  error: ['Unable to load file', 'Try Refresh when the workspace is available.'],
};
const icon = (name, extra = '') => { const node = document.createElement('span'); node.className = `ui-icon icon-${name} ${extra}`; node.setAttribute('aria-hidden', 'true'); return node; };
const nameOf = (path) => path.split('/').at(-1);
const glyph = (path, kind) => kind === 'directory' ? 'folder' : kind === 'blocked' ? 'file-warning' : /\.(png|jpe?g|gif|webp|avif)$/i.test(path) ? 'file-image' : path.endsWith('.md') ? 'file-text' : /\.(js|ts|sh|py|css)$/i.test(path) ? 'file-code' : path.endsWith('.json') ? 'file-json' : nameOf(path).startsWith('.') ? 'file-cog' : 'file';
const kindOf = (path, file) => file?.kind === 'text' ? path.endsWith('.md') ? 'markdown' : 'text' : file?.kind;
let active = 'plan.md', identity = null, rootKind = 'loading', epoch = 0, controller, source, watched = '', streamError = false, scrollOwner = null, viewToken = 0;
let enabled = true, pageActive = true, findOpen = false, collapsed = false, imageFit = true;
const usable = () => enabled && pageActive && !document.hidden;
const state = (path) => open.get(path);
function status(message, error = false) { $('#status').textContent = message; $('#status').setAttribute('role', error ? 'alert' : 'status'); }
function watchPaths() {
  const dirs = [...expanded].sort();
  const files = [...open.keys()].sort();
  const ancestors = new Set(['']);
  for (const path of [...dirs, ...files.map((p) => p.split('/').slice(0, -1).join('/'))]) {
    const parts = path ? path.split('/') : [];
    for (let i = 1; i <= parts.length; i++) ancestors.add(parts.slice(0, i).join('/'));
  }
  return { dirs, files, within: dirs.length <= 32 && files.length <= 64 && ancestors.size <= 128 };
}
function stopStream() { source?.close(); source = undefined; watched = ''; streamError = false; }
function connect() {
  if (!usable() || rootKind !== 'directory') { stopStream(); return false; }
  const paths = watchPaths();
  if (!paths.within) { stopStream(); status('Live watch limit reached. Collapse folders or close tabs.', true); return false; }
  const params = new URLSearchParams();
  paths.dirs.forEach((p) => params.append('dir', p));
  paths.files.forEach((p) => params.append('file', p));
  const fullKey = params.toString();
  const oversized = fullKey.length > 8000;
  // Root-only subscription still invalidates old session data; nested changes need manual Refresh.
  const key = oversized ? '' : fullKey;
  if (oversized) status('Live watch URL limit reached. Refresh for nested file changes.', true);
  if (source && watched === key) return !oversized;
  stopStream(); watched = key;
  source = new EventSource(`/v/scratch/events?${key}`);
  const current = source;
  current.addEventListener('ready', () => {
    if (source !== current) return;
    // First ready and native reconnect both close the snapshot/watch setup gap.
    streamError = false; scheduleRefresh(false);
  });
  current.addEventListener('changed', () => { if (source === current) scheduleRefresh(true); });
  current.addEventListener('unavailable', () => {
    if (source !== current) return;
    resetWorkspace(null);
    rootKind = 'unavailable'; renderTree(); render(); stopStream(); status('Scratch unavailable · read-only', true);
    scheduleRefresh(false);
  });
  current.addEventListener('error', () => {
    if (source !== current || streamError) return;
    streamError = true; status('Live updates disconnected. Reconnecting…', true); scheduleRefresh(false);
  });
  return !oversized;
}
let timer;
function scheduleRefresh(rebind) {
  clearTimeout(timer);
  timer = setTimeout(() => { if (!usable()) return; void refresh().then(() => { if (rebind && rootKind === 'directory') { stopStream(); connect(); } }); }, 120);
}
function resetWorkspace(next) {
  ++epoch; controller?.abort(); identity = next; rootKind = 'loading';
  $('.live-dot').classList.add('offline'); $('.status-indicator').classList.add('offline');
  directories.clear(); expanded.clear();
  for (const tab of open.values()) { tab.file = undefined; tab.version = undefined; tab.matches = []; }
  for (const path of [...open.keys()]) if (!pinned.has(path)) closeTab(path);
  active = 'plan.md'; stopStream(); renderTree(); show(active);
}
async function get(url, signal) {
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
async function list(path, signal, generation, first) {
  let cursor = 0, entries = [], expected;
  do {
    const params = new URLSearchParams({ path, cursor: String(cursor) });
    const result = first || await get(`/v/scratch/api/tree?${params}`, signal);
    first = undefined;
    if (generation !== epoch) return;
    if (expected !== undefined && result.identity !== expected) throw new Error('Workspace changed');
    expected = result.identity;
    if (path === '' && result.identity !== identity) { resetWorkspace(result.identity); scheduleRefresh(false); return; }
    if (result.identity !== identity) throw new Error('Workspace changed');
    if (result.kind !== 'directory') return { kind: result.kind, entries: [], identity: result.identity };
    entries.push(...result.entries);
    cursor = result.nextCursor;
  } while (cursor !== null);
  return { kind: 'directory', entries, identity: expected };
}
async function root(signal, generation) {
  const result = await get('/v/scratch/api/tree?path=&cursor=0', signal);
  if (generation !== epoch) return;
  if (result.identity !== identity) {
    if (rootKind === 'loading' && identity === null) identity = result.identity;
    else { resetWorkspace(result.identity); scheduleRefresh(false); return; }
  }
  if (result.kind !== 'directory' || result.nextCursor === null) return result;
  return list('', signal, generation, result);
}
async function refresh() {
  if (!usable()) return;
  controller?.abort(); const signal = (controller = new AbortController()).signal;
  const generation = ++epoch;
  try {
    const result = await root(signal, generation);
    if (generation !== epoch || !result) return;
    const wasLoading = rootKind === 'loading';
    rootKind = result.kind;
    $('.live-dot').classList.toggle('offline', rootKind !== 'directory');
    $('.status-indicator').classList.toggle('offline', rootKind !== 'directory');
    directories.set('', result);
    if (rootKind === 'directory') {
      for (const path of [...expanded].sort((a, b) => a.split('/').length - b.split('/').length)) {
        const listing = await list(path, signal, generation);
        if (generation !== epoch || !listing) return;
        directories.set(path, listing);
      }
    }
    renderTree();
    if (rootKind === 'directory') {
      for (const path of open.keys()) {
        let file;
        try { file = await get(`/v/scratch/api/file?${new URLSearchParams({ path })}`, signal); }
        catch (error) { if (signal.aborted) return; if (error.message === 'HTTP 409') throw error; file = { kind: 'error', identity }; }
        if (generation !== epoch) return;
        if (file.identity !== identity) { resetWorkspace(null); rootKind = 'loading'; scheduleRefresh(false); return; }
        const tab = state(path);
        if (!tab) continue;
        if (tab.file?.kind !== file.kind || tab.version !== file.version) {
          tab.file = file; tab.version = file.version;
          if (path === active) { const offset = scroll.scrollTop; render(); scroll.scrollTop = offset; }
        }
      }
      if (wasLoading) { render(); scroll.scrollTop = state(active).scroll; }
      if (connect()) status(streamError ? 'Live updates disconnected. Reconnecting…' : 'Workspace live · read-only', streamError);
    } else { render(); stopStream(); status('Scratch unavailable · read-only', true); retryUnavailable(); }
  } catch (error) {
    if (signal.aborted || generation !== epoch) return;
    if (error.message === 'Workspace changed') { scheduleRefresh(false); return; }
    if (error.message === 'HTTP 409') {
      resetWorkspace(null); scheduleRefresh(false); return;
    }
    status('Unable to refresh workspace. Retry with Refresh.', true);
    retryUnavailable();
  }
}
let retryTimer;
function retryUnavailable() { clearTimeout(retryTimer); if (usable()) retryTimer = setTimeout(() => { if (rootKind !== 'directory') void refresh(); }, 3000); }
function treeMessage(parent, text) {
  const node = document.createElement(parent.localName === 'wa-tree-item' ? 'wa-tree-item' : 'div');
  node.className = 'tree-message'; node.textContent = text;
  if (node.localName === 'wa-tree-item') node.disabled = true;
  parent.append(node);
}
function renderTree() {
  const focusPath = tree.contains(document.activeElement) ? document.activeElement.closest('wa-tree-item')?.dataset.path : null;
  const offset = $('.tree-scroll').scrollTop;
  tree.replaceChildren();
  const add = (path, parent) => {
    const listing = directories.get(path);
    if (!listing || listing.kind !== 'directory') { treeMessage(parent, listing?.kind === 'too-large' ? 'Folder too large to list.' : listing?.kind === 'blocked' ? 'Folder blocked.' : listing?.kind === 'missing' ? 'Folder no longer exists.' : 'Unable to list folder.'); return; }
    if (!listing.entries.length) treeMessage(parent, path ? 'Empty folder' : 'No files to explore yet.');
    for (const entry of listing.entries) {
      const key = path ? `${path}/${entry.name}` : entry.name;
      const node = document.createElement('wa-tree-item'); node.dataset.path = key;
      node.append(icon(glyph(key, entry.kind), 'file-icon'), document.createTextNode(entry.name));
      parent.append(node);
      if (entry.kind === 'directory') {
        node.classList.add('folder');
        // Attach before expanding: nested Web Awesome items clear `expanded`
        // in connectedCallback when their parent context is not ready yet.
        if (expanded.has(key)) { add(key, node); node.expanded = true; }
        else { const placeholder = document.createElement('wa-tree-item'); placeholder.textContent = 'Loading…'; placeholder.disabled = true; node.append(placeholder); }
      }
      if (key === active) node.selected = true;
    }
  };
  if (rootKind === 'directory') add('', tree);
  $('#tree-state').hidden = rootKind === 'directory';
  $('#tree-state').textContent = rootKind === 'directory' ? '' : rootKind === 'loading' ? 'Loading workspace…' : rootKind === 'too-large' ? 'Workspace directory too large to list.' : 'Workspace not available in this session.';
  $('.tree-scroll').scrollTop = offset;
  if (focusPath) [...tree.querySelectorAll('wa-tree-item')].find((n) => n.dataset.path === focusPath)?.focus();
}
tree.addEventListener('wa-expand', (event) => {
  const node = event.target, path = node.dataset.path;
  if (!path || !node.classList.contains('folder') || expanded.has(path)) return;
  expanded.add(path);
  if (!watchPaths().within) { expanded.delete(path); node.expanded = false; status('Folder watch limit reached (32 expanded, 128 ancestors).', true); return; }
  void refresh();
});
tree.addEventListener('wa-collapse', (event) => {
  const path = event.target.dataset.path;
  if (!expanded.delete(path)) return;
  for (const child of [...expanded]) if (child.startsWith(`${path}/`)) expanded.delete(child);
  renderTree(); connect();
});
tree.addEventListener('wa-selection-change', (event) => {
  const selected = event.detail.selection.at(-1);
  if (!selected || selected.classList.contains('folder') || !selected.dataset.path) return;
  show(selected.dataset.path);
  if (narrow.matches) setSidebar(true, { focus: true });
});
function createTab(path) {
  if (open.has(path)) return true;
  if (open.size >= 64) { status('Open file limit reached (64). Close a tab first.', true); return false; }
  const tab = document.createElement('wa-tab'); tab.panel = path; tab.setAttribute('aria-label', nameOf(path));
  const label = document.createElement('span'); label.className = 'tab-name'; label.textContent = nameOf(path);
  tab.append(icon(glyph(path), 'tab-glyph'), label);
  if (pinned.has(path)) { const pin = icon('pin', 'pin'); pin.title = 'Pinned'; tab.append(pin); }
  else {
    const close = document.createElement('button'); close.type = 'button'; close.className = 'tab-close'; close.append(icon('x')); close.title = `Close ${path}`; close.setAttribute('aria-label', `Close ${path}`);
    close.addEventListener('click', (event) => { event.stopPropagation(); closeTab(path); });
    close.addEventListener('keydown', (event) => event.stopPropagation());
    tab.append(close);
    tab.addEventListener('auxclick', (event) => { if (event.button === 1) { event.preventDefault(); closeTab(path); } });
  }
  const panel = document.createElement('wa-tab-panel'); panel.name = path;
  group.append(tab, panel);
  open.set(path, { tab, panel, scroll: 0, query: '', matchCase: false, match: 0 });
  return true;
}
function closeTab(path) {
  if (pinned.has(path) || !open.has(path)) return;
  const keys = [...open.keys()], next = keys[keys.indexOf(path) + 1] || keys[keys.indexOf(path) - 1];
  const wasActive = active === path;
  if (wasActive) show(next);
  const tab = state(path); tab.tab.remove(); tab.panel.remove(); open.delete(path);
  connect();
}
function restoreScroll(path) {
  const tab = state(path), token = viewToken;
  if (active !== path || !tab?.panel.active) return;
  // Web Awesome activates host before its slotted document has a layout box.
  void tab.panel.updateComplete.then(() => requestAnimationFrame(() => {
    if (token !== viewToken || active !== path || !tab.panel.active) return;
    scroll.scrollTop = tab.scroll;
    scrollOwner = path;
  }));
}
function saveScroll() {
  if (scrollOwner === active && state(active)?.panel.active) state(active).scroll = scroll.scrollTop;
}
scroll.addEventListener('scroll', saveScroll);
group.addEventListener('pointerdown', saveScroll, true);
group.addEventListener('keydown', saveScroll, true);
function show(path) {
  saveScroll();
  const fresh = !open.has(path);
  if (!createTab(path)) return;
  scrollOwner = null; ++viewToken;
  active = path; group.active = path;
  state(path).panel.append($('#document-view'));
  // Slot changes and reactive `active` updates complete asynchronously. No timer:
  // Web Awesome's activation event restores scroll only when panel has a box.
  void group.updateComplete.then(() => {
    if (active !== path || state(path)?.panel.active) return;
    group.syncTabsAndPanels(); group.updateActiveTab();
  });
  const parts = path.split('/'); let reveal = false;
  for (let i = 1; i < parts.length; i++) {
    const directory = parts.slice(0, i).join('/');
    if (!expanded.has(directory)) { expanded.add(directory); reveal = true; }
  }
  if (reveal && !watchPaths().within) {
    for (let i = 1; i < parts.length; i++) expanded.delete(parts.slice(0, i).join('/'));
    status('Folder watch limit reached. Collapse folders to reveal this file.', true);
  } else if (rootKind === 'directory' && (fresh || reveal)) { renderTree(); void refresh(); }
  for (const node of tree.querySelectorAll('wa-tree-item')) node.selected = node.dataset.path === path;
  const selected = [...tree.querySelectorAll('wa-tree-item')].find((node) => node.dataset.path === path);
  selected?.scrollIntoView({ block: 'nearest' });
  const crumb = $('#crumb'); crumb.replaceChildren();
  const segments = ['scratch', ...path.split('/')];
  segments.forEach((segment, i) => {
    const span = document.createElement('span'); span.textContent = segment; span.className = i === segments.length - 1 ? 'current-crumb' : ''; crumb.append(span);
    if (i < segments.length - 1) crumb.append(icon('chevron-right', 'crumb-separator'));
  });
  $('#find-input').value = state(path).query;
  $('#case').setAttribute('aria-pressed', String(state(path).matchCase));
  render(); restoreScroll(path);
}
group.addEventListener('wa-tab-show', (event) => {
  const path = event.detail.name;
  if (path !== group.active) return;
  if (path !== active && open.has(path)) show(path);
  else restoreScroll(path);
});
function empty(title, detail) {
  const box = document.createElement('div'); box.className = 'document-state';
  const symbol = document.createElement('div'); symbol.className = 'state-symbol'; symbol.append(icon('file-warning'));
  const heading = document.createElement('h2'); heading.textContent = title;
  const paragraph = document.createElement('p'); paragraph.textContent = detail;
  box.append(symbol, heading, paragraph); scroll.append(box);
}
function render() {
  const file = state(active)?.file;
  const kind = rootKind === 'directory' ? kindOf(active, file) : 'unavailable';
  scroll.replaceChildren(); scroll.className = `document-scroll ${kind || 'error'}-view`;
  const readable = rootKind === 'directory' && ['markdown', 'text'].includes(kind) && file.content.length > 0;
  $('#content-kind').textContent = labels[kind] || 'Unavailable'; $('#footer-type').textContent = labels[kind] || 'Preview unavailable';
  $('#find-toggle').disabled = !readable; $('#find-input').disabled = !readable;
  $('#image-tools').hidden = kind !== 'image';
  if (!readable && findOpen) toggleFind(false, false);
  if (kind === 'image') {
    const frame = document.createElement('div'); frame.className = `image-frame ${imageFit ? 'fit' : 'actual'}`;
    const image = document.createElement('img'); image.src = file.url; image.alt = nameOf(active);
    const filePath = active;
    image.onload = () => { if (active === filePath) $('#image-details').textContent = `${nameOf(active)} · ${image.naturalWidth} × ${image.naturalHeight}${Number.isFinite(file.size) ? ` · ${file.size.toLocaleString()} bytes` : ''}`; };
    image.onerror = () => { if (frame.isConnected) { frame.replaceChildren(); frame.textContent = 'Image could not be decoded or has changed. Refresh to retry.'; } };
    frame.append(image); scroll.append(frame); $('#image-details').textContent = nameOf(active);
  } else if (readable) {
    const doc = document.createElement(kind === 'markdown' ? 'article' : 'pre');
    doc.className = kind === 'markdown' ? 'markdown document' : 'raw-document';
    if (kind === 'markdown') doc.innerHTML = renderMarkdown(file.content);
    else doc.textContent = file.content;
    scroll.append(doc);
    if (findOpen && state(active).query) search();
  } else if (rootKind !== 'directory') empty(...(rootKind === 'too-large' ? messages['too-large-root'] : messages[rootKind] || messages.unavailable));
  else if (['markdown', 'text'].includes(kind) && file.content === '') empty('Empty file', 'No content yet.');
  else if (!file) empty('Loading file…', 'Waiting for workspace response.');
  else empty(...(messages[file.kind] || messages.error));
}
const MATCH_LIMIT = 500;
function matchLabel(current) {
  const count = current.matches.length;
  $('#match-count').textContent = count ? `${current.match + 1} of ${count}${current.limited ? '+' : ''}${current.limited ? ' (match limit)' : ''}` : current.query ? `No results${current.limited ? ' (match limit)' : ''}` : '0 of 0';
}
function markCurrent(marks, on) { for (const mark of marks) mark.classList.toggle('current-match', on); }
function search() {
  const current = state(active), query = $('#find-input').value;
  current.query = query; current.matchCase = $('#case').getAttribute('aria-pressed') === 'true';
  const offset = scroll.scrollTop;
  const doc = scroll.firstElementChild;
  if (!doc || !['markdown', 'raw-document'].some((c) => doc.classList.contains(c))) return;
  // Rebuild from sanitized source; indices below are UTF-16 offsets in original text.
  if (doc.classList.contains('markdown')) doc.innerHTML = renderMarkdown(current.file.content);
  else doc.textContent = current.file.content;
  const matches = [], nodes = [], breaks = [];
  current.limited = false;
  let content = '';
  if (query) {
    const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
    let block;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest('script,style,[hidden]')) { breaks.push(content.length); content += '\n'; block = undefined; continue; }
      const parentBlock = node.parentElement?.closest('p,div,li,blockquote,pre,h1,h2,h3,h4,h5,h6,td,th,tr');
      if (block && parentBlock !== block) { breaks.push(content.length); content += '\n'; }
      block = parentBlock;
      nodes.push({ node, start: content.length, end: content.length + node.textContent.length });
      content += node.textContent;
    }
    const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(literal, current.matchCase ? 'gu' : 'giu');
    const ranges = [];
    let boundary = 0, scanned = 0;
    for (const match of content.matchAll(pattern)) {
      if (++scanned > MATCH_LIMIT * 2 || ranges.length === MATCH_LIMIT) { current.limited = true; break; }
      while (breaks[boundary] < match.index) boundary++;
      if (breaks[boundary] < match.index + match[0].length) continue;
      ranges.push({ start: match.index, end: match.index + match[0].length });
      matches.push([]);
    }
    let i = 0, marked = 0;
    highlight: for (const { node, start, end } of nodes) {
      while (i < ranges.length && ranges[i].end <= start) i++;
      let pos = start, j = i;
      const fragment = document.createDocumentFragment();
      while (j < ranges.length && ranges[j].start < end) {
        const from = Math.max(pos, ranges[j].start), to = Math.min(end, ranges[j].end);
        if (from > pos) fragment.append(document.createTextNode(node.textContent.slice(pos - start, from - start)));
        if (to > from) {
          const mark = document.createElement('mark'); mark.textContent = node.textContent.slice(from - start, to - start);
          fragment.append(mark); matches[j].push(mark);
          if (++marked === MATCH_LIMIT) {
            fragment.append(document.createTextNode(node.textContent.slice(to - start)));
            node.replaceWith(fragment);
            matches.length = j + 1;
            current.limited = current.limited || ranges.length > j + 1 || ranges[j].end > end;
            break highlight;
          }
        }
        pos = to;
        if (ranges[j].end <= end) j++; else break;
      }
      if (pos > start) {
        fragment.append(document.createTextNode(node.textContent.slice(pos - start)));
        node.replaceWith(fragment);
      }
    }
  }
  current.matches = matches; current.match = matches.length ? Math.min(current.match, matches.length - 1) : 0;
  matchLabel(current);
  if (matches.length) { markCurrent(matches[current.match], true); matches[current.match][0].scrollIntoView({ block: 'nearest' }); }
  else scroll.scrollTop = offset;
}
function jump(direction) {
  const current = state(active), matches = current.matches || [];
  if (!matches.length) return;
  markCurrent(matches[current.match], false);
  current.match = (current.match + direction + matches.length) % matches.length;
  markCurrent(matches[current.match], true); matches[current.match][0].scrollIntoView({ block: 'center' });
  matchLabel(current);
}
function toggleFind(visible, rerender = true) {
  findOpen = visible; $('#findbar').hidden = !visible;
  if (visible) { $('#find-input').focus(); $('#find-input').select(); search(); }
  else {
    state(active).matches = [];
    if (rerender && ['markdown', 'text'].includes(kindOf(active, state(active).file))) {
      const offset = scroll.scrollTop; render(); scroll.scrollTop = offset;
    }
    $('#find-toggle').focus();
  }
}
$('#find-toggle').addEventListener('click', () => toggleFind(!findOpen));
$('#close-find').addEventListener('click', () => toggleFind(false));
$('#find-input').addEventListener('input', () => { state(active).match = 0; search(); });
$('#find-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); jump(event.shiftKey ? -1 : 1); } });
$('#case').addEventListener('click', () => { $('#case').setAttribute('aria-pressed', String($('#case').getAttribute('aria-pressed') !== 'true')); state(active).match = 0; search(); });
$('#next').addEventListener('click', () => jump(1)); $('#previous').addEventListener('click', () => jump(-1));
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); if (!$('#find-toggle').disabled) toggleFind(true); }
  if (event.key === 'Escape' && findOpen) toggleFind(false);
  else if (event.key === 'Escape' && narrow.matches && !collapsed) setSidebar(true, { focus: true });
});
function setFit(fit) {
  imageFit = fit; $('#fit').classList.toggle('selected', fit); $('#actual').classList.toggle('selected', !fit);
  $('#fit').setAttribute('aria-pressed', String(fit)); $('#actual').setAttribute('aria-pressed', String(!fit));
  if (kindOf(active, state(active).file) === 'image') render();
}
$('#fit').addEventListener('click', () => setFit(true)); $('#actual').addEventListener('click', () => setFit(false));
const split = $('#split'), narrow = matchMedia('(max-width:600px)');
let desiredWidth = 268, layoutReady = false, wasHidden = true;
function setSidebar(hidden, { focus = false } = {}) {
  if (hidden && !collapsed && !narrow.matches && split.positionInPixels >= 190 && split.positionInPixels <= 450) desiredWidth = split.positionInPixels;
  collapsed = hidden;
  split.classList.toggle('mobile-open', narrow.matches && !hidden);
  split.classList.toggle('collapsed', hidden || narrow.matches);
  split.disabled = hidden || narrow.matches;
  $('#files-toggle').setAttribute('aria-expanded', String(!hidden));
  split.positionInPixels = hidden || narrow.matches ? 0 : desiredWidth;
  const sidebar = $('.sidebar'); sidebar.inert = hidden; sidebar.setAttribute('aria-hidden', String(hidden));
  if (focus) (hidden ? $('#files-toggle') : tree.querySelector('wa-tree-item[selected]') || tree.querySelector('wa-tree-item:not([disabled])') || $('#refresh')).focus();
}
new ResizeObserver(([entry]) => {
  if (entry.contentRect.width < 200) { wasHidden = true; return; }
  if (!layoutReady || wasHidden) {
    const initial = !layoutReady; layoutReady = true; wasHidden = false;
    requestAnimationFrame(() => setSidebar(initial ? narrow.matches : collapsed));
  }
}).observe(split);
narrow.addEventListener('change', () => { if (layoutReady && split.getBoundingClientRect().width >= 200) setSidebar(narrow.matches); });
split.addEventListener('wa-reposition', () => {
  if (layoutReady && !collapsed && !narrow.matches && split.getBoundingClientRect().width >= 200 && split.positionInPixels >= 190 && split.positionInPixels <= 450) desiredWidth = split.positionInPixels;
});
$('#files-toggle').addEventListener('click', () => setSidebar(!collapsed, { focus: true }));
$('#refresh').addEventListener('click', () => void refresh());
function pause() {
  stopStream(); controller?.abort(); ++epoch; clearTimeout(timer); clearTimeout(retryTimer);
  if (rootKind === 'directory') {
    state(active).scroll = scroll.scrollTop;
    rootKind = 'loading'; renderTree(); render();
  }
}
function syncActivity() { if (!usable()) pause(); else void refresh(); }
addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== parent || event.data?.type !== 'visual-companion:activity') return;
  if (event.data.active !== true && event.data.active !== false) return;
  enabled = event.data.active; syncActivity();
});
document.addEventListener('visibilitychange', syncActivity);
addEventListener('pagehide', () => { pageActive = false; pause(); });
addEventListener('pageshow', () => { pageActive = true; syncActivity(); });
createTab('plan.md'); createTab('ledger.md'); show('plan.md'); renderTree(); syncActivity();
