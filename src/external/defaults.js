import "./core.js"
import {
    htmlToVdom, HTMLElement, __html__, __flush_events__, __bind_events__, __lifecycle__,
    __create_host__, __adopt_into__, __define_element__, __resolve_bem__, raw, escapeHtml,
    __element_host__, __element_life__, __upgrade__, __listener__, upgrade, render, listen, onRemove, dispose, setHtml
} from "./helpers.js"
import { DOM_GLOBALS } from "./dom.js"

export * from "./runtime-dom.js"

Object.assign(globalThis, {
    htmlToVdom, HTMLElement, __html__, __flush_events__, __bind_events__, __lifecycle__,
    __create_host__, __adopt_into__, __define_element__, __resolve_bem__, raw, escapeHtml,
    __element_host__, __element_life__, __upgrade__, __listener__, upgrade, render, listen, onRemove, dispose, setHtml,
    ...DOM_GLOBALS
})
