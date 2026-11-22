import { slimDocument, __park__, __unpark__, __release__ } from "./helpers.js"
import { serverRendering, serverData, provideData, takeData } from "./reactive/server.js"
import { Owner, Signal, __component__, __computed__, untrack, onCleanup, createContext, provide, inject, awaitOnServer, batch, effect, getOwner, runWithOwner } from "./reactive.js"
import { __attr__, __child__, __insert__, __on__, __root__, __template__, __defer_hydration__, __resume_hydration__ } from "./dom.js"

const inBrowser = typeof window !== "undefined" && typeof location !== "undefined" && typeof history !== "undefined" &&
    slimDocument === globalThis.document

const here = () => inBrowser ? location.pathname + location.search : "/"
const hereHash = () => inBrowser ? location.hash : ""
const url = new Signal(here())
const routed = new Signal(url.peek())
const hash = new Signal(hereHash())
const reloads = new Signal(0)
const routers = new Set()
const leaveGuards = new Set()
const visitHooks = new Set()

let visiting = false
let revisit = false
let visitHeld = false

function settledVisit() {
    if (!visitHeld || [...routers].some(router => router.waiting)) return
    visitHeld = false
    visited()
}

function visited() {
    if ([...routers].some(router => router.waiting)) {
        visitHeld = true
        return
    }
    if (visiting) {
        revisit = true
        return
    }
    visiting = true
    try {
        for (const hook of [...visitHooks]) {
            if (!hook.record.connected() || hook.entry && !hook.entry.visible) continue
            hook.fn(hook.match())
        }
    } finally {
        visiting = false
    }
    if (!revisit) return
    revisit = false
    queueMicrotask(visited)
}
let scrollTarget = null
let restoreTo = null
const entries = new Signal(0)

function stateKey(state) {
    try {
        return JSON.stringify(state ?? null)
    } catch {
        return ""
    }
}

let routedState = inBrowser ? history.state ?? null : null

if (inBrowser) {
    window.addEventListener("popstate", () => {
        const next = here()
        const stateChanged = stateKey(history.state) !== stateKey(routedState)
        if ((next !== url.peek() || stateChanged) && blocksLeave(next)) {
            history.pushState(routedState, "", url.peek() + hash.peek())
            return
        }
        hash.v = hereHash()
        if (next === url.peek() && !stateChanged) return
        if (!claimed(new URL(location.href))) {
            location.reload()
            return
        }
        routedState = history.state ?? null
        batch(() => {
            url.v = next
            routed.v = next
            if (stateChanged) entries.v++
        })
        visited()
    })
}

function blocksLeave(next) {
    for (const guard of [...leaveGuards]) {
        if (!guard.record.connected() || guard.entry && !guard.entry.visible) continue
        if (!guard.record.leaving(next)) continue
        if (guard.fn(next) === false) return true
    }
    return false
}

function claimed(target) {
    if (target.origin !== location.origin) return false
    const live = [...routers].filter(router => router.connected())
    return live.length === 0 || live.some(router => router.claims(target))
}

function scrollToTarget(fragment) {
    const id = fragment ? decodeSegment(fragment.slice(1)) : ""
    const el = id ? slimDocument.getElementById(id) ?? slimDocument.getElementsByName?.(id)?.[0] : null
    if (el) el.scrollIntoView?.()
    else window.scrollTo?.(0, 0)
}

function flushScroll() {
    if (scrollTarget === null && restoreTo === null || [...routers].some(router => router.waiting)) return
    const fragment = scrollTarget
    const restore = restoreTo
    scrollTarget = null
    restoreTo = null
    if (restore !== null && !fragment) window.scrollTo?.(0, restore)
    else scrollToTarget(fragment)
}

export function navigate(to, { replace = false, reload = false, silent = false, scroll = true, force = false, state } = {}) {
    if (!inBrowser) {
        const next = String(to).split("#")[0]
        batch(() => {
            url.v = next
            if (silent) return
            routed.v = next
            if (reload) reloads.v++
        })
        return
    }
    const target = new URL(String(to), location.href)
    const goingTo = target.pathname + target.search
    if (!silent && !force && goingTo !== url.peek() && blocksLeave(goingTo)) return false
    if (!silent && !claimed(target)) {
        if (replace) location.replace(target.href)
        else location.assign(target.href)
        return true
    }
    const same = target.href === location.href
    if (replace || same || silent) history.replaceState(state === undefined ? history.state : state, "", target.href)
    else history.pushState(state ?? null, "", target.href)
    const stateChanged = stateKey(history.state) !== stateKey(routedState)
    routedState = history.state ?? null
    const next = here()
    batch(() => {
        hash.v = target.hash
        url.v = next
        if (silent) return
        routed.v = next
        if (stateChanged) entries.v++
        if (reload) reloads.v++
    })
    if (!silent) visited()
    if (silent || !scroll) return true
    scrollTarget = target.hash
    queueMicrotask(flushScroll)
    return true
}

function split(full) {
    const bare = full.split("#")[0]
    const index = bare.indexOf("?")
    const path = index === -1 ? bare : bare.slice(0, index)
    const query = Object.fromEntries(new URLSearchParams(index === -1 ? "" : bare.slice(index + 1)))
    return { path, query }
}

function decodeSegment(segment) {

    try {

        return decodeURIComponent(segment)

    } catch {

        return segment

    }

}

function trimBase(base) {
    const clean = String(base ?? "/").split(/[?#]/)[0].replace(/\/+$/, "")
    return clean === "" ? "" : clean.startsWith("/") ? clean : "/" + clean
}

function within(path, base) {
    if (base === "") return path || "/"
    if (path === base) return "/"
    return path.startsWith(base + "/") ? path.slice(base.length) : null
}

export function matchRoute(pattern, path) {
    if (pattern === "*") return {}
    const want = pattern.split("/").filter(Boolean)
    const have = path.split("/").filter(Boolean)
    const params = {}
    for (let i = 0; i < want.length; i++) {
        const part = want[i]
        if (part.startsWith("*")) {
            params[part.slice(1) || "rest"] = have.slice(i).map(decodeSegment).join("/")
            return params
        }
        if (i >= have.length) return want.slice(i).every(optionalPart) ? params : null
        if (part.startsWith(":")) params[optionalPart(part) ? part.slice(1, -1) : part.slice(1)] = decodeSegment(have[i])
        else if (part !== have[i]) return null
    }
    return have.length === want.length ? params : null
}

function optionalPart(part) {
    return part.startsWith(":") && part.endsWith("?")
}

let routesInUse = null
const RouteContext = createContext(null)
const PageContext = createContext(null)
const RecordContext = createContext(null)

function consumed(pattern, subject) {
    if (pattern === "*") return ""
    const want = pattern.split("/").filter(Boolean)
    const have = subject.split("/").filter(Boolean)
    const star = want.findIndex(part => part.startsWith("*"))
    const used = star === -1 ? have : have.slice(0, star)
    return used.length ? "/" + used.join("/") : ""
}

function current(routes, full, base = "", key = null) {
    const { path, query } = split(full)
    const inner = within(path, base)
    const subject = inner === null || key && inner !== "/" ? null : key ? query[key] ?? "" : inner
    if (subject !== null) {
        for (const [pattern, view] of Object.entries(routes ?? {})) {
            const params = matchRoute(pattern, subject)
            if (params) return { pattern, view, params, query, path, url: full, subject, base: key ? base : base + consumed(pattern, subject) }
        }
    }
    return { pattern: null, view: null, params: {}, query, path, url: full, subject, base }
}

export function route() {
    const match = inject(RouteContext)
    const read = () => {
        if (match) return match()
        const [routes = null, , base = "", key] = routesInUse?.() ?? []
        return current(routes, routed.v, base, key)
    }
    return {
        get path() { return read().path },
        get query() { return read().query },
        get params() { return read().params },
        get base() { return read().base ?? "" },
        get pattern() { return read().pattern ?? null },
        get state() { return read().state ?? null },
        get data() { return read().data },
        get error() { return read().error },
        get hash() { return hash.v }
    }
}

export function onVisit(fn) {
    const match = inject(RouteContext)
    const hook = { fn, match, entry: inject(PageContext), record: inject(RecordContext) }
    if (!hook.record || !match) return
    visitHooks.add(hook)
    onCleanup(() => visitHooks.delete(hook))
}

function stateFor(next) {
    return inBrowser && next === here() ? history.state ?? null : null
}

function isRelative(href) {
    return href !== "" && !/^([a-z][a-z\d+.-]*:|\/|\?|#)/i.test(href)
}

function resolveFrom(href, base) {
    const target = new URL(href, `http://slim.invalid${base}/`)
    const dots = /(^|\/)\.\.?$/.test(href.split(/[?#]/)[0])
    const pathname = dots ? target.pathname.replace(/\/+$/, "") || "/" : target.pathname
    return pathname + target.search + target.hash
}

function run(hooks) {
    for (const fn of [...hooks]) fn()
}

function notify(entry, kind) {
    run(entry[kind])
    for (const inner of entry.routers) if (inner.active) notify(inner.active, kind)
}

export function onHide(fn) {
    const entry = inject(PageContext)
    if (!entry) return
    entry.hide.add(fn)
    onCleanup(() => entry.hide.delete(fn))
}

export function onLeave(fn) {
    const match = inject(RouteContext)
    const guard = { fn, entry: inject(PageContext), record: inject(RecordContext) }
    if (!guard.record || !match) return
    leaveGuards.add(guard)
    onCleanup(() => leaveGuards.delete(guard))
}

const heads = []
const managed = new Map()
const PROPERTY = /^(og|fb|article|book|profile|music|video|al):/

function tagsOf(values) {
    const tags = new Map()
    if (!values || typeof values !== "object") return tags
    const meta = (name, content) => {
        if (content == null || content === false) return
        const attr = PROPERTY.test(name) ? "property" : "name"
        tags.set(`meta\u0000${attr}\u0000${name}`, { tag: "meta", attr, name, value: String(content) })
    }
    if (values.title != null && values.title !== false) tags.set("title", { tag: "title", value: String(values.title) })
    meta("description", values.description)
    for (const [name, content] of Object.entries(values.meta ?? {})) meta(name, content)
    for (const [rel, href] of Object.entries(values.link ?? {})) {
        if (href != null && href !== false) tags.set(`link\u0000${rel}`, { tag: "link", attr: "rel", name: rel, value: String(href) })
    }
    return tags
}

function merge(list) {
    const out = new Map()
    for (const tags of list) for (const [key, tag] of tags) out.set(key, tag)
    return out
}

function visibleEntry(entry) {
    for (let at = entry; at; at = at.parent) if (!at.visible) return false
    return true
}

const escapeText = text => text.replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char])
const escapeAttr = text => escapeText(text).replace(/"/g, "&quot;")

function headHtml(list, fallback) {
    let html = ""
    const tags = merge(list.map(tagsOf))
    const title = tags.get("title")
    if (title) html += `<title data-slim-head="${escapeAttr(String(fallback ?? ""))}">${escapeText(title.value)}</title>`
    else if (fallback != null) html += `<title>${escapeText(String(fallback))}</title>`
    for (const tag of tags.values()) {
        if (tag.tag === "meta") html += `<meta ${tag.attr}="${escapeAttr(tag.name)}" content="${escapeAttr(tag.value)}" data-slim-head>`
        else if (tag.tag === "link") html += `<link rel="${escapeAttr(tag.name)}" href="${escapeAttr(tag.value)}" data-slim-head>`
    }
    return html
}

function findTag(doc, tag) {
    for (const el of doc.head?.querySelectorAll(tag.tag) ?? []) {
        if (el.getAttribute(tag.attr) === tag.name) return el
    }
    return null
}

function syncHead() {
    const doc = globalThis.document
    if (!doc) return
    const want = merge(heads.filter(reg => visibleEntry(reg.entry)).map(reg => reg.tags))
    for (const [key, tag] of want) {
        let slot = managed.get(key)
        if (tag.tag === "title") {
            if (!slot) {
                const el = doc.head?.querySelector("title")
                const marked = el?.getAttribute("data-slim-head")
                slot = { original: marked != null ? marked : doc.title }
                managed.set(key, slot)
            }
            if (slot.applied !== tag.value) {
                doc.title = tag.value
                slot.applied = tag.value
            }
            continue
        }
        const field = tag.tag === "link" ? "href" : "content"
        if (!slot) {
            const found = findTag(doc, tag)
            slot = found
                ? { el: found, made: found.hasAttribute("data-slim-head"), original: found.getAttribute(field) }
                : { el: null, made: true }
            if (!slot.el) {
                slot.el = doc.createElement(tag.tag)
                slot.el.setAttribute(tag.attr, tag.name)
                slot.el.setAttribute("data-slim-head", "")
                doc.head?.appendChild(slot.el)
            }
            managed.set(key, slot)
        }
        if (slot.applied !== tag.value) {
            slot.el.setAttribute(field, tag.value)
            slot.applied = tag.value
        }
    }
    for (const [key, slot] of [...managed]) {
        if (want.has(key)) continue
        managed.delete(key)
        if (key === "title") doc.title = slot.original ?? ""
        else if (slot.made) slot.el.remove()
        else if (slot.original == null) slot.el.removeAttribute(key.startsWith("link") ? "href" : "content")
        else slot.el.setAttribute(key.startsWith("link") ? "href" : "content", slot.original)
    }
}

export function head(value) {
    const read = typeof value === "function" ? value : () => value
    if (serverRendering) {
        if (serverData?.head) {
            serverData.head.push(untrack(read))
            serverData.headHtml = headHtml
        }
        return
    }
    if (!inBrowser || !globalThis.document) return
    const reg = { tags: new Map(), entry: inject(PageContext) }
    heads.push(reg)
    effect(() => {
        reg.tags = tagsOf(read())
        syncHead()
    })
    onCleanup(() => {
        const at = heads.indexOf(reg)
        if (at !== -1) heads.splice(at, 1)
        syncHead()
    })
}

export function title(value) {
    const read = typeof value === "function" ? value : () => value
    head(() => ({ title: read() }))
}

const busy = new Signal(false)

function syncBusy() {
    const now = [...routers].some(router => router.waiting)
    if (busy.peek() !== now) busy.v = now
}

export function navigating() {
    return busy.v
}

export function forget(path) {
    for (const router of [...routers]) router.forget(String(path))
}

export function onShow(fn) {
    const entry = inject(PageContext)
    if (!entry) return
    entry.show.add(fn)
    onCleanup(() => entry.show.delete(fn))
}

const loaded = new WeakMap()

const configOf = view => view && typeof view === "object" && typeof view.nodeType !== "number" ? view : null

class Failed {
    constructor(error) {
        this.error = error
    }
}

function pageOf(view, attempt) {
    const config = configOf(view)
    if (config) view = config.page
    if (typeof view !== "function" || view.__component__) return view
    let entry = loaded.get(view)
    if (entry && entry.peek() instanceof Failed && entry.attempt !== attempt) {
        loaded.delete(view)
        entry = null
    }
    if (!entry) {
        const made = entry = new Signal(null)
        made.attempt = attempt
        loaded.set(view, made)
        made.ready = Promise.resolve().then(view).then(module => {
            const page = typeof module === "function" ? module : module?.default ?? Object.values(module ?? {}).find(item => typeof item === "function")
            made.v = typeof page === "function" ? page : new Failed(new Error("the module of a route has no component"))
        }, error => {
            console.error(error)
            made.v = new Failed(error)
        })
    }
    if (entry.peek() === null) awaitOnServer(entry.ready)
    return entry.v
}

const pageIds = new WeakMap()
let nextPageId = 1

function idOf(page) {
    if (!page || typeof page !== "function" && typeof page !== "object") return String(page)
    if (!pageIds.has(page)) pageIds.set(page, nextPageId++)
    return pageIds.get(page)
}

function nodesOf(out) {
    if (!out || typeof out !== "object") return []
    if (out.__slimNodes) return out.__slimNodes
    if (out.nodeType === 11) return [...out.childNodes]
    return out.nodeType ? [out] : []
}

let listening = false

function listen() {
    if (listening || !inBrowser) return
    listening = true
    window.addEventListener("click", event => {
        if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        const a = event.target?.closest?.("a[href]")
        if (!a || a.hasAttribute("download") || /(^|\s)external(\s|$)/i.test(a.getAttribute("rel") ?? "")) return
        const frame = a.getAttribute("target")
        if (frame && frame !== "_self") return
        if (![...routers].some(router => router.intercepts(a))) return
        const target = new URL(a.getAttribute("href"), location.href)
        if (target.origin !== location.origin) return
        if (target.hash && target.pathname === location.pathname && target.search === location.search) return
        if (!claimed(target)) return
        event.preventDefault()
        navigate(target.href)
    })
}

export function Router(props = {}) {
    return __component__(() => {
        const parent = inject(RouteContext)
        const holder = inject(PageContext)
        const home = getOwner()
        const startPath = split(here()).path
        const scope = () => trimBase(props.base ?? (props.query ? startPath : parent ? parent().base : "/"))
        const serverSide = () => serverRendering || !inBrowser
        const requested = () => serverSide() && serverData?.url != null ? String(serverData.url).split("#")[0] : undefined
        const fixedUrl = () => serverSide() && (props.url !== undefined || requested() !== undefined)
        const source = () => serverSide() && props.url !== undefined ? props.url : parent ? parent().url : requested() ?? routed.v
        routesInUse = () => [props.routes, source(), scope(), props.query]
        const target = __computed__(() => {
            reloads.v
            entries.v
            const next = current(props.routes, source(), scope(), props.query)
            if (parent && next.view) next.params = { ...parent().params, ...next.params }
            next.state = fixedUrl() ? null : stateFor(source())
            if (next.view && props.guard) {
                const verdict = untrack(() => props.guard(next))
                if (verdict === false || typeof verdict === "string") {
                    next.blocked = true
                    if (typeof verdict === "string") queueMicrotask(() => navigate(verdict, { replace: true, force: true }))
                }
            }
            return next
        })
        const record = {
            waiting: false,
            nodes: [],
            edge: null,
            active: null,
            connected: () => !!(record.edge?.isConnected || record.nodes.some(node => node.isConnected)),
            claims: link => current(props.routes, link.pathname + link.search, scope(), props.query).view != null,
            intercepts: a => !!props.intercept && !(props.ignore && a.closest?.(props.ignore)) && record.nodes.some(node => node === a || node.contains?.(a))
        }
        if (holder) {
            holder.routers.add(record)
            onCleanup(() => holder.routers.delete(record))
        }
        let last = null
        const loads = new Map()
        const settled = new Signal(0)
        let wanted = null
        const loadKeyOf = next => {
            const star = (next.pattern ?? "").split("/").find(part => part.startsWith("*"))
            const params = { ...next.params }
            if (star) delete params[star.slice(1) || "rest"]
            return "route\u0000" + JSON.stringify([scope(), props.query ?? null, next.pattern, params, next.query])
        }
        const argsOf = (next, signal) => ({ params: next.params, query: next.query, path: next.path, state: next.state ?? null, signal })
        const begin = (key, next, load) => {
            const controller = typeof AbortController === "function" ? new AbortController() : null
            const state = { key, done: false, controller, tick: reloads.peek() }
            loads.set(key, state)
            let pending
            try {
                pending = Promise.resolve(untrack(() => load(argsOf(next, controller?.signal))))
            } catch (failure) {
                pending = Promise.reject(failure)
            }
            pending.then(data => {
                state.data = data
            }, error => {
                state.error = error
            }).then(() => {
                state.done = true
                if (loads.get(key) === state) settled.v++
            })
            return state
        }
        const onServer = (key, next, load) => {
            const data = serverData
            const known = data?.results.get(key)
            if (known) {
                provideData(key, () => known.error !== undefined ? { error: String(known.error?.message ?? known.error) } : { value: known.value })
                return { key, done: true, data: known.value, error: known.error }
            }
            if (data) {
                let pending
                try {
                    pending = Promise.resolve(untrack(() => load(argsOf(next, undefined))))
                } catch (failure) {
                    pending = Promise.reject(failure)
                }
                data.pending.push(pending.then(value => { data.results.set(key, { value }) }, error => { data.results.set(key, { error }) }))
            }
            return { key, done: false }
        }
        const fromServer = key => {
            const sent = takeData(key)
            if (!sent) return null
            const got = sent.value ?? {}
            const state = { key, done: true, tick: reloads.peek(), data: got.value, error: got.error !== undefined ? new Error(got.error) : undefined }
            loads.set(key, state)
            return state
        }
        const release = key => {
            const state = loads.get(key)
            if (!state) return
            loads.delete(key)
            if (!state.done) state.controller?.abort()
        }
        const loadFor = next => {
            const load = configOf(next.view)?.load
            const key = typeof load === "function" ? loadKeyOf(next) : null
            if (wanted !== null && wanted !== key) {
                const parked = last?.loadKey === wanted && keeps(last) && (!key || slotOf(last) !== slotOf(next))
                if (!parked) release(wanted)
            }
            wanted = key
            if (!key) return null
            if (serverRendering) return onServer(key, next, load)
            let state = loads.get(key)
            if (state && state.tick !== reloads.peek()) {
                if (last?.loadKey === key) {
                    release(key)
                    state = null
                } else state.tick = reloads.peek()
            }
            return state ?? fromServer(key) ?? begin(key, next, load)
        }
        const shown = __computed__(() => {
            const next = target.v
            settled.v
            if (next.blocked) return last ?? { ...next, view: null, page: null, tick: reloads.peek() }
            const found = next.view ? pageOf(next.view, next) : null
            const failed = found instanceof Failed ? found : null
            const page = failed ? null : found
            const loading = loadFor(next)
            const pending = loading && !loading.done
            if (next.view && ((!page && !failed) || pending)) {
                if (!record.waiting) queueMicrotask(syncBusy)
                record.waiting = true
                if (last?.page) return last
            } else if (record.waiting) {
                record.waiting = false
                queueMicrotask(flushScroll)
                queueMicrotask(syncBusy)
                queueMicrotask(settledVisit)
            }
            last = {
                ...next,
                page: pending ? null : page,
                tick: reloads.peek(),
                loadKey: loading?.key ?? null,
                data: loading?.data,
                error: failed ? failed.error : loading?.error
            }
            return last
        })
        const keeps = which => {
            const keep = props.keep
            if (!keep || !which.page) return false
            return keep === true || keep === which.pattern || Array.isArray(keep) && keep.includes(which.pattern)
        }
        const slotOf = which => `${which.pattern}\u0000${props.keepBy ? untrack(() => props.keepBy(which)) : consumed(which.pattern, which.subject ?? "")}`
        const pageOf_ = which => `${which.pattern}\u0000${idOf(which.view)}${keeps(which) ? "\u0000" + slotOf(which) : ""}`
        const generations = new Map()
        let seenTick = reloads.peek()
        const key = __computed__(() => {
            const which = shown.v
            const reloaded = which.tick !== seenTick
            seenTick = which.tick
            if (!keeps(which)) return `${which.pattern}\u0000${idOf(which.page)}\u0000${which.tick}`
            const slot = slotOf(which)
            if (reloaded) generations.set(slot, (generations.get(slot) ?? 0) + 1)
            return `${which.pattern}\u0000${idOf(which.page)}\u0000${slot}\u0000${generations.get(slot) ?? 0}`
        })
        provide(RouteContext, () => shown.v)
        provide(RecordContext, record)
        record.leaving = next => {
            const which = current(props.routes, next, scope(), props.query)
            const now = shown.peek()
            if (!now.view) return false
            const goes = { ...which, page: which.view ? which.view : null }
            return !which.view || pageOf_(goes) !== pageOf_(now)
        }
        record.forget = next => {
            const which = current(props.routes, next, scope(), props.query)
            if (!which.view) return
            const slot = slotOf(which)
            for (const entry of [...cache.values()]) if (entry.slot === slot && entry !== record.active) drop(entry)
        }
        if (!fixedUrl()) {
            routers.add(record)
            onCleanup(() => routers.delete(record))
            if (props.intercept) listen()
        }
        const cache = new Map()
        const pageProps = read => ({
            get params() { return read().params },
            get query() { return read().query },
            get path() { return read().path },
            get data() { return read().data },
            get error() { return read().error },
            get hash() { return hash.v }
        })
        const hideEntry = entry => {
            entry.visible = false
            if (inBrowser) {
                entry.scroll = window.scrollY ?? window.pageYOffset ?? 0
                entry.scrolled = []
                for (const node of entry.nodes) {
                    if (node.nodeType !== 1) continue
                    for (const el of [node, ...node.querySelectorAll("*")]) {
                        if (el.scrollTop || el.scrollLeft) entry.scrolled.push([el, el.scrollTop, el.scrollLeft])
                    }
                }
            }
            __park__(entry.nodes)
            notify(entry, "hide")
            if (heads.length) syncHead()
        }
        const showEntry = entry => {
            entry.visible = true
            __unpark__(entry.nodes)
            cache.delete(entry.key)
            cache.set(entry.key, entry)
            if (heads.length) syncHead()
            if (inBrowser) {
                restoreTo = entry.scroll
                queueMicrotask(() => {
                    for (const [el, top, left] of entry.scrolled ?? []) {
                        el.scrollTop = top
                        el.scrollLeft = left
                    }
                    flushScroll()
                    notify(entry, "show")
                })
            }
        }
        const drop = entry => {
            const dropped = entry.match.peek().loadKey
            if (dropped && dropped !== wanted) release(dropped)
            cache.delete(entry.key)
            if (record.active === entry) record.active = null
            __release__(entry.nodes)
            entry.owner.dispose()
        }
        const createEntry = (id, which, page) => {
            for (const other of [...cache.values()]) if (other.slot === slotOf(which)) drop(other)
            const entry = {
                key: id,
                slot: slotOf(which),
                match: new Signal(which),
                owner: new Owner(home, false),
                nodes: [],
                scroll: 0,
                hide: new Set(),
                show: new Set(),
                routers: new Set(),
                parent: holder,
                visible: true
            }
            entry.view = runWithOwner(entry.owner, () => {
                provide(RouteContext, () => entry.match.v)
                provide(PageContext, entry)
                return page(pageProps(() => entry.match.v))
            })
            entry.nodes = nodesOf(entry.view)
            cache.set(id, entry)
            return entry
        }
        const trim = () => {
            const limit = props.max ?? 10
            const hidden = [...cache.values()].filter(entry => entry !== record.active)
            while (hidden.length > limit) drop(hidden.shift())
        }
        effect(() => {
            const which = shown.v
            const entry = record.active
            if (entry && key.v === entry.key) entry.match.v = which
        })
        onCleanup(() => {
            for (const entry of [...cache.values()]) drop(entry)
        })
        let held = null
        const out = __root__(() => {
            const id = key.v
            const which = shown.peek()
            const page = which.page
            const leaving = record.active
            if (leaving && leaving.key !== id) {
                record.active = null
                hideEntry(leaving)
            }
            if (!page) {
                record.nodes = []
                const waiting = __defer_hydration__()
                if (waiting) {
                    held = waiting
                    return waiting
                }
                return props.fallback ?? null
            }
            if (keeps(which)) {
                const known = cache.get(id)
                if (known) {
                    record.active = known
                    record.nodes = known.nodes
                    showEntry(known)
                    trim()
                    return known.view
                }
            }
            const show = () => {
                if (keeps(which)) {
                    const entry = createEntry(id, which, page)
                    record.active = entry
                    record.nodes = entry.nodes
                    trim()
                    return entry.view
                }
                const view = untrack(() => page(pageProps(() => shown.v)))
                record.nodes = nodesOf(view)
                return view
            }
            if (held) {
                const nodes = held
                held = null
                return __resume_hydration__(nodes, show)
            }
            return show()
        })
        record.edge = out?.__slimRange?.[1] ?? (out?.nodeType === 11 ? out.lastChild : out)
        return out
    })
}
Router.__component__ = true

const linkUrl = () => serverRendering && serverData?.url != null ? String(serverData.url).split("#")[0] : url.v

function resolveHref(href) {
    const text = String(href ?? "")
    if (inBrowser) {
        const target = new URL(text, location.href)
        return { path: target.pathname, query: Object.fromEntries(target.searchParams) }
    }
    if (text.startsWith("?")) return split(split(linkUrl()).path + text)
    return split(text)
}

function isActive(props, href) {
    const { path, query } = split(linkUrl())
    if (props.match) return [props.match].flat().some(pattern => matchRoute(pattern, path) !== null)
    const want = resolveHref(href)
    const sameQuery = Object.entries(want.query).every(([name, value]) => query[name] === value)
    if (path === want.path) return sameQuery
    if (!props.prefix) return false
    const stem = want.path.endsWith("/") ? want.path : want.path + "/"
    return path.startsWith(stem) && sameQuery
}

const linkTemplate = __template__([["a", 0, ""]])

export function Link(props = {}) {
    return __component__(() => {
        const a = linkTemplate()
        const anchor = __child__(a, 0)
        const match = inject(RouteContext)
        const target = () => {
            const href = props.href
            if (href == null || !match) return href
            const text = String(href)
            return isRelative(text) ? resolveFrom(text, match().base ?? "") : href
        }
        __attr__(a, "href", target)
        __attr__(a, "class", () => {
            const active = props.active && isActive(props, target())
            return [props.class, active ? props.active : null].filter(Boolean).join(" ") || null
        })
        __on__(a, "click", event => {
            if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
            if (props.target && props.target !== "_self") return
            const href = target()
            if (!href || /^[a-z]+:/i.test(href) || href.startsWith("//") || href.startsWith("#")) return
            if (inBrowser && !claimed(new URL(href, location.href))) return
            event.preventDefault()
            navigate(href, { replace: !!props.replace })
        })
        __insert__(anchor, () => props.children)
        return a
    }, props)
}
Link.__component__ = true
