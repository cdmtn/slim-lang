import { slimDocument } from "../helpers.js"
import { __component__, batch, onCleanup, withoutHydration } from "../reactive.js"
import { place, remove, serverRendering, toNodes, withoutCursor } from "../dom.js"
import { __render_effect__, untrack } from "../reactive.js"

export function __on__(el, event, handler, options) {
    if (typeof handler !== "function" || serverRendering) return
    el.addEventListener(event, function (e) {
        return batch(() => handler.call(el, e))
    }, options)
}

export function Portal(props = {}) {
    return __component__(() => {
        const placeholder = slimDocument.createTextNode("")
        if (serverRendering) return placeholder
        const shown = withoutCursor(() => withoutHydration(() => toNodes(props.children, [])))
        __render_effect__(() => {
            const to = props.to
            const position = props.position ?? "append"
            untrack(() => {
                const target = typeof to === "string" ? slimDocument.querySelector(to) : to ?? slimDocument.body
                if (!target) throw new Error(`Portal: nothing matches "${to}"`)
                const holder = slimDocument.createDocumentFragment()
                for (const node of shown) place(holder, node, null)
                let parent = target
                let ref = null
                if (position === "prepend") ref = target.firstChild
                else if (position === "before" || position === "after") {
                    parent = target.parentNode
                    if (!parent) throw new Error(`Portal: position "${position}" needs a target that has a parent`)
                    ref = position === "before" ? target : target.nextSibling
                } else if (position !== "append") {
                    throw new Error(`Portal: position is "append", "prepend", "before" or "after", got "${position}"`)
                }
                for (const node of shown) place(parent, node, ref)
            })
        })
        onCleanup(() => remove(shown))
        return placeholder
    })
}
Portal.__component__ = true

export function __ref__(el, receive) {
    if (typeof receive === "function") receive(el)
}
