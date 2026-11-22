import { VARIANT, previewValue, type } from "./matching.js"
import { __def_variants__ } from "./definitions.js"

class TryReturn {
    constructor(value) {
        this.value = value
    }
}

export function __try__(value) {
    const info = value?.[VARIANT]
    if (info?.enum === "Result" || info?.enum === "Option") {
        if (info.tag === "Ok" || info.tag === "Some") return info.values[0]
        throw new TryReturn(value)
    }
    throw new TypeError(`"?" expects a Result or an Option, got ${type(value)}: ${previewValue(value)}`)
}

export function __try_return__(error) {
    if (error instanceof TryReturn) return error.value
    throw error
}

export function __try_rethrow__(error) {
    if (error instanceof TryReturn) throw error
}

function unwrapFailure(info) {
    const [error] = info.values
    if (error instanceof Error) throw error
    throw new Error(info.tag === "None" ? "unwrap() on Option.None" : `unwrap() on Result.Err: ${previewValue(error)}`)
}

export const Result = __def_variants__("Result", { Ok: [["value", "T"]], Err: [["error", "E"]] }, ["T", "E"], {
    isOk() { return this[VARIANT].tag === "Ok" },
    isErr() { return this[VARIANT].tag === "Err" },
    unwrap() { return this[VARIANT].tag === "Ok" ? this[VARIANT].values[0] : unwrapFailure(this[VARIANT]) },
    unwrapOr(fallback) { return this[VARIANT].tag === "Ok" ? this[VARIANT].values[0] : fallback },
    map(fn) { return this[VARIANT].tag === "Ok" ? Result.Ok(fn(this[VARIANT].values[0])) : this },
    mapErr(fn) { return this[VARIANT].tag === "Err" ? Result.Err(fn(this[VARIANT].values[0])) : this }
})

Result.attempt = fn => {
    try {
        const value = fn()
        return value instanceof Promise ? value.then(Result.Ok, Result.Err) : Result.Ok(value)
    } catch (error) {
        return Result.Err(error)
    }
}
Result.fromPromise = promise => Promise.resolve(promise).then(Result.Ok, Result.Err)

export const Option = __def_variants__("Option", { Some: [["value", "T"]], None: null }, ["T"], {
    isSome() { return this[VARIANT].tag === "Some" },
    isNone() { return this[VARIANT].tag === "None" },
    unwrap() { return this[VARIANT].tag === "Some" ? this[VARIANT].values[0] : unwrapFailure(this[VARIANT]) },
    unwrapOr(fallback) { return this[VARIANT].tag === "Some" ? this[VARIANT].values[0] : fallback },
    map(fn) { return this[VARIANT].tag === "Some" ? Option.Some(fn(this[VARIANT].values[0])) : this }
}, null, false, false)
export const __Option__ = Option
Option.from = value => value === null || value === undefined ? Option.None : Option.Some(value)
