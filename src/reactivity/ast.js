import * as t from "@babel/types"
import _traverse from "@babel/traverse"

export const traverse = _traverse.default ?? _traverse

export const SKIP_KEYS = new Set(["loc", "start", "end", "extra", "leadingComments", "trailingComments", "innerComments"])

export const isNode = value => !!value && typeof value === "object" && typeof value.type === "string"
export const isMarkup = node => node?.type === "TaggedTemplateExpression" && node._slimMarkup === true
export const id = name => t.identifier(name)
export const call = (name, args) => t.callExpression(id(name), args)
export const call_ = call
export const thunk = body => t.arrowFunctionExpression([], body)

export function done(name) {
    const node = id(name)
    node._slimDone = true
    return node
}

export const NOT_COMPONENTS = new Set([
    "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Date", "Error", "TypeError",
    "RangeError", "SyntaxError", "Promise", "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "Proxy", "Reflect",
    "JSON", "Math", "Intl", "URL", "URLSearchParams", "Response", "Request", "Headers", "Blob", "File",
    "FormData", "Event", "CustomEvent", "AbortController", "RegExp"
])

export function keyName(key) {
    if (t.isIdentifier(key)) return key.name
    if (t.isStringLiteral(key)) return key.value
    return null
}
