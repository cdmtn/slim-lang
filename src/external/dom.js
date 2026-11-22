import { SafeHtml, VNode, htmlToVdom, slimDocument, setHydrate } from "./helpers.js"
import { Owner, __render_effect__, __computed__, runWithOwner, setServerRendering, setServerData, setHydrationData, setServerStore, setClientStore } from "./reactive.js"
import { __attr__, __s__, __set__, __spread__ } from "./dom/attributes.js"
import { Portal, __on__, __ref__ } from "./dom/events.js"
import { __dynamic__ } from "./dom/dynamic.js"
import { __list__, __move__ } from "./dom/list.js"
export { __set__, __attr__, __s__, __spread__ } from "./dom/attributes.js"
export { __on__, Portal, __ref__ } from "./dom/events.js"
export { __dynamic__ } from "./dom/dynamic.js"
export { __move__, __list__ } from "./dom/list.js"

const SVG_NS = "http://www.w3.org/2000/svg"
export const START = "["
const END = "]"

export let serverRendering = false
export let cursor = null

const isComment = (node, data) => node?.nodeType === 8 && node.data === data

function build(node, doc, svg, server) {
    if (typeof node === "string") return node === "" && server ? doc.createComment(END) : doc.createTextNode(node)
    const [tag, attrs] = node
    if (tag === "#comment") return doc.createComment(attrs)

    const inSvg = svg || tag === "svg"
    const el = inSvg ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag)
    if (attrs) for (const name in attrs) el.setAttribute(name, attrs[name] === true ? "" : attrs[name])
    const childSvg = inSvg && tag !== "foreignObject"
    for (let i = 2; i < node.length; i++) el.appendChild(build(node[i], doc, childSvg, server))
    return el
}

let pendingHost = null

export function __with_host__(host, fn) {
    const previous = pendingHost
    pendingHost = host
    try {
        return fn()
    } finally {
        pendingHost = previous
    }
}

function intoHost(host, node, svg) {
    pendingHost = null
    const [, attrs] = node
    if (attrs) for (const name in attrs) host.setAttribute(name, attrs[name] === true ? "" : attrs[name])
    if (cursor) {
        cursor.index = cursor.nodes.length
        return host
    }
    for (let i = 2; i < node.length; i++) host.appendChild(build(node[i], slimDocument, svg, serverRendering))
    return host
}

export function __template__(roots, svg = false) {
    const protos = {}
    const hosted = roots.length === 1 && Array.isArray(roots[0]) && roots[0][0] === "host"
    return () => {
        if (hosted && pendingHost) return intoHost(pendingHost, roots[0], svg)
        if (cursor) return claimTemplate(roots)
        const mode = serverRendering ? "server" : "client"
        let proto = protos[mode]
        if (!proto) {
            const doc = slimDocument
            if (roots.length === 1) {
                proto = build(roots[0], doc, svg, serverRendering)
            } else {
                proto = doc.createDocumentFragment()
                for (const root of roots) proto.appendChild(build(root, doc, svg, serverRendering))
            }
            protos[mode] = proto
        }
        const copy = proto.cloneNode(true)
        if (copy.nodeType === 11) copy.toString = fragmentToHtml
        return copy
    }
}

function fragmentToHtml() {
    let out = ""
    for (const child of this.__slimNodes ?? this.childNodes) out += child.toString()
    return out
}

function stepOver(node) {
    if (!cursor || !isComment(node, START)) return node
    let depth = 0
    for (let next = node.nextSibling; next; next = next.nextSibling) {
        if (isComment(next, START)) depth++
        else if (isComment(next, END)) {
            if (depth === 0) return next
            depth--
        }
    }
    return node
}

export function __child__(parent, index) {
    let node = stepOver(parent.firstChild)
    for (let i = 0; i < index; i++) node = stepOver(node.nextSibling)
    return node
}

export function __next__(node, count) {
    for (let i = 0; i < count; i++) node = stepOver(node.nextSibling)
    return node
}

function groupBefore(end) {
    const content = []
    let depth = 0
    let node = end.previousSibling
    for (; node; node = node.previousSibling) {
        if (isComment(node, END)) depth++
        else if (isComment(node, START)) {
            if (depth === 0) break
            depth--
        }
        content.unshift(node)
    }
    node?.parentNode.removeChild(node)
    return content
}

function skipGroup(nodes, index) {
    let depth = 0
    for (let i = index + 1; i < nodes.length; i++) {
        if (isComment(nodes[i], START)) depth++
        else if (isComment(nodes[i], END)) {
            if (depth === 0) return i
            depth--
        }
    }
    return nodes.length - 1
}

const isBlank = node => node.nodeType === 3 && node.data.trim() === ""

export function claim(expectElement) {
    const { nodes } = cursor
    while (cursor.index < nodes.length) {
        const node = nodes[cursor.index]
        if (expectElement && (isBlank(node) || (node.nodeType === 8 && node.data !== START && node.data !== END))) {
            cursor.index++
            continue
        }
        if (isComment(node, START)) {
            const end = skipGroup(nodes, cursor.index)
            cursor.index = end + 1
            return nodes[end]
        }
        cursor.index++
        return node
    }
    return slimDocument.createTextNode("")
}

function claimed(first, last) {
    return {
        nodeType: 11,
        firstChild: first,
        __slimRange: [first, last],
        get __slimNodes() {
            const nodes = []
            for (let node = first; node; node = node.nextSibling) {
                nodes.push(node)
                if (node === last) break
            }
            return nodes
        },
        get childNodes() { return this.__slimNodes }
    }
}

const RAW_TEXT = new Set(["title", "textarea", "script", "style"])

function restoreRawText(template, el) {
    if (!Array.isArray(template) || !el || el.nodeType !== 1 || template[0] === "#comment") return
    const children = template.slice(2)
    if (RAW_TEXT.has(template[0])) {
        if (!children.some(child => child === "" || Array.isArray(child))) return
        el.textContent = ""
        for (const child of children) el.appendChild(build(child, slimDocument, false, false))
        return
    }
    let node = null
    for (const child of children) {
        node = stepOver(node === null ? el.firstChild : node.nextSibling)
        if (!node) return
        restoreRawText(child, node)
    }
}

function claimTemplate(roots) {
    const nodes = roots.map(root => claim(Array.isArray(root) && root[0] !== "#comment"))
    roots.forEach((root, index) => restoreRawText(root, nodes[index]))
    return nodes.length === 1 ? nodes[0] : claimed(nodes[0], nodes[nodes.length - 1])
}

export function withCursor(nodes, fn) {
    const previous = cursor
    cursor = { nodes, index: 0 }
    try {
        return fn()
    } finally {
        cursor = previous
    }
}

export function __defer_hydration__() {
    if (!cursor) return null
    const held = cursor.nodes.slice(cursor.index)
    cursor.index = cursor.nodes.length
    return held
}

export function __resume_hydration__(nodes, fn) {
    return withCursor(nodes, fn)
}

export function withoutCursor(fn) {
    const previous = cursor
    cursor = null
    try {
        return fn()
    } finally {
        cursor = previous
    }
}

export function claimedContent(anchor) {
    return isComment(anchor, END) ? groupBefore(anchor) : null
}

const nodesOfHtml = new WeakMap()
const htmlOfNodes = new WeakMap()

function sameHtml(value, out, current) {
    if (!current || !(value instanceof SafeHtml)) return null
    for (const node of current) {
        const known = htmlOfNodes.get(node)
        if (!known || known.html !== value.value || out.includes(known.nodes[0])) continue
        if (known.nodes.every(item => current.includes(item))) return known.nodes
    }
    return null
}

function groupHead(fragment) {
    if (fragment.__slimHead) return [fragment.__slimHead]
    const range = fragment.__slimRange
    if (range && !range[0].parentNode) return fragment.__slimNodes
    const head = slimDocument.createTextNode("")
    const end = slimDocument.createTextNode("")
    head.__slimEnd = end
    if (range) {
        range[0].parentNode.insertBefore(head, range[0])
        range[1].parentNode.insertBefore(end, range[1].nextSibling)
    } else {
        fragment.insertBefore(head, fragment.firstChild)
        fragment.appendChild(end)
    }
    fragment.__slimHead = head
    return [head]
}

export function rangeOf(node) {
    const end = node.__slimEnd
    if (!end) return [node]
    const nodes = []
    for (let current = node; current; current = current.nextSibling) {
        nodes.push(current)
        if (current === end) break
    }
    return nodes
}

function lastOf(node) {
    return node.__slimEnd ?? node
}

export function place(parent, node, ref) {
    if (!node.__slimEnd) {
        parent.insertBefore(node, ref)
        return
    }
    for (const item of rangeOf(node)) parent.insertBefore(item, ref)
}

export function toNodes(value, out, current = null) {
    if (value == null || value === false || value === true) return out
    if (typeof value === "function" && value.__slimLive) return toNodes(__root__(value), out, current)
    if (Array.isArray(value)) {
        for (const item of value) toNodes(item, out, current)
        return out
    }
    if (typeof value === "object") {
        if (typeof value.nodeType === "number") {
            if (value.nodeType !== 11) out.push(value)
            else out.push(...groupHead(value))
            return out
        }
        if (value instanceof SafeHtml || value instanceof VNode) {
            let nodes = nodesOfHtml.get(value)
            if (!nodes && !serverRendering && !value.fresh) {
                nodes = sameHtml(value, out, current)
                if (nodes) nodesOfHtml.set(value, nodes)
            }
            if (!nodes || serverRendering) {
                const element = (value instanceof VNode ? value : htmlToVdom(value)).toElement(slimDocument)
                nodes = element.nodeType === 11 ? [...element.childNodes] : [element]
                if (!serverRendering) {
                    nodesOfHtml.set(value, nodes)
                    if (value instanceof SafeHtml && nodes.length) htmlOfNodes.set(nodes[0], { html: value.value, nodes })
                }
            }
            else if (nodes.some(node => node.parentNode && !current?.includes(node))) {
                nodes = nodes.map(node => node.cloneNode(true))
            }
            out.push(...nodes)
            return out
        }
    }
    out.push(slimDocument.createTextNode(String(value)))
    return out
}

export const isText = value => typeof value === "string" || typeof value === "number" || typeof value === "bigint"

function put(anchor, value, current) {
    const parent = anchor.parentNode
    if (isText(value)) {
        const text = String(value)
        if (anchor.nodeType === 3) {
            if (current.length) remove(current)
            if (anchor.data !== text) anchor.data = text
            return EMPTY
        }
        let node = current.length === 1 && current[0].nodeType === 3 ? current[0] : null
        if (!node) {
            remove(current)
            node = slimDocument.createTextNode(text)
        } else if (node.data !== text) {
            node.data = text
        }
        if (node.parentNode !== parent || node.nextSibling !== anchor) parent.insertBefore(node, anchor)
        return [node]
    }

    if (anchor.nodeType === 3 && anchor.data !== "") anchor.data = ""
    const next = toNodes(value, [], current)
    if (next.length === 0) {
        if (current.length) remove(current)
        return EMPTY
    }

    if (current.length) {
        const keep = new Set(next.flatMap(rangeOf))
        for (const node of current) if (!keep.has(node)) remove([node])
    }
    let ref = anchor
    for (let i = next.length - 1; i >= 0; i--) {
        const node = next[i]
        if (lastOf(node).nextSibling !== ref || node.parentNode !== parent) place(parent, node, ref)
        ref = node
    }
    return next
}

const EMPTY = []

export function remove(nodes) {
    for (const node of nodes) {
        const range = rangeOf(node)
        if (range.length > 1 && !range.some(item => item.__leave)) {
            const holder = slimDocument.createDocumentFragment()
            for (const item of range) holder.appendChild(item)
            continue
        }
        for (const item of range) {
            if (item.__leave) leave(item)
            else item.parentNode?.removeChild(item)
        }
    }
}

function leave(node) {
    const className = node.__leave
    node.__leave = null
    node.classList.add(className)
    const animations = typeof node.getAnimations === "function" ? node.getAnimations({ subtree: true }) : []
    if (animations.length === 0) {
        node.parentNode?.removeChild(node)
        return
    }
    Promise.all(animations.map(animation => animation.finished.catch(() => {})))
        .then(() => node.parentNode?.removeChild(node))
}

export function __leave__(el, className) {
    if (!serverRendering) el.__leave = className
}

export function __enter__(el, className) {
    if (serverRendering || cursor) return
    el.classList.add(className)
    const done = event => {
        if (event.target !== el) return
        el.classList.remove(className)
        el.removeEventListener("animationend", done)
        el.removeEventListener("transitionend", done)
    }
    el.addEventListener("animationend", done)
    el.addEventListener("transitionend", done)
}

export function __once__(anchor, value) {
    if (serverRendering) anchor.parentNode.insertBefore(slimDocument.createComment(START), anchor)
    const content = cursor ? claimedContent(anchor) : null
    put(anchor, value, content ?? EMPTY)
}

export function __insert__(anchor, fn) {
    if (serverRendering) anchor.parentNode.insertBefore(slimDocument.createComment(START), anchor)
    let current = EMPTY
    let content = cursor ? claimedContent(anchor) : null
    __render_effect__(() => {
        if (content) {
            const claimed = content
            content = null
            current = claimed
            current = put(anchor, withCursor(claimed, fn), current)
            return
        }
        current = put(anchor, fn(), current)
    })
}

export function __root__(fn) {
    if (cursor && isComment(cursor.nodes[cursor.index], START)) return hydrateRoot(fn)
    const value = __computed__(fn)
    const first = value.peek()
    if (!value.sources) {
        if (first && first.nodeType === 11) return first
        const nodes = toNodes(isText(first) ? slimDocument.createTextNode(String(first)) : first, [])
        if (nodes.length === 1 && !nodes[0].__slimEnd) return nodes[0]
    }
    const fragment = slimDocument.createDocumentFragment()
    fragment.toString = fragmentToHtml
    const anchor = serverRendering ? slimDocument.createComment(END) : slimDocument.createTextNode("")
    fragment.appendChild(anchor)
    __insert__(anchor, () => value.v)
    return fragment
}

function hydrateRoot(fn) {
    const anchor = claim(false)
    let first = anchor
    for (let node = anchor.previousSibling; node && !isComment(node, START); node = node.previousSibling) first = node
    const firstOf = first === anchor ? null : first
    __insert__(anchor, fn)
    return claimed(firstOf?.parentNode ? firstOf : anchor, anchor)
}

export function __branch__(test, yes, no) {
    const truthy = __computed__(() => !!test())
    return () => truthy.v ? yes() : no ? no() : null
}

const ESCAPED_TEXT = { "&": "&amp;", "<": "&lt;", ">": "&gt;" }

function guardRawText(root) {
    for (const el of root.querySelectorAll("textarea, title, script, style")) {
        if (el.closest("svg")) continue
        const text = el.textContent
        const name = el.localName.toLowerCase()
        const safe = name === "textarea" || name === "title"
            ? text.replace(/[&<>]/g, char => ESCAPED_TEXT[char])
            : name === "script"
                ? text.replace(/<\//g, "<\\/").replace(/<!--/g, "<\\u0021--")
                : text.replace(/<\//g, "<\\/")
        if (safe !== text) el.textContent = safe
    }
}

export function renderToString(render) {
    const scope = new Owner(null)
    serverRendering = true
    setServerRendering(true)
    try {
        let value = runWithOwner(scope, render)
        if (value instanceof SafeHtml && !value.parked) return value.value
        if (value instanceof SafeHtml) value = htmlToVdom(value).toElement(slimDocument)
        if (value == null || typeof value !== "object" || typeof value.nodeType !== "number") return String(value ?? "")
        const box = slimDocument.createElement("div")
        box.appendChild(value)
        guardRawText(box)
        return box.innerHTML
    } finally {
        serverRendering = false
        setServerRendering(false)
        scope.dispose()
    }
}

export async function renderToStringAsync(render, { passes = 5, store: initialStore, title, url } = {}) {
    const data = { results: new Map(), pending: [], order: [], seen: new Map(), url }
    for (let pass = 1; ; pass++) {
        data.pending = []
        data.head = []
        data.order = []
        data.seen = new Map()
        data.components = new Map()
        const store = Object.create(null)
        if (initialStore && typeof initialStore === "object") Object.assign(store, initialStore)
        setServerData(data)
        setServerStore(store)
        let html
        try {
            html = renderToString(render)
        } finally {
            setServerData(null)
            setServerStore(null)
        }
        if (data.pending.length === 0 || pass === passes) {
            const sent = data.order.map(key => {
                const result = data.results.get(key)
                if (!result) return null
                return result.error !== undefined
                    ? { error: String(result.error?.message ?? result.error) }
                    : { value: result.value }
            })
            const literal = value => JSON.stringify(JSON.stringify(value)).replace(/</g, "\\u003c")
            return {
                html, data: sent, store,
                head: data.headHtml ? data.headHtml(data.head, title) : title == null ? "" : `<title>${String(title).replace(/[&<>]/g, char => ESCAPED_TEXT[char])}</title>`,
                script: `<script>window.__slimData = JSON.parse(${literal(sent)});window.__slimStore = JSON.parse(${literal(store)})</script>`
            }
        }
        await Promise.all(data.pending)
    }
}

export function hydrate(render, container, data = globalThis.__slimData, store = globalThis.__slimStore) {
    const previous = cursor
    cursor = { nodes: [...container.childNodes], index: 0 }
    setHydrationData(Array.isArray(data) ? { values: data, index: 0 } : null)
    setClientStore(store && typeof store === "object" ? store : null)
    try {
        return render()
    } finally {
        cursor = previous
        setHydrationData(null)
        setClientStore(null)
    }
}

setHydrate(hydrate)

export const DOM_GLOBALS = {
    __child__, __next__, __template__, __insert__, __once__, __root__, __branch__, __attr__, __set__, __s__, __spread__, __on__, __list__,
    __enter__, __leave__, __move__, __ref__, Portal, __dynamic__, __with_host__,
    renderToString, renderToStringAsync, hydrate
}
