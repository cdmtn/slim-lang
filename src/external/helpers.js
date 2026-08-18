import { parseHTML } from "linkedom";
import { CLIENT_RUNTIME } from "./client.js";

export function getFunctionBody(fn) {
    const str = fn.toString();
    return str.substring(str.indexOf('{') + 1, str.lastIndexOf('}')).trim();
}

export const idify = (text) => {
    if (!text) return '';

    return btoa(text + Math.random(100 * 9999) * 100)
        .toString()
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/[\s_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
};

// VDOM

const VOID_ELEMENTS = new Set([
	"area", "base", "br", "col", "embed", "hr", "img", "input",
	"link", "meta", "param", "source", "track", "wbr"
]);

const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"]);

// Component elements are built with the platform DOM when one already exists
// (a browser, or any environment that provides `document`/`HTMLElement`), and
// fall back to a single shared linkedom document in Node. Reusing one document
// is safe because the elements it creates are detached, standalone nodes.
const hasNativeDom =
	typeof globalThis.document !== "undefined" &&
	typeof globalThis.HTMLElement !== "undefined";

const { document: slimDocument, HTMLElement } = hasNativeDom
	? globalThis
	: parseHTML("<!doctype html><html><head></head><body></body></html>");

export { slimDocument, HTMLElement };

export class VNode {
	constructor(fields) {
		Object.assign(this, fields);
	}
	render() {
		return renderVNode(this);
	}
	toString() {
		return renderVNode(this);
	}
	toElement(doc = slimDocument) {
		return vnodeToElement(this, doc);
	}
}

function element(tag, attrs, children) {
	return new VNode({ type: "element", tag, attrs, children });
}
function textNode(value) {
	return new VNode({ type: "text", value });
}
function commentNode(value) {
	return new VNode({ type: "comment", value });
}
function fragmentNode(children) {
	return new VNode({ type: "fragment", children });
}

const isSpace = ch => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
const isNameStart = ch => (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
const isNameChar = ch => isNameStart(ch) || (ch >= "0" && ch <= "9") || ch === "-" || ch === "_" || ch === ":";

function parseAttributes(html, i) {
	const attrs = {};
	const len = html.length;
	let selfClosing = false;

	while (i < len) {
		while (i < len && isSpace(html[i])) i++;
		if (i >= len) break;

		if (html[i] === ">") { i++; break; }
		if (html[i] === "/" && html[i + 1] === ">") { selfClosing = true; i += 2; break; }

		const nameStart = i;
		while (i < len && !isSpace(html[i]) && html[i] !== "=" && html[i] !== ">" && html[i] !== "/") i++;
		const name = html.slice(nameStart, i);

		if (!name) { i++; continue; }

		while (i < len && isSpace(html[i])) i++;

		if (html[i] === "=") {
			i++;
			while (i < len && isSpace(html[i])) i++;

			const quote = html[i];
			let value;
			if (quote === '"' || quote === "'") {
				i++;
				const start = i;
				while (i < len && html[i] !== quote) i++;
				value = html.slice(start, i);
				if (i < len) i++;
			} else {
				const start = i;
				while (i < len && !isSpace(html[i]) && html[i] !== ">" && !(html[i] === "/" && html[i + 1] === ">")) i++;
				value = html.slice(start, i);
			}
			attrs[name] = value;
		} else {
			attrs[name] = true;
		}
	}

	return { attrs, selfClosing, end: i };
}

function findRawClose(html, lower, from, tag) {
	const needle = "</" + tag;
	let idx = from;

	while (true) {
		idx = lower.indexOf(needle, idx);
		if (idx === -1) return { contentEnd: html.length, next: html.length };

		let k = idx + needle.length;
		while (k < html.length && isSpace(html[k])) k++;
		if (html[k] === ">") return { contentEnd: idx, next: k + 1 };

		idx += needle.length;
	}
}

function parseNodes(html) {
	const lower = html.toLowerCase();
	const root = fragmentNode([]);
	const stack = [root];
	const top = () => stack[stack.length - 1];
	const len = html.length;
	let i = 0;

	while (i < len) {
		if (html[i] === "<") {
			// comment
			if (html.startsWith("<!--", i)) {
				const close = html.indexOf("-->", i + 4);
				const end = close === -1 ? len : close;
				top().children.push(commentNode(html.slice(i + 4, end)));
				i = close === -1 ? len : close + 3;
				continue;
			}
			// doctype / declaration
			if (html[i + 1] === "!" || html[i + 1] === "?") {
				const close = html.indexOf(">", i);
				i = close === -1 ? len : close + 1;
				continue;
			}
			// end tag
			if (html[i + 1] === "/") {
				const close = html.indexOf(">", i);
				const end = close === -1 ? len : close;
				const name = html.slice(i + 2, end).trim().toLowerCase();

				for (let s = stack.length - 1; s >= 1; s--) {
					if (stack[s].type === "element" && stack[s].tag === name) {
						stack.length = s;
						break;
					}
				}
				i = close === -1 ? len : close + 1;
				continue;
			}
			// start tag
			if (isNameStart(html[i + 1])) {
				let j = i + 1;
				while (j < len && isNameChar(html[j])) j++;
				const tag = html.slice(i + 1, j).toLowerCase();

				const { attrs, selfClosing, end } = parseAttributes(html, j);
				const el = element(tag, attrs, []);
				top().children.push(el);
				i = end;

				if (!selfClosing && !VOID_ELEMENTS.has(tag)) {
					if (RAW_TEXT_ELEMENTS.has(tag)) {
						const { contentEnd, next } = findRawClose(html, lower, i, tag);
						const raw = html.slice(i, contentEnd);
						if (raw) el.children.push(textNode(raw));
						i = next;
					} else {
						stack.push(el);
					}
				}
				continue;
			}

			top().children.push(textNode("<"));
			i++;
			continue;
		}

		const nextLt = html.indexOf("<", i);
		const end = nextLt === -1 ? len : nextLt;
		top().children.push(textNode(html.slice(i, end)));
		i = end;
	}

	return root.children;
}

function escapeAttribute(value) {
	return String(value).replace(/"/g, "&quot;");
}

function renderAttributes(attrs) {
	let out = "";
	for (const key in attrs) {
		const value = attrs[key];
		if (value === true) out += ` ${key}`;
		else if (value === false || value == null) continue;
		else out += ` ${key}="${escapeAttribute(value)}"`;
	}
	return out;
}

export function renderVNode(node) {
	if (node == null) return "";
	if (typeof node === "string") return node;
	if (Array.isArray(node)) return node.map(renderVNode).join("");

	switch (node.type) {
		case "text":
			return node.value ?? "";
		case "comment":
			return `<!--${node.value ?? ""}-->`;
		case "fragment":
			return (node.children || []).map(renderVNode).join("");
		case "element": {
			const open = `<${node.tag}${renderAttributes(node.attrs)}>`;
			if (VOID_ELEMENTS.has(node.tag)) return open;
			const inner = (node.children || []).map(renderVNode).join("");
			return `${open}${inner}</${node.tag}>`;
		}
		default:
			return "";
	}
}

export function vnodeToElement(node, doc = slimDocument) {
	if (node == null) return doc.createTextNode("");
	if (typeof node === "string") return doc.createTextNode(node);
	if (typeof node.nodeType === "number") return node;

	switch (node.type) {
		case "text":
			return doc.createTextNode(node.value ?? "");
		case "comment":
			return doc.createComment(node.value ?? "");
		case "fragment": {
			const frag = doc.createDocumentFragment();
			for (const child of node.children || []) frag.appendChild(vnodeToElement(child, doc));
			// A DocumentFragment stringifies to "<#document-fragment>…</…>" by
			// default; serialize its children directly so it embeds cleanly in a
			// template (`${fragment}`) and in the server response.
			frag.toString = fragmentToHtml;
			return frag;
		}
		case "element": {
			const el = doc.createElement(node.tag);
			const attrs = node.attrs || {};
			for (const key in attrs) {
				const value = attrs[key];
				if (value === true) el.setAttribute(key, "");
				else if (value === false || value == null) continue;
				else el.setAttribute(key, String(value));
			}
			for (const child of node.children || []) el.appendChild(vnodeToElement(child, doc));
			return el;
		}
		default:
			return doc.createTextNode("");
	}
}

function fragmentToHtml() {
	let out = "";
	for (const child of this.childNodes) out += child.toString();
	return out;
}

// Coerce a value interpolated into a component template into HTML. Arrays are
// flattened and joined with no separator (so `${[a, b]}` renders "ab", not
// "a,b"), null/false render as nothing, and everything else — elements,
// fragments, VNodes, primitives — stringifies to its HTML.
function stringifyChild(value) {
	if (value == null || value === false) return "";
	if (Array.isArray(value)) return value.map(stringifyChild).join("");
	return String(value);
}

// --- Client-side event handlers -------------------------------------------
//
// A handler written as `onClick=${fn}` in component markup is registered here
// during the server render, tagged onto its element with a `data-slim-on-*`
// attribute, and shipped to the browser as a single delegated dispatcher (one
// document-level listener per event type — the same technique React uses).
//
// Handlers run in the browser, so they receive the event and `this` (the
// element), and may use DOM/browser APIs (document, fetch, console, ...). They
// cannot close over server-side component scope, since only their source is
// shipped, not their closure.
//
// The registry is module-global and collected once per render. This is safe
// because a page render is synchronous (no await between registering handlers
// and flushing them), so concurrent requests never interleave.

let eventHandlers = [];

function registerEventHandler(event, fn) {
	const id = eventHandlers.length;
	eventHandlers.push({ event, source: fn.toString() });
	return id;
}

// Return the client script (handler table + delegated dispatcher) for the
// handlers registered during the current render, then clear the registry.
export function __flush_events__() {
	if (eventHandlers.length === 0) return "";

	const handlers = eventHandlers;
	eventHandlers = [];

	const table = handlers.map((h, i) => `${i}:${h.source}`).join(",");
	const events = [...new Set(handlers.map(h => h.event))];

	// Slim's browser runtime (log, type, ...) is emitted ahead of the handler
	// table so handlers can close over it — they run in the browser, where the
	// server's defaults.js globals do not exist.
	const runtime = CLIENT_RUNTIME.map(fn => fn.toString()).join("\n");

	const script =
		`(function(){` +
		`${runtime}\n` +
		`var H={${table}};` +
		`[${events.map(e => JSON.stringify(e)).join(",")}].forEach(function(evt){` +
		`document.addEventListener(evt,function(e){` +
		`var el=e.target.closest("[data-slim-on-"+evt+"]");` +
		`if(el){var id=el.getAttribute("data-slim-on-"+evt);` +
		`if(H[id])H[id].call(el,e);}` +
		`});` +
		`});` +
		`})();`;

	// Avoid prematurely closing the injected <script> tag.
	return script.replace(/<\/script/gi, "<\\/script");
}

// Tagged template used by compiled components in place of a raw template
// literal, so interpolated arrays and fragments render as clean HTML and
// `on<Event>=${fn}` bindings register a delegated event handler.
export function __html__(strings, ...values) {
	let out = strings[0];

	for (let i = 0; i < values.length; i++) {
		const value = values[i];
		const eventMatch = out.match(/\son([A-Z][A-Za-z]*)=\s*$/);

		if (eventMatch) {
			// `on<Event>=${…}` position: drop the raw attribute and bind a
			// delegated handler only when an actual function was passed, so a
			// forwarded-but-omitted handler leaves no stray attribute behind.
			out = out.slice(0, eventMatch.index);
			if (typeof value === "function") {
				const event = eventMatch[1].toLowerCase();
				const id = registerEventHandler(event, value);
				out += ` data-slim-on-${event}="${id}"`;
			}
		} else {
			out += stringifyChild(value);
		}

		out += strings[i + 1];
	}

	return out;
}

export function htmlToElement(input, doc = slimDocument) {
	return vnodeToElement(htmlToVdom(input), doc);
}

export function htmlToVdom(input) {
	if (input instanceof VNode) return input;

	const html = input == null ? "" : String(input);
	const nodes = parseNodes(html);

	const meaningful = nodes.filter(n => !(n.type === "text" && n.value.trim() === ""));

	if (meaningful.length === 1) return meaningful[0];
	if (meaningful.length === 0) return fragmentNode([]);
	return fragmentNode(meaningful);
}