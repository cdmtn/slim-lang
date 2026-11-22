import { slimDocument } from "../helpers.js"
import { Owner, Signal, __render_effect__, runWithOwner, untrack, changedInPlace, onTouch } from "../reactive.js"
import { START, claim, claimedContent, cursor, isText, place, rangeOf, remove, serverRendering, toNodes, withCursor } from "../dom.js"

export function __move__(el, duration) {
    if (!serverRendering) el.__move = Number(duration) || 200
}

function positions(rows) {
    let found = null
    for (const row of rows) {
        const head = row?.nodes[0]
        const node = head?.__slimEnd ? rangeOf(head).find(item => item.nodeType === 1) : head
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

export function __list__(anchor, source, render, keyOf, withIndex = false, keep = false) {
    if (serverRendering) anchor.parentNode.insertBefore(slimDocument.createComment(START), anchor)
    const scope = new Owner()
    let rows = []
    const kept = keep && !serverRendering ? new Map() : null
    const limit = typeof keep === "number" && keep >= 0 ? keep : Infinity
    const touched = object => {
        for (const row of rows) if (row && row.item.value === object) row.item.notify()
    }
    const forget = serverRendering ? null : onTouch(touched)
    if (forget) anchor.__slimTouch = touched
    scope.cleanups = [() => {
        forget?.()
        for (const row of rows) row?.owner.dispose()
        if (kept) for (const row of kept.values()) row.owner.dispose()
        kept?.clear()
    }]
    const options = { render, keyOf, withIndex, kept, limit }
    let content = cursor ? claimedContent(anchor) : null

    scope.driver = __render_effect__(() => {
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
        for (const row of previous) leave(row, options)
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
            next[i] = revive(item, i, options, key) ?? makeRow(item, i, options, key)
        }
    }

    for (const row of previous) {
        if (!row) continue
        remove(row.nodes)
        leave(row, options)
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
            for (const node of next[i].nodes) place(parent, node, ref)
        } else {
            const fragment = slimDocument.createDocumentFragment()
            for (let k = start; k <= i; k++) for (const node of next[k].nodes) place(fragment, node, null)
            parent.insertBefore(fragment, ref)
        }
        ref = next[start].nodes[0]
        i = start - 1
    }
    if (before) slide(before)
    return next
}

function leave(row, { kept, limit }) {
    if (!kept || limit === 0) {
        row.owner.dispose()
        return
    }
    kept.get(row.key)?.owner.dispose()
    kept.delete(row.key)
    kept.set(row.key, row)
    if (kept.size > limit) {
        const [key, oldest] = kept.entries().next().value
        kept.delete(key)
        oldest.owner.dispose()
    }
}

function revive(item, index, { kept }, key) {
    const row = kept?.get(key)
    if (!row) return null
    kept.delete(key)
    if (Object.is(row.item.value, item)) row.item.notify()
    else row.item.v = item
    if (row.index) row.index.v = index
    return row
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
