import { CLIENT_RUNTIME } from "./client.js";
import { Owner, Signal, batch, cleanupOf, getOwner, onCleanup, runWithOwner } from "./reactive.js";

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

function collectHtml(build) {
	const outer = parking;
	parking = null;
	try {
		const safe = new SafeHtml(build());
		if (parking) safe.parked = parking;
		return safe;
	} finally {
		parking = outer;
	}
}

export function raw(html, options) {
	const safe = Array.isArray(html)
		? collectHtml(() => html.map(item => typeof item === "string" ? item : stringifyChild(item)).join(""))
		: html instanceof SafeHtml ? html : new SafeHtml(html == null ? "" : String(html));
	if (!options?.fresh) return safe;
	const fresh = new SafeHtml(safe.value);
	if (safe.parked) fresh.parked = safe.parked;
	fresh.fresh = true;
	return fresh;
}

raw.join = function (list, separator = "") {
	return collectHtml(() => [...(list ?? [])].map(stringifyChild).join(stringifyChild(separator)));
};

const hasNativeDom =
	typeof globalThis.document !== "undefined" &&
	typeof globalThis.HTMLElement !== "undefined";

function serverDom() {
	const { createRequire } = process.getBuiltinModule("node:module");
	return createRequire(import.meta.url)("linkedom").parseHTML("<!doctype html><html><head></head><body></body></html>");
}

const { document: slimDocument, HTMLElement } = hasNativeDom ? globalThis : serverDom();

export { slimDocument, HTMLElement };

let hydrateElement = null;

export function setHydrate(fn) {
	hydrateElement = fn;
}

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

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function element(tag, attrs, children, written = tag) {
	return new VNode({ type: "element", tag, written, attrs, children });
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
				const written = html.slice(i + 1, j);
				const tag = written.toLowerCase();

				const { attrs, selfClosing, end } = parseAttributes(html, j);
				const el = element(tag, attrs, [], written);
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

const SPELLED_BOOLEANS = new Set(["draggable", "spellcheck", "contenteditable"]);

export function spellsBoolean(name) {
	return name.startsWith("data-") || name.startsWith("aria-") || SPELLED_BOOLEANS.has(name);
}

function renderAttributes(attrs) {
	let out = "";
	for (const key in attrs) {
		const value = attrs[key];
		if (typeof value === "boolean" && spellsBoolean(key)) out += ` ${key}="${value}"`;
		else if (value === true) out += ` ${key}`;
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

export function vnodeToElement(node, doc = slimDocument, namespace = null) {
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
			for (const child of node.children || []) frag.appendChild(vnodeToElement(child, doc, namespace));
			frag.toString = fragmentToHtml;
			return frag;
		}
		case "element": {
			const own = node.tag === "svg" ? SVG_NAMESPACE : namespace;
			const el = own ? doc.createElementNS(own, node.written ?? node.tag) : doc.createElement(node.tag);
			const inner = own && node.tag === "foreignobject" ? null : own;
			const attrs = node.attrs || {};
			for (const key in attrs) {
				const value = attrs[key];
				if (typeof value === "boolean" && spellsBoolean(key)) el.setAttribute(key, String(value));
				else if (value === true) el.setAttribute(key, "");
				else if (value === false || value == null) continue;
				else el.setAttribute(key, String(value));
			}
			for (const child of node.children || []) el.appendChild(vnodeToElement(child, doc, inner));
			if (node.handlers) bindHandlers(el, node.handlers);
			if (node.props) el.props = { ...(el.props ?? {}), ...node.props };
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
let parking = null;
let parkedCount = 0;

function isDomNode(value) {
	return !!value && typeof value === "object" && typeof value.nodeType === "number";
}

function stringifyChild(value) {
	if (value == null || value === false) return "";
	if (value instanceof SafeHtml) {
		if (value.parked) for (const [id, node] of value.parked) (parking ??= new Map()).set(id, node);
		return value.value;
	}
	if (value instanceof VNode) return renderVNode(value);
	if (Array.isArray(value)) return value.map(stringifyChild).join("");
	if (isDomNode(value)) {
		const id = ++parkedCount;
		(parking ??= new Map()).set(id, value);
		return `<!--${NODE_MARKER}${id}-->`;
	}
	return escapeHtml(value);
}

const TEXT = 0;
const TAG = 1;
const DOUBLE_QUOTED = 2;
const SINGLE_QUOTED = 3;
const COMMENT = 4;

function scanHtml(state, chunk) {
	for (let i = 0; i < chunk.length; i++) {
		const ch = chunk[i];
		if (state.mode === TEXT) {
			if (ch !== "<") continue;
			if (chunk.startsWith("<!--", i)) {
				state.mode = COMMENT;
				i += 3;
			} else if (/[A-Za-z\/!]/.test(chunk[i + 1] ?? "")) {
				state.mode = TAG;
				state.afterEquals = false;
			}
		} else if (state.mode === TAG) {
			if (ch === ">") state.mode = TEXT;
			else if (ch === '"') state.mode = DOUBLE_QUOTED;
			else if (ch === "'") state.mode = SINGLE_QUOTED;
			else if (ch === "=") state.afterEquals = true;
			else if (!/\s/.test(ch)) state.afterEquals = false;
		} else if (state.mode === DOUBLE_QUOTED) {
			if (ch === '"') {
				state.mode = TAG;
				state.afterEquals = false;
			}
		} else if (state.mode === SINGLE_QUOTED) {
			if (ch === "'") {
				state.mode = TAG;
				state.afterEquals = false;
			}
		} else if (chunk.startsWith("-->", i)) {
			state.mode = TEXT;
			i += 2;
		}
	}
	return state;
}

function attributeText(value) {
	if (value == null || value === false) return "";
	if (Array.isArray(value)) return value.map(attributeText).join("");
	return escapeHtml(value instanceof SafeHtml ? value.value : value);
}

function attributeNames(value) {
	return attributeText(value)
		.split(/\s+/)
		.filter(name => /^[A-Za-z_:][\w:.-]*$/.test(name) && !/^on/i.test(name))
		.join(" ");
}

function inertAttributeText(value) {
	return attributeText(value).replace(/[\s=`]/g, ch => `&#${ch.charCodeAt(0)};`);
}

function reviveParked(node, parked) {
	if (!node || typeof node !== "object" || isDomNode(node)) return node;

	if (node.type === "comment" && typeof node.value === "string" && node.value.startsWith(NODE_MARKER)) {
		return parked.get(Number(node.value.slice(NODE_MARKER.length))) ?? node;
	}

	if (node.type === "element" && node.attrs) {
		for (const key of Object.keys(node.attrs)) {
			const value = node.attrs[key];
			if (key.startsWith(HANDLER_ATTRIBUTE)) {
				const entry = parked.get("on" + value);
				if (!entry) continue;
				(node.handlers ??= []).push(entry);
				delete node.attrs[key];
			} else if (typeof value === "string" && value.startsWith(PROP_MARKER) && parked.has(value)) {
				const prop = parked.get(value);
				if (key === "props") node.props = { ...node.props, ...prop };
				else (node.props ??= {})[camelName(key)] = prop;
				delete node.attrs[key];
			}
		}
	}

	if (node.children) node.children = node.children.map(child => reviveParked(child, parked));
	return node;
}

const HANDLER_ATTRIBUTE = "data-slim-on-";
const PROP_MARKER = "slim-prop:";

function camelName(name) {
	return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

let eventHandlers = new Map();
let handlerCount = 0;
let propCount = 0;

function registerEventHandler(event, fn, modifiers) {
	const id = ++handlerCount;
	const options = modifiers.length ? Object.fromEntries(modifiers.map(modifier => [modifier, true])) : undefined;
	const entry = { id, event, source: fn.toString(), fn, options };
	eventHandlers.set(id, entry);
	(parking ??= new Map()).set("on" + id, entry);
	return id;
}

function bindHandlers(el, handlers) {
	for (const entry of handlers) {
		eventHandlers.delete(entry.id);
		el.addEventListener(entry.event, function (e) {
			return batch(() => entry.fn.call(this, e));
		}, entry.options);
	}
}

const boundEvents = new Set();

export function __bind_events__() {
	for (const { event } of eventHandlers.values()) {
		if (boundEvents.has(event)) continue;
		boundEvents.add(event);
		document.addEventListener(event, e => {
			const el = e.target?.closest?.(`[${HANDLER_ATTRIBUTE}${event}]`);
			if (!el) return;
			const entry = eventHandlers.get(Number(el.getAttribute(`${HANDLER_ATTRIBUTE}${event}`)));
			if (entry && entry.fn) batch(() => entry.fn.call(el, e));
		}, true);
	}
}

export function __flush_events__() {
	if (eventHandlers.size === 0) return "";

	const handlers = [...eventHandlers.values()];
	eventHandlers = new Map();

	const table = handlers.map(h => `${h.id}:${h.source}`).join(",");
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
		`},true);` +
		`});` +
		`})();`;

	return script.replace(/<\/script/gi, "<\\/script");
}

class WeakItems {
	constructor() {
		this.refs = new Set();
		this.byItem = new WeakMap();
	}

	get size() {
		return this.refs.size;
	}

	add(item) {
		if (this.byItem.has(item)) return;
		const ref = typeof WeakRef === "function" ? new WeakRef(item) : { deref: () => item };
		this.byItem.set(item, ref);
		this.refs.add(ref);
	}

	delete(item) {
		const ref = this.byItem.get(item);
		if (!ref) return;
		this.byItem.delete(item);
		this.refs.delete(ref);
	}

	values() {
		const items = [];
		for (const ref of this.refs) {
			const item = ref.deref();
			if (item) items.push(item);
			else this.refs.delete(ref);
		}
		return items;
	}
}

const attachedLives = new WeakItems();
const waitingLives = new WeakItems();
const parkedNodes = new WeakSet();
let lifeObserver = null;

function isHeld(node) {
	let top = node;
	for (let current = node; current; current = current.parentNode) {
		if (parkedNodes.has(current)) return true;
		const life = current === node ? null : current.__slim_life__;
		if (life && life.kept && !life.done) return true;
		top = current;
	}
	if (top.nodeType === 11) for (const child of top.childNodes) if (parkedNodes.has(child)) return true;
	return false;
}

function releaseInside(root, except = null) {
	for (const life of attachedLives.values()) {
		if (life === except || life.node.isConnected) continue;
		if (root === life.node || root.contains?.(life.node)) {
			life.kept = false;
			life.detach();
		}
	}
	for (const el of root.querySelectorAll?.("*") ?? []) {
		const life = el.__slim_life__;
		if (!life || life === except || life.done || el.isConnected) continue;
		life.kept = false;
		if (life.connected) life.detach();
		else life.finish();
	}
}

export function __park__(nodes) {
	for (const node of nodes) parkedNodes.add(node);
}

export function __unpark__(nodes) {
	for (const node of nodes) parkedNodes.delete(node);
}

export function __release__(nodes) {
	__unpark__(nodes);
	for (const node of nodes) releaseInside(node);
}

function observeLives() {
	if (lifeObserver) return true;
	if (typeof MutationObserver === "undefined" || typeof document === "undefined" || !document.documentElement) return false;

	lifeObserver = new MutationObserver(mutations => {
		let added = false;
		let removed = false;
		for (const mutation of mutations) {
			if (mutation.addedNodes.length) added = true;
			if (mutation.removedNodes.length) removed = true;
		}
		if (removed) for (const life of attachedLives.values()) if (!life.node.isConnected && !isHeld(life.node)) life.detach();
		if (added) for (const life of waitingLives.values()) if (life.node.isConnected) life.attach();
	});
	lifeObserver.observe(document.documentElement, { childList: true, subtree: true });
	return true;
}

class Life {
	constructor(el, connects, unmounts, owner, observed) {
		this.el = el;
		this.node = el.nodeType === 11 ? (el.lastChild ?? el) : el;
		this.connects = connects;
		this.unmounts = unmounts;
		this.owner = owner;
		this.observed = observed;
		this.connected = false;
		this.kept = false;
		this.done = false;
	}

	busy() {
		return this.kept || this.connects.length > 0 || this.unmounts.length > 0 || !!this.owner?.owned || !!this.owner?.cleanups;
	}

	track() {
		if (!this.observed || this.done) return;
		if (this.connected) attachedLives.add(this);
		else waitingLives.add(this);
	}

	attach() {
		if (this.done || this.connected) return;
		this.connected = true;
		waitingLives.delete(this);
		if (this.observed) attachedLives.add(this);
		for (const fn of this.connects) fn(this.el);
	}

	detach() {
		if (this.done || !this.connected) return;
		this.connected = false;
		attachedLives.delete(this);
		for (const fn of this.unmounts) fn(this.el);
		if (this.kept) this.track();
		else this.finish();
	}

	finish() {
		if (this.done) return;
		this.done = true;
		attachedLives.delete(this);
		waitingLives.delete(this);
		this.owner?.dispose();
	}

	connect(fn) {
		this.connects.push(fn);
		if (this.connected) fn(this.el);
		else this.track();
	}

	unmount(fn) {
		this.unmounts.push(fn);
		this.track();
	}

	keep() {
		this.kept = true;
		this.track();
	}
}

export function __lifecycle__(el, connectFns, unmountFns) {
	const life = new Life(el, connectFns || [], unmountFns || [], getOwner(), true);
	if (!el || typeof el.nodeType !== "number") {
		life.observed = false;
		return life;
	}
	el.__slim_life__ = life;
	if (life.node !== el) life.node.__slim_life__ = life;
	if (!observeLives()) {
		life.observed = false;
		life.connected = true;
		for (const fn of life.connects) fn(el);
		return life;
	}
	if (life.node.isConnected) {
		life.connected = true;
		for (const fn of life.connects) fn(el);
	}
	if (life.busy()) life.track();
	return life;
}

function lifeOf(node) {
	return node?.__slim_life__ ?? null;
}

export function dispose(node) {
	const life = lifeOf(node);
	if (!life) return;
	if (life.connected || life.node.isConnected) {
		life.connected = true;
		life.kept = false;
		life.detach();
	} else {
		life.finish();
	}
	if (!node.isConnected) releaseInside(node, life);
}

export function onRemove(node, fn) {
	let active = true;
	const life = new Life(node, [], [() => { if (active) fn(node); }], null, true);
	if (!observeLives()) return () => { active = false; };
	const watchers = node.__slim_removals__ ??= new Set();
	watchers.add(life);
	life.connected = node.isConnected;
	life.track();
	return () => {
		active = false;
		watchers.delete(life);
		life.finish();
	};
}

function addListener(owner, target, event, fn, options) {
	const handler = function (e) { return batch(() => fn.call(this, e)); };
	target.addEventListener(event, handler, options);
	const stop = () => target.removeEventListener(event, handler, options);
	if (owner) cleanupOf(owner, stop);
	return stop;
}

export function listen(target, event, fn, options) {
	return addListener(getOwner(), target, event, fn, options);
}

export function __listener__(lifeOf = null) {
	const owner = getOwner();
	return (target, event, fn, options) => {
		const stop = addListener(owner, target, event, fn, options);
		lifeOf?.()?.track();
		return stop;
	};
}

export function setHtml(el, markup) {
	const node = vnodeToElement(htmlToVdom(markup), el.ownerDocument ?? slimDocument);
	el.replaceChildren(node);
	upgrade(el);
	return el;
}

const rendered = new WeakMap();

export function render(view, target) {
	rendered.get(target)?.();
	let node = null;
	const owner = new Owner(null);
	runWithOwner(owner, () => {
		node = typeof view === "function" && !view.__component__ ? view() : typeof view === "function" ? view({}) : view;
	});
	const shown = node == null ? null : typeof node.nodeType === "number" ? node : vnodeToElement(htmlToVdom(node));
	const nodes = shown == null ? [] : shown.nodeType === 11 ? [...shown.childNodes] : [shown];
	target.replaceChildren(...nodes);
	const stop = () => {
		if (rendered.get(target) !== stop) return;
		rendered.delete(target);
		for (const child of nodes) {
			dispose(child);
			if (child.parentNode === target) target.removeChild(child);
		}
		owner.dispose();
	};
	rendered.set(target, stop);
	return stop;
}

export function __create_host__(tag) {
	const doc = typeof document !== "undefined" ? document : slimDocument;
	return doc.createElement(tag);
}

export function __adopt_into__(host, el) {
	if (el === host) return;
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

const pendingElements = new WeakItems();
let attributeObserver = null;

function watchAttributes(el) {
	if (typeof MutationObserver === "undefined") return;
	attributeObserver ??= new MutationObserver(records => {
		const seen = new Set();
		for (const { target } of records) {
			if (seen.has(target)) continue;
			seen.add(target);
			if (target.__slim_life__ && !target.__slim_life__.done) target.__slim_signal__.v = target.__slim_props__();
		}
	});
	attributeObserver.observe(el, { attributes: true });
}
const definedTags = new Set();

function meaningful(nodes) {
	return nodes.some(node => node.nodeType === 1 || (node.nodeType === 3 && node.data.trim() !== ""));
}

export function upgrade(root) {
	if (!root) return root;
	if (typeof customElements !== "undefined" && typeof customElements.upgrade === "function") {
		if (root.nodeType === 1) customElements.upgrade(root);
		else if (root.nodeType === 11) for (const child of root.children ?? []) customElements.upgrade(child);
	}
	if (pendingElements.size === 0) return root;
	let found = true;
	while (found) {
		found = false;
		for (const el of pendingElements.values()) {
			if (el !== root && !(typeof root.contains === "function" && root.contains(el))) continue;
			found = true;
			el.__slim_render__();
		}
	}
	return root;
}

export const __upgrade__ = upgrade;

export function __element_host__(tag, props) {
	if (!definedTags.has(tag)) return null;
	const doc = typeof document !== "undefined" ? document : slimDocument;
	const host = doc.createElement(tag);
	host.props = props;
	return host;
}

export function __element_life__(host, connects, unmounts) {
	const life = new Life(host, connects, unmounts, getOwner(), false);
	host.__slim_life__ = life;
	return life;
}

export function __define_element__(tag, factory) {
	if (typeof customElements === "undefined" || !hasNativeDom) return;
	if (customElements.get(tag)) return;

	customElements.define(tag, class extends HTMLElement {
		constructor() {
			super();
			this.__slim_life__ = null;
			this.__props__ = null;
			this.__slim_signal__ = null;
			this.__slim_children__ = null;
			this.__slim_watched__ = false;

			if (Object.prototype.hasOwnProperty.call(this, "props")) {
				const pending = this.props;
				delete this.props;
				this.__props__ = pending ?? {};
			}
			pendingElements.add(this);
		}

		get props() {
			return this.__props__ ?? {};
		}

		set props(value) {
			this.__props__ = value ?? {};
			const life = this.__slim_life__;
			if (life && !life.done) this.__slim_signal__.v = this.__slim_props__();
			else if (!life && !this.hasAttribute("hydrate")) this.__slim_render__();
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

			const children = this.__slim_children__ && meaningful(this.__slim_children__) ? { children: this.__slim_children__ } : {};
			return { ...fromAttributes, ...children, ...this.__props__ };
		}

		__slim_render__() {
			pendingElements.delete(this);
			const hydrate = hydrateElement ?? globalThis.hydrate;
			const hydrating = this.hasAttribute("hydrate") && typeof hydrate === "function";
			if (!hydrating && this.__slim_children__ === null) this.__slim_children__ = [...this.childNodes];
			const signal = this.__slim_signal__ = new Signal(this.__slim_props__());
			if (hydrating) {
				this.__slim_life__ = hydrate(() => factory(liveProps(signal), this), this);
			} else {
				this.replaceChildren();
				this.__slim_life__ = factory(liveProps(signal), this);
			}
			if (this.hasAttribute("keep-alive")) this.__slim_life__?.keep?.();

			if (!this.__slim_watched__) {
				this.__slim_watched__ = true;
				watchAttributes(this);
			}
		}

		connectedCallback() {
			if (!this.__slim_life__ || this.__slim_life__.done) this.__slim_render__();
			this.__slim_life__?.attach?.();
		}

		disconnectedCallback() {
			queueMicrotask(() => {
				if (!this.isConnected && !isHeld(this)) this.__slim_life__?.detach?.();
			});
		}
	});
	definedTags.add(tag);
}

export function __html__(strings, ...values) {
	const outer = parking;
	parking = null;
	try {
		const safe = new SafeHtml(buildHtml(strings, values));
		if (parking) safe.parked = parking;
		return safe;
	} finally {
		parking = outer;
	}
}

function openTag(out) {
	return out.slice(out.lastIndexOf("<") + 1).match(/^[A-Za-z][\w.-]*/)?.[0] ?? "";
}

function isPropValue(value) {
	if (typeof value === "function") return true;
	if (!value || typeof value !== "object" || value instanceof SafeHtml) return false;
	return !Array.isArray(value) || value.some(item => item !== null && typeof item === "object" && !(item instanceof SafeHtml));
}

function buildHtml(strings, values) {
	let out = strings[0];
	const state = scanHtml({ mode: TEXT, afterEquals: false }, strings[0]);

	for (let i = 0; i < values.length; i++) {
		const value = values[i];
		const chunk = strings[i];
		const eventMatch = state.mode === TAG && state.afterEquals ? chunk.match(/\son([A-Z][A-Za-z]*)((?::[a-z]+)*)=\s*$/) : null;

		if (eventMatch) {
			out = out.slice(0, out.length - chunk.length + eventMatch.index);
			if (typeof value === "function") {
				const event = eventMatch[1].toLowerCase();
				const id = registerEventHandler(event, value, eventMatch[2].split(":").filter(Boolean));
				out += ` ${HANDLER_ATTRIBUTE}${event}="${id}"`;
			}
		} else if (state.mode === TAG && state.afterEquals && isPropValue(value) && openTag(out).includes("-")) {
			const marker = PROP_MARKER + ++propCount;
			(parking ??= new Map()).set(marker, value);
			out += `"${marker}"`;
		} else if (state.mode === TAG && state.afterEquals) {
			out += `"${attributeText(value)}"`;
		} else if (state.mode === TAG) {
			out += /\s$/.test(out) ? attributeNames(value) : inertAttributeText(value);
		} else if (state.mode === DOUBLE_QUOTED || state.mode === SINGLE_QUOTED) {
			out += attributeText(value);
		} else if (state.mode === TEXT && /<\/?$/.test(out)) {
			const name = value == null || value === false ? "" : String(value);
			if (!/^[A-Za-z][\w.:-]*$/.test(name)) throw new Error(`"${name}" is not a tag name: a dynamic tag outside a component takes a tag name`);
			out += name;
			if (!out.endsWith("</" + name)) {
				state.mode = TAG;
				state.afterEquals = false;
			}
		} else if (state.mode === COMMENT) {
			out += attributeText(value).replace(/--/g, "&#45;&#45;");
		} else {
			out += stringifyChild(value);
		}

		state.afterEquals = false;
		out += strings[i + 1];
		scanHtml(state, strings[i + 1]);
	}

	return out;
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
	const parked = input instanceof SafeHtml ? input.parked : null;
	const nodes = parked ? parseNodes(html).map(node => reviveParked(node, parked)) : parseNodes(html);

	const meaningful = nodes.filter(n => !(n.type === "text" && n.value.trim() === ""));

	if (meaningful.length === 0) return fragmentNode([]);
	if (meaningful.length === 1) {
		const only = meaningful[0];
		return isDomNode(only) ? new VNode({ type: "node", node: only }) : only;
	}
	return fragmentNode(meaningful);
}
