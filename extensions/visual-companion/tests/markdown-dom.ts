import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import * as marked from "marked";
const window = new JSDOM("").window;
Object.assign(globalThis, { marked, DOMPurify: createDOMPurify(window as never) });
export function renderedDOM(html: string) { return JSDOM.fragment(html); }
