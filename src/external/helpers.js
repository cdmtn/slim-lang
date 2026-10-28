import { CLIENT_RUNTIME } from "./client.js";
import { Signal } from "./reactive.js";

const VOID_ELEMENTS = new Set([
	"area", "base", "br", "col", "embed", "hr", "img", "input",
	"link", "meta", "param", "source", "track", "wbr"
]);

const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"]);
const UNESCAPED_TEXT_ELEMENTS = new Set(["script", "style"]);

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

export function escapeHtml(value) {
	return String(value).replace(/[&<>"']/g, ch => ESCAPES[ch]);
}

export function decodeEntities(text) {
	if (!text.includes("&")) return text;
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
		if (entity[0] !== "#") return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
		const code = entity[1] === "x" || entity[1] === "X"
			? parseInt(entity.slice(2), 16)
			: parseInt(entity.slice(1), 10);
		return code <= 0x10ffff ? String.fromCodePoint(code) : match;
	});
}

export class SafeHtml {
	constructor(value) {
		this.value = value;
	}
	toString() {
		return this.value;
	}
}

export function raw(html) {
	return html instanceof SafeHtml ? html : new SafeHtml(html == null ? "" : String(html));
}

const hasNativeDom =
	typeof globalThis.document !== "undefined" &&
	typeof globalThis.HTMLElement !== "undefined";

const { document: slimDocument, HTMLElement } = hasNativeDom
	? globalThis
	: (await import("linkedom")).parseHTML("<!doctype html><html><head></head><body></body></html>");

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
			attrs[name] = decodeEntities(value);
		} else {
			attrs[name] = true;
		}
	}

	return { attrs, selfClosing, end: i };
}

export function parseAttributeList(text) {
	return parseAttributes(text + ">", 0).attrs;
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
			if (html.startsWith("<!--", i)) {
				const close = html.indexOf("-->", i + 4);
				const end = close === -1 ? len : close;
				top().children.push(commentNode(html.slice(i + 4, end)));
				i = close === -1 ? len : close + 3;
				continue;
			}
			if (html[i + 1] === "!" || html[i + 1] === "?") {
				const close = html.indexOf(">", i);
				i = close === -1 ? len : close + 1;
				continue;
			}
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
						const content = html.slice(i, contentEnd);
						if (content) el.children.push(textNode(UNESCAPED_TEXT_ELEMENTS.has(tag) ? content : decodeEntities(content)));
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
		top().children.push(textNode(decodeEntities(html.slice(i, end))));
		i = end;
	}

	return root.children;
}

function escapeAttribute(value) {
	return String(value).replace(/[&"]/g, ch => ESCAPES[ch]);
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

export function renderVNode(node, rawText = false) {
	if (node == null) return "";
	if (typeof node === "string") return node;
	if (Array.isArray(node)) return node.map(renderVNode).join("");
	if (isDomNode(node)) return String(node);

	switch (node.type) {
		case "node":
			return String(node.node);
		case "text":
			return rawText ? node.value ?? "" : escapeHtml(node.value ?? "").replace(/&quot;|&#39;/g, m => m === "&quot;" ? '"' : "'");
		case "comment":
			return `<!--${node.value ?? ""}-->`;
		case "fragment":
			return (node.children || []).map(child => renderVNode(child)).join("");
		case "element": {
			const open = `<${node.tag}${renderAttributes(node.attrs)}>`;
			if (VOID_ELEMENTS.has(node.tag)) return open;
			const unescaped = UNESCAPED_TEXT_ELEMENTS.has(node.tag);
			const inner = (node.children || []).map(child => renderVNode(child, unescaped)).join("");
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
		case "node":
			return node.node;
		case "text":
			return doc.createTextNode(node.value ?? "");
		case "comment":
			return doc.createComment(node.value ?? "");
		case "fragment": {
			const frag = doc.createDocumentFragment();
			for (const child of node.children || []) frag.appendChild(vnodeToElement(child, doc));
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

const NODE_MARKER = "slim-node:";
let parkedNodes = [];

function isDomNode(value) {
	return !!value && typeof value === "object" && typeof value.nodeType === "number";
}

function stringifyChild(value) {
	if (value == null || value === false) return "";
	if (value instanceof SafeHtml) return value.value;
	if (value instanceof VNode) return renderVNode(value);
	if (Array.isArray(value)) return value.map(stringifyChild).join("");
	if (isDomNode(value)) return `<!--${NODE_MARKER}${parkedNodes.push(value) - 1}-->`;
	return escapeHtml(value);
}

function insideTag(html) {
	return html.lastIndexOf("<") > html.lastIndexOf(">");
}

function reviveParked(node) {
	if (!node || typeof node !== "object" || isDomNode(node)) return node;

	if (node.type === "comment" && typeof node.value === "string" && node.value.startsWith(NODE_MARKER)) {
		return parkedNodes[Number(node.value.slice(NODE_MARKER.length))] ?? node;
	}

	if (node.children) node.children = node.children.map(reviveParked);
	return node;
}

let eventHandlers = [];

function registerEventHandler(event, fn) {
	const id = eventHandlers.length;
	eventHandlers.push({ event, source: fn.toString(), fn });
	return id;
}

const boundEvents = new Set();

export function __bind_events__() {
	for (const { event } of eventHandlers) {
		if (boundEvents.has(event)) continue;
		boundEvents.add(event);
		document.addEventListener(event, e => {
			const el = e.target.closest(`[data-slim-on-${event}]`);
			if (!el) return;
			const entry = eventHandlers[el.getAttribute(`data-slim-on-${event}`)];
			if (entry && entry.fn) entry.fn.call(el, e);
		});
	}
}

export function __flush_events__() {
	if (eventHandlers.length === 0) return "";

	const handlers = eventHandlers;
	eventHandlers = [];

	const table = handlers.map((h, i) => `${i}:${h.source}`).join(",");
	const events = [...new Set(handlers.map(h => h.event))];

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

	return script.replace(/<\/script/gi, "<\\/script");
}

const __lifecycleRecords__ = new Set();
let __lifecycleObserver__ = null;

function __ensureLifecycleObserver__() {
	if (__lifecycleObserver__) return true;
	if (typeof MutationObserver === "undefined" || typeof document === "undefined") return false;

	__lifecycleObserver__ = new MutationObserver(() => {
		for (const r of [...__lifecycleRecords__]) {
			const connected = r.el.isConnected;
			if (connected && !r.connected) {
				r.connected = true;
				for (const fn of r.connectFns) fn(r.el);
				if (!r.unmountFns.length) __lifecycleRecords__.delete(r);
			} else if (!connected && r.connected) {
				__lifecycleRecords__.delete(r);
				for (const fn of r.unmountFns) fn(r.el);
			}
		}
	});
	__lifecycleObserver__.observe(document.documentElement, { childList: true, subtree: true });
	return true;
}

export function __lifecycle__(el, connectFns, unmountFns) {
	if ((!connectFns || !connectFns.length) && (!unmountFns || !unmountFns.length)) return;

	connectFns = connectFns || [];
	unmountFns = unmountFns || [];

	const r = { el, connectFns, unmountFns, connected: false };

	if (el.isConnected) {
		r.connected = true;
		for (const fn of connectFns) fn(el);
		if (!unmountFns.length) return;
	}

	if (!__ensureLifecycleObserver__()) {
		if (!r.connected) for (const fn of connectFns) fn(el);
		return;
	}

	__lifecycleRecords__.add(r);
}

export function __create_host__(tag) {
	const doc = typeof document !== "undefined" ? document : slimDocument;
	return doc.createElement(tag);
}

export function __adopt_into__(host, el) {
	if (el.nodeType === 11) {
		for (const child of [...el.childNodes]) if (child.parentNode !== host) host.appendChild(child);
		return;
	}

	if (el.parentNode !== host) host.appendChild(el);
}

function liveProps(signal) {
	return new Proxy({}, {
		get: (_, key) => signal.v[key],
		has: (_, key) => key in signal.v,
		ownKeys: () => Reflect.ownKeys(signal.v),
		getOwnPropertyDescriptor(_, key) {
			const value = signal.v;
			return key in value ? { value: value[key], enumerable: true, configurable: true } : undefined;
		}
	});
}

export function __define_element__(tag, factory) {
	if (typeof customElements === "undefined" || !hasNativeDom) return;
	if (customElements.get(tag)) return;

	customElements.define(tag, class extends HTMLElement {
		constructor() {
			super();
			this.__slim__ = null;
			this.__props__ = null;
			this.__slim_signal__ = null;

			if (Object.prototype.hasOwnProperty.call(this, "props")) {
				const pending = this.props;
				delete this.props;
				this.props = pending;
			}
		}

		get props() {
			return this.__props__ ?? {};
		}

		set props(value) {
			this.__props__ = value ?? {};
			if (this.__slim_signal__) this.__slim_signal__.v = this.__slim_props__();
		}

		__slim_props__() {
			const fromAttributes = {};

			for (const attribute of this.attributes) {
				fromAttributes[attribute.name] = attribute.value;

				if (!attribute.name.startsWith("data-")) continue;
				const key = attribute.name
					.slice("data-".length)
					.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
				if (key) fromAttributes[key] = attribute.value;
			}

			return { ...fromAttributes, ...this.__props__ };
		}

		__slim_render__() {
			const signal = this.__slim_signal__ = new Signal(this.__slim_props__());
			if (this.hasAttribute("hydrate") && typeof globalThis.hydrate === "function") {
				this.__slim__ = globalThis.hydrate(() => factory(liveProps(signal), this), this);
			} else {
				this.replaceChildren();
				this.__slim__ = factory(liveProps(signal), this);
			}

			if (typeof MutationObserver !== "undefined") {
				new MutationObserver(() => { signal.v = this.__slim_props__(); })
					.observe(this, { attributes: true });
			}
		}

		connectedCallback() {
			if (!this.__slim__) this.__slim_render__();
			for (const fn of this.__slim__?.connects ?? []) fn(this);
		}

		disconnectedCallback() {
			for (const fn of this.__slim__?.unmounts ?? []) fn(this);
		}
	});
}

export function __html__(strings, ...values) {
	let out = strings[0];

	for (let i = 0; i < values.length; i++) {
		const value = values[i];
		const eventMatch = out.match(/\son([A-Z][A-Za-z]*)=\s*$/);

		if (eventMatch) {
			out = out.slice(0, eventMatch.index);
			if (typeof value === "function") {
				const event = eventMatch[1].toLowerCase();
				const id = registerEventHandler(event, value);
				out += ` data-slim-on-${event}="${id}"`;
			}
		} else if (insideTag(out) && /=\s*$/.test(out)) {
			out += `"${escapeHtml(value instanceof SafeHtml ? value.value : value ?? "")}"`;
		} else {
			out += stringifyChild(value);
		}

		out += strings[i + 1];
	}

	return new SafeHtml(out);
}

export function __resolve_bem__(vnode, scope = "") {
	if (!vnode || typeof vnode !== "object") return vnode;

	if (vnode.type === "fragment") {
		for (const child of vnode.children || []) __resolve_bem__(child, scope);
		return vnode;
	}

	if (vnode.type === "element") {
		let childScope = scope;
		const cls = vnode.attrs && vnode.attrs.class;

		if (typeof cls === "string" && cls.length) {
			if (cls.includes("&")) vnode.attrs.class = cls.replaceAll("&", scope);
			childScope = vnode.attrs.class.trim().split(/\s+/)[0] || scope;
		}

		for (const child of vnode.children || []) __resolve_bem__(child, childScope);
	}

	return vnode;
}

export function htmlToVdom(input) {
	if (input instanceof VNode) return input;

	const html = input == null ? "" : input instanceof SafeHtml ? input.value : String(input);
	const nodes = parseNodes(html).map(reviveParked);
	parkedNodes = [];

	const meaningful = nodes.filter(n => !(n.type === "text" && n.value.trim() === ""));

	if (meaningful.length === 0) return fragmentNode([]);
	if (meaningful.length === 1) {
		const only = meaningful[0];
		return isDomNode(only) ? new VNode({ type: "node", node: only }) : only;
	}
	return fragmentNode(meaningful);
}
