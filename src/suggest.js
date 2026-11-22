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
    "raw", "escapeHtml", "htmlToVdom",
    "StructError", "StructPassedError", "StructExpectError", "ArgumentDeclarationTypeError",
    "onMount", "onConnect", "onUnmount", "expose", "keepAlive", "onRemove", "listen", "render", "upgrade", "dispose", "setHtml", "effect", "watch", "untrack", "batch", "onCleanup", "touch", "resource", "provideData", "renderToString", "renderToStringAsync", "hydrate", "createContext", "provide", "inject", "catchError", "Portal",
    "window", "document", "navigator", "location", "history", "screen", "localStorage", "sessionStorage",
    "indexedDB", "alert", "confirm", "prompt", "event", "self", "top", "parent", "frames", "customElements",
    "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback", "cancelIdleCallback",
    "getComputedStyle", "matchMedia", "scrollTo", "scrollBy", "scrollX", "scrollY", "addEventListener", "removeEventListener", "dispatchEvent", "open", "close", "innerWidth", "innerHeight",
    "devicePixelRatio", "caches", "Image", "Audio", "Option", "FileReader", "DOMParser", "XMLHttpRequest",
    "CSS", "Node", "Element", "HTMLElement", "SVGElement", "ShadowRoot", "DocumentFragment",
    "MutationObserver", "IntersectionObserver", "ResizeObserver", "Worker", "SharedWorker", "Notification",
    "Range", "Selection", "getSelection", "Text", "Comment", "NodeFilter", "TreeWalker", "XMLSerializer", "DataTransfer",
    "ClipboardItem", "FontFace", "Highlight", "Path2D", "ImageData", "ImageBitmap", "createImageBitmap", "OffscreenCanvas",
    "AudioContext", "OfflineAudioContext", "AudioBuffer", "AudioWorkletNode", "MediaRecorder", "MediaStream", "MediaStreamTrack",
    "MediaStreamTrackProcessor", "MediaStreamTrackGenerator", "MediaSource", "VideoFrame", "AudioData", "VideoEncoder",
    "VideoDecoder", "AudioEncoder", "AudioDecoder", "EncodedVideoChunk", "EncodedAudioChunk",
    "process", "Buffer", "require", "module", "exports", "__dirname", "__filename", "global",
    "speechSynthesis", "visualViewport", "origin", "outerWidth", "outerHeight", "pageXOffset", "pageYOffset", "screenX", "screenY",
    "screenLeft", "screenTop", "print", "focus", "blur", "stop", "moveTo", "moveBy", "resizeTo", "resizeBy", "postMessage", "closed",
    "opener", "frameElement", "isSecureContext", "crossOriginIsolated", "clientInformation", "external", "menubar", "toolbar",
    "locationbar", "personalbar", "scrollbars", "statusbar", "scroll", "showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker",
    "cookieStore", "launchQueue", "trustedTypes", "scheduler", "webkitURL", "chrome", "browser", "Deno", "Bun",
    "EventSource", "Storage", "File", "FileList", "Clipboard", "Cache", "CacheStorage", "PushManager", "ServiceWorker",
    "PaymentRequest", "Geolocation", "WakeLock", "Gamepad", "Bluetooth", "USB", "Serial", "HID", "XPathResult", "XPathEvaluator",
    "NamedNodeMap", "NodeList", "HTMLCollection", "Attr", "CharacterData", "CDATASection", "ProcessingInstruction", "Document",
    "DocumentType", "Window", "History", "Location", "Navigator", "Screen", "Touch", "TouchList", "Animation", "AnimationEffect",
    "KeyframeEffect", "AnimationTimeline", "DocumentTimeline", "Scheduler", "TaskController", "Selection", "Headers", "Request"
])

const GLOBAL_PATTERN = /^(?:HTML|SVG|DOM|CSS|RTC|WebGL|Web|IDB)|^[A-Z][A-Za-z0-9]*(?:Event|Element|Observer|Error|Array)$/

export function isKnownGlobal(name) {
    return KNOWN_GLOBALS.has(name) || (name in globalThis && !(name in Object.prototype)) || GLOBAL_PATTERN.test(name)
}
