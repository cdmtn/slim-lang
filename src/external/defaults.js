import fs from "fs"
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
    __resolve_bem__
} from "./helpers.js"

export * from "./core.js"

setSourceReader(file => fs.readFileSync(file, "utf8"))

Object.assign(globalThis, {
    htmlToVdom, HTMLElement, __html__, __flush_events__, __bind_events__, __lifecycle__,
    __create_host__, __adopt_into__, __define_element__, __resolve_bem__
})
