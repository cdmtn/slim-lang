import { setSourceReader } from "./classErrors.js"
import {
    htmlToVdom,
    HTMLElement,
    __html__,
    __flush_events__,
    __bind_events__,
    __lifecycle__,
    __create_host__,
    __adopt_into__,
    __define_element__,
    __resolve_bem__,
    raw,
    escapeHtml
} from "./helpers.js"
import { DOM_GLOBALS } from "./dom.js"
import { ROUTER_GLOBALS } from "./router.js"

export * from "./core.js"

if (typeof process !== "undefined" && process.versions?.node) {
    const { readFileSync } = await import("node:fs")
    setSourceReader(file => readFileSync(file, "utf8"))
}

Object.assign(globalThis, {
    htmlToVdom, HTMLElement, __html__, __flush_events__, __bind_events__, __lifecycle__,
    __create_host__, __adopt_into__, __define_element__, __resolve_bem__, raw, escapeHtml,
    ...DOM_GLOBALS,
    ...ROUTER_GLOBALS
})
