function distance(a, b) {
    const rows = a.length + 1
    const cols = b.length + 1
    const d = Array.from({ length: rows }, (_, i) => [i, ...Array(cols - 1).fill(0)])
    for (let j = 1; j < cols; j++) d[0][j] = j

    for (let i = 1; i < rows; i++) {
        for (let j = 1; j < cols; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
            }
        }
    }
    return d[a.length][b.length]
}

export function closest(name, candidates) {
    const limit = name.length <= 2 ? 0 : name.length <= 5 ? 1 : 2
    const lower = name.toLowerCase()
    let best = null
    let bestDistance = Infinity

    for (const candidate of candidates) {
        if (candidate === name || Math.abs(candidate.length - name.length) > limit + 1) continue
        const score = candidate.toLowerCase() === lower ? 0.5 : distance(lower, candidate.toLowerCase())
        if (score <= Math.max(limit, 0.5) && score < bestDistance) {
            best = candidate
            bestDistance = score
        }
    }
    return best
}

export function didYouMean(name, candidates) {
    const match = closest(name, candidates)
    return match ? ` — did you mean "${match}"?` : ""
}

export const KNOWN_GLOBALS = new Set([
    "log", "warn", "error", "info", "debug", "type", "Component", "Type", "Struct", "onError",
    "test", "describe", "assert", "assertEqual", "PI", "raw", "escapeHtml", "htmlToVdom",
    "StructError", "StructPassedError", "StructExpectError", "ArgumentDeclarationTypeError",
    "onMount", "onConnect", "onUnmount", "effect", "watch", "untrack", "batch", "onCleanup", "resource", "renderToString", "renderToStringAsync", "hydrate", "createContext", "provide", "inject", "catchError", "createForm", "Router", "Link", "Portal", "navigate", "route", "matchRoute",
    "window", "document", "navigator", "location", "history", "screen", "localStorage", "sessionStorage",
    "indexedDB", "alert", "confirm", "prompt", "event", "self", "top", "parent", "frames", "customElements",
    "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback", "cancelIdleCallback",
    "getComputedStyle", "matchMedia", "scrollTo", "scrollBy", "open", "close", "innerWidth", "innerHeight",
    "devicePixelRatio", "caches", "Image", "Audio", "Option", "FileReader", "DOMParser", "XMLHttpRequest",
    "CSS", "Node", "Element", "HTMLElement", "SVGElement", "ShadowRoot", "DocumentFragment",
    "MutationObserver", "IntersectionObserver", "ResizeObserver", "Worker", "SharedWorker", "Notification",
    "process", "Buffer", "require", "module", "exports", "__dirname", "__filename", "global"
])

const GLOBAL_PATTERN = /^(?:HTML|SVG|DOM|CSS|RTC|WebGL|Web|IDB)|(?:Event|Element|Observer|Error|Array)$/

export function isKnownGlobal(name) {
    return KNOWN_GLOBALS.has(name) || name in globalThis || GLOBAL_PATTERN.test(name)
}
