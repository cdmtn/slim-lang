import { closest, didYouMean } from "../suggest.js"
import { knownGlobal } from "./globals.js"
import { parseMarkup, holeMark } from "../syntax/markup.js"
import { literal, unionOf } from "../external/typeSyntax.js"
import { STRING, UNDEFINED, accepts, atoms, describe, isNamed, structFor } from "./core.js"
import { infer, signatureFor } from "./infer.js"

const DOM_EVENTS = new Set([
    "click", "dblclick", "mousedown", "mouseup", "mousemove", "mouseenter", "mouseleave", "mouseover", "mouseout",
    "contextmenu", "wheel", "keydown", "keyup", "keypress", "input", "change", "submit", "reset", "focus", "blur",
    "focusin", "focusout", "pointerdown", "pointerup", "pointermove", "pointerenter", "pointerleave", "pointercancel",
    "pointerover", "pointerout", "touchstart", "touchend", "touchmove", "touchcancel", "drag", "dragstart", "dragend",
    "dragenter", "dragleave", "dragover", "drop", "scroll", "scrollend", "resize", "load", "error", "abort", "select",
    "copy", "cut", "paste", "animationstart", "animationend", "animationiteration", "transitionstart",
    "transitionend", "transitionrun", "transitioncancel", "play", "pause", "ended", "timeupdate", "volumechange",
    "loadeddata", "loadedmetadata", "canplay", "canplaythrough", "seeking", "seeked", "waiting", "playing",
    "progress", "stalled", "suspend", "emptied", "ratechange", "durationchange", "invalid", "toggle", "beforeinput",
    "compositionstart", "compositionend", "compositionupdate", "gotpointercapture", "lostpointercapture",
    "selectionchange", "slotchange", "close", "cancel", "beforetoggle"
])

const HTML_ATTRIBUTES = new Set([
    "accept", "accept-charset", "accesskey", "action", "align", "allow", "alt", "async", "autocapitalize",
    "autocomplete", "autofocus", "autoplay", "background", "capture", "charset", "checked", "cite", "class", "color",
    "cols", "colspan", "content", "contenteditable", "controls", "coords", "crossorigin", "data", "datetime",
    "decoding", "default", "defer", "dir", "dirname", "disabled", "download", "draggable", "enctype",
    "enterkeyhint", "for", "form", "formaction", "formenctype", "formmethod", "formnovalidate", "formtarget",
    "headers", "height", "hidden", "high", "href", "hreflang", "http-equiv", "id", "inert", "inputmode",
    "integrity", "is", "ismap", "itemprop", "kind", "label", "lang", "list", "loading", "loop", "low", "max",
    "maxlength", "media", "method", "min", "minlength", "multiple", "muted", "name", "nonce", "novalidate", "open",
    "optimum", "pattern", "ping", "placeholder", "playsinline", "popover", "popovertarget", "poster", "preload",
    "readonly", "referrerpolicy", "rel", "required", "reversed", "role", "rows", "rowspan", "sandbox", "scope",
    "selected", "shape", "size", "sizes", "slot", "span", "spellcheck", "src", "srcdoc", "srclang", "srcset",
    "start", "step", "style", "tabindex", "target", "title", "translate", "type", "usemap", "value", "width", "wrap",
    "xmlns", "key", "enter", "leave", "move", "ref"
])

function markupOffsets(node, code) {
    const quasis = node._slimQuasis
    const expressions = node.quasi.expressions
    if (typeof node.start !== "number" || !code) return null
    const segments = []
    let joined = 0
    for (let i = 0; i < quasis.length; i++) {
        let start = node.start
        if (i > 0) {
            const end = expressions[i - 1]?.end
            if (typeof end !== "number") return null
            start = code.indexOf("}", end) + 1
        }
        segments.push([joined, start])
        joined += quasis[i].length + (i < quasis.length - 1 ? holeMark(i).length : 0)
    }
    return offset => {
        let found = segments[0]
        for (const segment of segments) if (segment[0] <= offset) found = segment
        return found[1] + offset - found[0]
    }
}

const camel = name => name[0].toUpperCase() + name.slice(1)

function attributeType(attr, holes, path_, env) {
    if (attr.value === true) return literal(true)
    if (typeof attr.value === "string") return literal(attr.value)
    if (attr.parts?.length === 1 && typeof attr.parts[0] !== "string" && !attr.quoted) return infer(holes[attr.parts[0].hole], path_, env)
    if (attr.parts) return STRING
    return null
}

const isFunctionType = (type, env) => atoms(type, env).every(atom => atom.kind === "function" || isNamed(atom, "function"))
const notFunctionType = (type, env) => atoms(type, env).every(atom => atom.kind === "literal" || atom.kind === "array" || atom.kind === "tuple" ||
    (atom.kind === "named" && ["int", "float", "number", "string", "bool", "null", "undefined"].includes(atom.name)))

function checkComponentTag(element, at, path_, env, report, holes = []) {
    const name = element.tag.split(".").pop()
    if (element.tag.includes(".")) return
    const signature = signatureFor(name, path_, env)
    const definition = signature?.parameters[0]?.type && structFor(signature.parameters[0].type, env)
    if (!definition?.component && !definition) return
    const shown = definition.component ?? definition.label
    const given = new Set()
    for (const attr of element.attrs) {
        if (attr.spread !== undefined) return
        if (attr.at === undefined || attr.name === "key") continue
        given.add(attr.name)
        if (!definition.fields.has(attr.name)) {
            report({ start: at(attr.at) }, `"${shown}" has no prop "${attr.name}"${didYouMean(attr.name, definition.fields.keys())}`)
            continue
        }
        const field = definition.fields.get(attr.name)
        const type = attr.event !== undefined ? infer(holes[attr.hole], path_, env) : attributeType(attr, holes, path_, env)
        const expected = field.optional ? unionOf([field.type, UNDEFINED]) : field.type
        if (type && field.type && !accepts(expected, type, env)) {
            const quoted = typeof attr.value === "string" && !accepts(expected, STRING, env) ? ` — a quoted value is a string, pass ${attr.name}=\${...} instead` : ""
            report({ start: at(attr.at) }, `prop "${attr.name}" of "${shown}" expects ${describe(expected)}, got ${describe(type)}${quoted}`)
        }
    }
    if (element.children.some(child => !(child.type === "text" && child.value.trim() === ""))) given.add("children")
    for (const [field, info] of definition.fields) {
        if (info.optional || given.has(field) || definition.defaults.has(field)) continue
        report({ start: at(element.at ?? 0) }, `"${shown}" is missing prop "${field}" of type ${describe(info.type)}`)
    }
}

const REACT_ATTRIBUTES = new Map([["className", "class"], ["htmlFor", "for"]])

function checkAttributeNames(element, at, report) {
    const seen = new Set()
    for (const attr of element.attrs) {
        if (attr.at === undefined || attr.spread !== undefined || !attr.name) continue
        const key = attr.name.toLowerCase()
        if (seen.has(key)) report({ start: at(attr.at) }, `"${attr.name}" is set twice on <${element.tag}> — only the last one counts`)
        seen.add(key)
        if (!/^[A-Z]/.test(element.tag) && REACT_ATTRIBUTES.has(attr.name)) {
            report({ start: at(attr.at) }, `"${attr.name}" is not an HTML attribute — write ${REACT_ATTRIBUTES.get(attr.name)}`)
        }
    }
}

function scopeNames(path_) {
    const names = []
    for (let scope = path_.scope; scope; scope = scope.parent) names.push(...Object.keys(scope.bindings))
    return names
}

function checkTagDefined(element, at, path_, env, report) {
    const base = element.tag.split(".")[0]
    if (env.openGlobals || path_.scope.getBinding(base) || env.importedLocals.has(base) || env.structs.has(base) || env.enums.has(base) || knownGlobal(base, env)) return
    report({ start: at(element.at ?? 0) }, `<${element.tag}> is not defined${didYouMean(base, scopeNames(path_).filter(name => /^[A-Z]/.test(name))) || ` — declare the component or bring it in with "use"`}`)
}

export function checkMarkup(node, path_, env, report) {
    const at = markupOffsets(node, env.code)
    if (!at) return
    let tree
    try {
        tree = parseMarkup(node._slimQuasis, message => { throw new Error(message) })
    } catch {
        return
    }

    const holes = node.quasi?.expressions ?? []
    const visit = (element, svg) => {
        if (element.type !== "element") return
        checkAttributeNames(element, at, report)
        if (/^[A-Z]/.test(element.tag)) {
            checkTagDefined(element, at, path_, env, report)
            checkComponentTag(element, at, path_, env, report, holes)
            for (const child of element.children) visit(child, svg)
            return
        }
        const inSvg = svg || element.tag === "svg"
        const custom = element.tag.includes("-")
        for (const attr of element.attrs) {
            if (attr.at === undefined) continue
            if (attr.event !== undefined) {
                const handler = infer(holes[attr.hole], path_, env)
                if (handler && notFunctionType(handler, env)) {
                    report({ start: at(attr.at) }, `"${attr.name}" needs a function, got ${describe(handler)}`)
                    continue
                }
                if (DOM_EVENTS.has(attr.event)) continue
                const match = closest(attr.event, DOM_EVENTS)
                if (match) report({ start: at(attr.at) }, `unknown event "${attr.name}" — did you mean "on${camel(match)}"?`)
                continue
            }
            const name = attr.name.toLowerCase()
            if (/^on[a-z]/.test(attr.name) && attr.parts?.length === 1 && typeof attr.parts[0] !== "string") {
                const handler = infer(holes[attr.parts[0].hole], path_, env)
                if (handler && isFunctionType(handler, env)) {
                    report({ start: at(attr.at) }, `"${attr.name}" sets an HTML attribute, so the function is turned into text — write on${camel(attr.name.slice(2))}=\${...}`)
                    continue
                }
            }
            if (inSvg || custom || HTML_ATTRIBUTES.has(name) || /[-:]/.test(name) || name.startsWith("on")) continue
            const match = closest(name, HTML_ATTRIBUTES)
            if (match) report({ start: at(attr.at) }, `unknown attribute "${attr.name}" on <${element.tag}> — did you mean "${match}"?`)
        }
        for (const child of element.children) visit(child, inSvg && element.tag !== "foreignObject")
    }
    for (const root of tree) visit(root, false)
}
