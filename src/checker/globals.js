import { isKnownGlobal } from "../suggest.js"

const LANGUAGE = new Set([
    "globalThis", "Infinity", "NaN", "undefined", "eval", "isFinite", "isNaN", "parseFloat", "parseInt",
    "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape", "unescape",
    "AggregateError", "Array", "ArrayBuffer", "Atomics", "BigInt", "BigInt64Array", "BigUint64Array", "Boolean",
    "DataView", "Date", "Error", "EvalError", "FinalizationRegistry", "Float16Array", "Float32Array", "Float64Array",
    "Function", "Int8Array", "Int16Array", "Int32Array", "Intl", "Iterator", "JSON", "Map", "Math", "Number", "Object",
    "Promise", "Proxy", "RangeError", "ReferenceError", "Reflect", "RegExp", "Set", "SharedArrayBuffer", "String",
    "Symbol", "SyntaxError", "TypeError", "Uint8Array", "Uint8ClampedArray", "Uint16Array", "Uint32Array", "URIError",
    "WeakMap", "WeakRef", "WeakSet", "WebAssembly", "console", "arguments"
])

const SLIM = new Set([
    "log", "warn", "error", "info", "debug", "type", "Type", "Struct", "onError",
    "StructError", "StructPassedError", "StructExpectError", "ArgumentDeclarationTypeError"
])

export function knownGlobal(name, env) {
    if (env.environment === "embedded") return LANGUAGE.has(name) || SLIM.has(name)
    return isKnownGlobal(name)
}
