import { slimDocument } from "./helpers.js"
import { Signal, __component__, __computed__, untrack, onCleanup } from "./reactive.js"
import { __attr__, __insert__, __on__, __root__ } from "./dom.js"

const inBrowser = typeof window !== "undefined" && typeof location !== "undefined" && typeof history !== "undefined" &&
    slimDocument === globalThis.document

const here = () => inBrowser ? location.pathname + location.search : "/"
const url = new Signal(here())
if (inBrowser) window.addEventListener("popstate", () => { url.v = here() })

export function navigate(to, { replace = false } = {}) {
    if (inBrowser) history[replace ? "replaceState" : "pushState"](null, "", to)
    url.v = inBrowser ? here() : to
}

function split(full) {
    const index = full.indexOf("?")
    const path = index === -1 ? full : full.slice(0, index)
    const query = Object.fromEntries(new URLSearchParams(index === -1 ? "" : full.slice(index + 1)))
    return { path, query }
}

export function matchRoute(pattern, path) {
    if (pattern === "*") return {}
    const want = pattern.split("/").filter(Boolean)
    const have = path.split("/").filter(Boolean)
    const params = {}
    for (let i = 0; i < want.length; i++) {
        const part = want[i]
        if (part.startsWith("*")) {
            params[part.slice(1) || "rest"] = have.slice(i).map(decodeURIComponent).join("/")
            return params
        }
        if (i >= have.length) return null
        if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(have[i])
        else if (part !== have[i]) return null
    }
    return have.length === want.length ? params : null
}

let routesInUse = null

function current(routes, full) {
    const { path, query } = split(full)
    for (const [pattern, view] of Object.entries(routes ?? {})) {
        const params = matchRoute(pattern, path)
        if (params) return { pattern, view, params, query, path }
    }
    return { pattern: null, view: null, params: {}, query, path }
}

export function route() {
    const { params, query, path } = current(routesInUse?.(), url.v)
    return { path, query, params }
}

const loaded = new WeakMap()

function pageOf(view) {
    if (typeof view !== "function" || view.__component__) return view
    let entry = loaded.get(view)
    if (!entry) {
        entry = new Signal(null)
        loaded.set(view, entry)
        Promise.resolve(view()).then(module => {
            entry.v = typeof module === "function" ? module : module?.default ?? Object.values(module ?? {}).find(item => typeof item === "function")
        })
    }
    return entry.v
}

export function Router(props = {}) {
    return __component__(() => {
        routesInUse = () => props.routes
        const match = __computed__(() => current(props.routes, props.url ?? url.v))
        const pattern = __computed__(() => match.v.pattern)
        return __root__(() => {
            const which = pattern.v
            const view = match.peek().view
            const page = view && pageOf(view)
            if (!page) return props.fallback ?? null
            return untrack(() => page({
                get params() { return match.v.params },
                get query() { return match.v.query },
                get path() { return match.v.path }
            }))
        })
    })
}
Router.__component__ = true

export function Link(props = {}) {
    return __component__(() => {
        const a = slimDocument.createElement("a")
        __attr__(a, "href", () => props.href)
        __attr__(a, "class", () => {
            const active = props.active && split(url.v).path === split(props.href ?? "").path
            return [props.class, active ? props.active : null].filter(Boolean).join(" ") || null
        })
        __on__(a, "click", event => {
            if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
            if (props.target && props.target !== "_self") return
            const href = props.href
            if (!href || /^[a-z]+:/i.test(href) || href.startsWith("//")) return
            event.preventDefault()
            navigate(href, { replace: !!props.replace })
        })
        const anchor = slimDocument.createTextNode("")
        a.appendChild(anchor)
        __insert__(anchor, () => props.children)
        return a
    })
}
Link.__component__ = true

export const ROUTER_GLOBALS = { Router, Link, navigate, route, matchRoute }
