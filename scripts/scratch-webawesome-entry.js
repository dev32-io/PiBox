import '@awesome.me/webawesome/dist/components/tree/tree.js';
import '@awesome.me/webawesome/dist/components/tree-item/tree-item.js';
import '@awesome.me/webawesome/dist/components/tab-group/tab-group.js';
import '@awesome.me/webawesome/dist/components/tab/tab.js';
import '@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js';
import '@awesome.me/webawesome/dist/components/split-panel/split-panel.js';
import { registerIconLibrary } from '@awesome.me/webawesome/dist/components/icon/library.js';

// Web Awesome fetches its default system glyphs from data: URLs. Strict connect-src
// rejects those. Serve selected same-origin Scratch icons instead.
const icons = new Set(['chevron-left', 'chevron-right', 'chevron-down', 'grip-vertical']);
registerIconLibrary('system', {
  resolver: name => icons.has(name) ? new URL(`./icons/${name}.svg`, import.meta.url).href : ''
});
