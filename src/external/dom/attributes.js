import { SafeHtml, parseAttributeList, spellsBoolean } from "../helpers.js"
import { __render_effect__ } from "../reactive.js"
import { __on__ } from "./events.js"
import { serverRendering, cursor } from "../dom.js"

const PROPERTIES = new Set(["value", "checked", "selected", "muted", "indeterminate", "disabled"])

const FORM_CONTROLS = new Set(["INPUT", "TEXTAREA", "SELECT"])
const ownClasses = new WeakMap()

function isCustom(el) {
    return el.localName?.includes("-")
}

function setProp(el, name, value) {
    if (name === "props") {
        el.props = value
        return
    }
    const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    el.props = { ...(el.props ?? {}), [key]: value }
}

function setClass(el, value) {
    const next = value == null || value === false ? [] : String(value).split(/\s+/).filter(Boolean)
    const previous = ownClasses.get(el) ?? (cursor && !isCustom(el) && el.hasAttribute("class") ? [...el.classList] : undefined)
    if (!previous && !el.hasAttribute("class")) {
        if (next.length) el.setAttribute("class", next.join(" "))
    } else {
        for (const token of previous ?? []) if (!next.includes(token)) el.classList.remove(token)
        for (const token of next) if (!el.classList.contains(token)) el.classList.add(token)
        if (!el.classList.length) el.removeAttribute("class")
    }
    ownClasses.set(el, next)
}

function setAttribute(el, name, value) {
    if (isCustom(el) && value !== null && (typeof value === "object" || typeof value === "function")) {
        setProp(el, name, value)
        return
    }
    if (name === "class" && !serverRendering) {
        setClass(el, value)
        return
    }
    if (PROPERTIES.has(name) && name in el) {
        const next = name === "value" ? (value == null ? "" : String(value)) : value === "" ? true : !!value
        if (el[name] !== next) el[name] = next
        if (name === "value" && !serverRendering && FORM_CONTROLS.has(el.tagName)) return
    }
    if (typeof value === "boolean" && spellsBoolean(name)) el.setAttribute(name, String(value))
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

const SPREAD_NAMES = { className: "class", htmlFor: "for" }
const NOT_ATTRIBUTES = new Set(["children", "key", "ref"])
const isHandlerName = name => /^on[A-Z]/.test(name)

function spreadHandler(el, name, value, handlers) {
    if (!(name in handlers)) {
        const event = name.slice(2).toLowerCase().replace("doubleclick", "dblclick")
        __on__(el, event, function (e) { return handlers[name]?.call(this, e) })
    }
    handlers[name] = value
}

export function __spread__(el, fn) {
    let previous = {}
    const handlers = {}
    __render_effect__(() => {
        const value = fn()
        const next = value == null || value === false ? {}
            : typeof value === "object" && !(value instanceof SafeHtml) ? value
            : parseAttributeList(__s__(value))
        for (const name in previous) {
            if (name in next || NOT_ATTRIBUTES.has(name)) continue
            if (name in handlers) handlers[name] = null
            else el.removeAttribute(SPREAD_NAMES[name] ?? name)
        }
        for (const name in next) {
            if (next[name] === previous[name] || NOT_ATTRIBUTES.has(name)) continue
            if (isHandlerName(name) && (typeof next[name] === "function" || name in handlers)) spreadHandler(el, name, next[name], handlers)
            else if (/^on/i.test(name)) continue
            else setAttribute(el, SPREAD_NAMES[name] ?? name, next[name])
        }
        previous = next
    })
}
