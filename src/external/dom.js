import { SafeHtml, VNode, htmlToVdom, slimDocument, parseAttributeList } from "./helpers.js"
import {
    Owner, Signal, __render_effect__, __computed__, __component__, batch, runWithOwner, untrack, onCleanup, changedInPlace,
    setServerRendering, setRootHook, setServerData, setHydrationData
} from "./reactive.js"

const SVG_NS = "http://www.w3.org/2000/svg"
const START = "["
const END = "]"

let serverRendering = false
let cursor = null

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

export function __template__(roots, svg = false) {
    const protos = {}
    return () => {
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

function claim(expectElement) {
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

function claimTemplate(roots) {
    const nodes = roots.map(root => claim(Array.isArray(root) && root[0] !== "#comment"))
    return nodes.length === 1 ? nodes[0] : claimed(nodes[0], nodes[nodes.length - 1])
}

function withCursor(nodes, fn) {
    const previous = cursor
    cursor = { nodes, index: 0 }
    try {
        return fn()
    } finally {
        cursor = previous
    }
}

function claimedContent(anchor) {
    return isComment(anchor, END) ? groupBefore(anchor) : null
}


const nodesOfHtml = new WeakMap()

function toNodes(value, out) {
    if (value == null || value === false || value === true) return out
    if (typeof value === "function" && value.__slimLive) return toNodes(__root__(value), out)
    if (Array.isArray(value)) {
        for (const item of value) toNodes(item, out)
        return out
    }
    if (typeof value === "object") {
        if (typeof value.nodeType === "number") {
            if (value.nodeType !== 11) out.push(value)
            else out.push(...(value.__slimNodes ??= [...value.childNodes]))
            return out
        }
        if (value instanceof SafeHtml || value instanceof VNode) {
            let nodes = nodesOfHtml.get(value)
            if (!nodes) {
                const element = (value instanceof VNode ? value : htmlToVdom(value)).toElement(slimDocument)
                nodes = element.nodeType === 11 ? [...element.childNodes] : [element]
                nodesOfHtml.set(value, nodes)
            }
            out.push(...nodes)
            return out
        }
    }
    out.push(slimDocument.createTextNode(String(value)))
    return out
}

const isText = value => typeof value === "string" || typeof value === "number" || typeof value === "bigint"

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
    const next = toNodes(value, [])
    if (next.length === 0) {
        if (current.length) remove(current)
        return EMPTY
    }

    if (current.length) {
        const keep = new Set(next)
        for (const node of current) if (!keep.has(node)) node.parentNode?.removeChild(node)
    }
    let ref = anchor
    for (let i = next.length - 1; i >= 0; i--) {
        const node = next[i]
        if (node.nextSibling !== ref || node.parentNode !== parent) parent.insertBefore(node, ref)
        ref = node
    }
    return next
}

const EMPTY = []

function remove(nodes) {
    for (const node of nodes) {
        if (node.__leave) leave(node)
        else node.parentNode?.removeChild(node)
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
        const nodes = toNodes(isText(first) ? slimDocument.createTextNode(String(first)) : first, [])
        if (nodes.length === 1) return nodes[0]
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


const PROPERTIES = new Set(["value", "checked", "selected", "muted", "indeterminate", "disabled"])

function setAttribute(el, name, value) {
    if (PROPERTIES.has(name) && name in el) {
        const next = name === "value" ? (value == null ? "" : String(value)) : value === "" ? true : !!value
        if (el[name] !== next) el[name] = next
    }
    if (typeof value === "boolean" && (name.startsWith("data-") || name.startsWith("aria-"))) el.setAttribute(name, String(value))
    else if (value === true) el.setAttribute(name, "")
    else if (value == null || value === false) el.removeAttribute(name)
    else el.setAttribute(name, String(value))
}

export function __set__(el, name, value) {
    setAttribute(el, name, value)
}

export function __attr__(el, name, fn) {
    let previous
    __render_effect__(() => {
        const value = fn()
        if (Object.is(value, previous) && previous !== undefined) return
        previous = value
        setAttribute(el, name, value)
    })
}

export function __s__(value) {
    if (value == null || value === false) return ""
    if (value instanceof SafeHtml) return value.value
    return String(value)
}

export function __spread__(el, fn) {
    let previous = {}
    __render_effect__(() => {
        const value = fn()
        const next = value == null || value === false ? {}
            : typeof value === "object" && !(value instanceof SafeHtml) ? value
            : parseAttributeList(__s__(value))
        for (const name in previous) if (!(name in next)) el.removeAttribute(name)
        for (const name in next) if (next[name] !== previous[name]) setAttribute(el, name, next[name])
        previous = next
    })
}

const DELEGATED = new Set([
    "click", "dblclick", "contextmenu", "input", "change", "submit", "keydown", "keyup",
    "pointerdown", "pointerup", "pointermove", "mousedown", "mouseup", "touchstart", "touchend", "focusin", "focusout"
])
const listening = new Set()

function dispatch(e) {
    const key = "$$" + e.type
    batch(() => {
        for (const node of e.composedPath()) {
            const handler = node[key]
            if (handler) {
                Object.defineProperty(e, "currentTarget", { configurable: true, get: () => node })
                handler.call(node, e)
                if (e.cancelBubble) break
            }
            if (node === slimDocument) break
        }
    })
}

function dispatchOutside(e) {
    if (e.composedPath().includes(slimDocument)) return
    dispatch(e)
}

setRootHook(value => {
    if (!value || typeof value.nodeType !== "number" || listening.size === 0) return
    const roots = value.nodeType === 11 ? [...(value.__slimNodes ?? value.childNodes)] : [value]
    for (const root of roots) {
        if (root.nodeType !== 1 || root.isConnected) continue
        for (const event of listening) root.addEventListener(event, dispatchOutside)
    }
})

export function __on__(el, event, handler) {
    if (typeof handler !== "function" || serverRendering) return
    if (DELEGATED.has(event) && typeof document !== "undefined" && slimDocument === document) {
        el["$$" + event] = handler
        if (!listening.has(event)) {
            listening.add(event)
            slimDocument.addEventListener(event, dispatch)
        }
        return
    }
    el.addEventListener(event, function (e) {
        return batch(() => handler.call(el, e))
    })
}


export function Portal(props = {}) {
    return __component__(() => {
        const placeholder = slimDocument.createTextNode("")
        if (serverRendering || cursor) return placeholder
        const to = props.to
        const target = typeof to === "string" ? slimDocument.querySelector(to) : to ?? slimDocument.body
        if (!target) throw new Error(`Portal: nothing matches "${to}"`)
        const shown = toNodes(props.children, [])
        for (const node of shown) target.appendChild(node)
        onCleanup(() => remove(shown))
        return placeholder
    })
}
Portal.__component__ = true


export function __move__(el, duration) {
    if (!serverRendering) el.__move = Number(duration) || 200
}

function positions(rows) {
    let found = null
    for (const row of rows) {
        const node = row?.nodes[0]
        if (node?.__move && node.isConnected) (found ??= new Map()).set(node, node.getBoundingClientRect())
    }
    return found
}

function slide(before) {
    for (const [node, first] of before) {
        if (!node.isConnected || typeof node.animate !== "function") continue
        const last = node.getBoundingClientRect()
        const dx = first.left - last.left
        const dy = first.top - last.top
        if (dx === 0 && dy === 0) continue
        node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: node.__move, easing: "ease" })
    }
}


export function __list__(anchor, source, render, keyOf, withIndex = false) {
    if (serverRendering) anchor.parentNode.insertBefore(slimDocument.createComment(START), anchor)
    const scope = new Owner()
    let rows = []
    scope.cleanups = [() => { for (const row of rows) row?.owner.dispose() }]
    const options = { render, keyOf, withIndex }
    let content = cursor ? claimedContent(anchor) : null

    __render_effect__(() => {
        const items = source()
        untrack(() => {
            const update = () => reconcile(anchor, rows, items == null ? [] : Array.from(items), options)
            if (content) {
                const nodes = content
                content = null
                const list = items == null ? [] : Array.from(items)
                rows = runWithOwner(scope, () => withCursor(nodes, () =>
                    list.map((item, index) => makeRow(item, index, options, keyOf ? keyOf(item, index) : item))))
            } else {
                rows = runWithOwner(scope, update)
            }
        })
    })
}

function makeRow(item, index, { render, withIndex }, key) {
    const row = { key, item: new Signal(item), index: withIndex ? new Signal(index) : null, nodes: null, owner: new Owner(undefined, false) }
    const value = runWithOwner(row.owner, () => render(row.item, row.index))
    row.nodes = isText(value) ? [cursor ? claim(false) : slimDocument.createTextNode(String(value))] : toNodes(value, [])
    if (row.nodes.length === 0) row.nodes.push(slimDocument.createTextNode(""))
    return row
}

function reconcile(anchor, previous, items, options) {
    const { keyOf } = options
    const parent = anchor.parentNode
    const next = new Array(items.length)

    if (items.length === 0) {
        if (previous.length === 0) return next
        const first = previous[0].nodes[0]
        const leaving = previous.some(row => row.nodes.some(node => node.__leave))
        if (!leaving && parent.firstChild === first && parent.lastChild === anchor) {
            parent.textContent = ""
            parent.appendChild(anchor)
        } else {
            for (const row of previous) remove(row.nodes)
        }
        for (const row of previous) row.owner.dispose()
        return next
    }

    const byKey = new Map()
    previous.forEach((row, index) => {
        const same = byKey.get(row.key)
        if (same) same.push(index)
        else byKey.set(row.key, [index])
    })

    const oldIndex = new Int32Array(items.length).fill(-1)
    for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const key = keyOf ? keyOf(item, i) : item
        const same = byKey.get(key)
        if (same && same.length) {
            const index = same.shift()
            const row = previous[index]
            previous[index] = null
            oldIndex[i] = index
            if (!Object.is(row.item.value, item)) row.item.v = item
            else if (changedInPlace(item)) row.item.notify()
            if (row.index) row.index.v = i
            next[i] = row
        } else {
            next[i] = makeRow(item, i, options, key)
        }
    }

    for (const row of previous) {
        if (!row) continue
        remove(row.nodes)
        row.owner.dispose()
    }

    const before = positions(next)
    const stable = longestIncreasing(oldIndex)
    let ref = anchor
    let i = next.length - 1
    while (i >= 0) {
        if (stable.has(i)) {
            ref = next[i].nodes[0]
            i--
            continue
        }
        let start = i
        while (start > 0 && !stable.has(start - 1)) start--
        if (start === i) {
            for (const node of next[i].nodes) parent.insertBefore(node, ref)
        } else {
            const fragment = slimDocument.createDocumentFragment()
            for (let k = start; k <= i; k++) for (const node of next[k].nodes) fragment.appendChild(node)
            parent.insertBefore(fragment, ref)
        }
        ref = next[start].nodes[0]
        i = start - 1
    }
    if (before) slide(before)
    return next
}

function longestIncreasing(values) {
    const tails = []
    const previous = new Int32Array(values.length)
    for (let i = 0; i < values.length; i++) {
        const value = values[i]
        if (value < 0) continue
        let low = 0
        let high = tails.length
        while (low < high) {
            const mid = (low + high) >> 1
            if (values[tails[mid]] < value) low = mid + 1
            else high = mid
        }
        previous[i] = low > 0 ? tails[low - 1] : -1
        tails[low] = i
    }
    const result = new Set()
    let i = tails.length ? tails[tails.length - 1] : -1
    while (i >= 0) {
        result.add(i)
        i = previous[i]
    }
    return result
}


export function renderToString(render) {
    const scope = new Owner(null)
    serverRendering = true
    setServerRendering(true)
    try {
        const value = runWithOwner(scope, render)
        if (value instanceof SafeHtml) return value.value
        if (value == null || typeof value !== "object" || typeof value.nodeType !== "number") return String(value ?? "")
        const box = slimDocument.createElement("div")
        box.appendChild(value)
        return box.innerHTML
    } finally {
        serverRendering = false
        setServerRendering(false)
        scope.dispose()
    }
}

export async function renderToStringAsync(render, { passes = 5 } = {}) {
    const data = { results: [], pending: [], index: 0 }
    for (let pass = 1; ; pass++) {
        data.index = 0
        data.pending = []
        setServerData(data)
        let html
        try {
            html = renderToString(render)
        } finally {
            setServerData(null)
        }
        if (data.pending.length === 0 || pass === passes) {
            const sent = data.results.map(result => result && (result.error !== undefined
                ? { error: String(result.error?.message ?? result.error) }
                : { value: result.value }))
            const json = JSON.stringify(sent).replace(/</g, "\\u003c")
            return { html, data: sent, script: `<script>window.__slimData = ${json}</script>` }
        }
        await Promise.all(data.pending)
    }
}

export function hydrate(render, container, data = globalThis.__slimData) {
    const previous = cursor
    cursor = { nodes: [...container.childNodes], index: 0 }
    setHydrationData(Array.isArray(data) ? { values: data, index: 0 } : null)
    try {
        return render()
    } finally {
        cursor = previous
        setHydrationData(null)
    }
}

export const DOM_GLOBALS = {
    __child__, __next__, __template__, __insert__, __once__, __root__, __branch__, __attr__, __set__, __s__, __spread__, __on__, __list__,
    __enter__, __leave__, __move__, Portal,
    renderToString, renderToStringAsync, hydrate
}
