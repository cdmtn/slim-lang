import { slimDocument } from "../helpers.js"
import { __insert__ } from "../dom.js"
import { __spread__ } from "./attributes.js"

const SVG_NAMESPACE = "http://www.w3.org/2000/svg"
const NOTHING = () => null
const makers = new Map()

function maker(name) {
    return (props = {}) => {
        const doc = typeof document !== "undefined" ? document : slimDocument
        const el = name === "svg" ? doc.createElementNS(SVG_NAMESPACE, name) : doc.createElement(name)
        const rest = {}
        for (const key of Object.keys(props)) if (key !== "children") rest[key] = props[key]
        __spread__(el, () => rest)
        if ("children" in props) {
            const anchor = doc.createTextNode("")
            el.appendChild(anchor)
            __insert__(anchor, () => props.children)
        }
        return el
    }
}

export function __dynamic__(tag) {
    if (typeof tag === "function") return tag
    if (tag == null || tag === false || tag === "") return NOTHING
    const name = String(tag)
    if (!/^[A-Za-z][\w.:-]*$/.test(name)) throw new Error(`"${name}" is not a tag name`)
    let make = makers.get(name)
    if (!make) makers.set(name, make = maker(name))
    return make
}
