import { formatError, resolveErrorLocation } from "../classErrors.js"
import { Type } from "./matching.js"

function writeError(text) {
    if (typeof process !== "undefined" && process.stderr) process.stderr.write(text)
    else (console.error ?? console.log)(text)
}

function reportError(err) {
    const loc = resolveErrorLocation(err)
    writeError(formatError(
        err?.tag ?? err?.name ?? "Error",
        err?.message ?? String(err),
        loc?.file ?? null,
        loc?.line ?? null,
        loc?.col ?? null,
        loc?.sourceLine ?? null,
    ) + "\n")
}

let __error_handler__ = null

export function onError(handler) {
    __error_handler__ = typeof handler === "function" ? handler : null
}

function finalizeError(err) {
    if (__error_handler__) {
        __error_handler__(err)
        return true
    }
    reportError(err)
    if (typeof process !== "undefined" && typeof process.exit === "function") {
        process.exit(1)
    }
    return false
}

export function __handle_async_error__(err) {
    finalizeError(err)
}
export function __handle_sync_error__(err) {
    if (!finalizeError(err)) throw err
}

function unwrap(arg) {
    if (!Type.isTyped(arg)) return arg
    if ("value" in arg) return arg.value
    if ("scheme" in arg) return arg.scheme
    return arg
}

export const log = (...args) => console.log(...args.map(unwrap))
export const warn = (...args) => (console.warn ?? console.log)(...args.map(unwrap))
export const error = (...args) => (console.error ?? console.log)(...args.map(unwrap))
export const info = (...args) => (console.info ?? console.log)(...args.map(unwrap))
export const debug = (...args) => console.log(...args)
