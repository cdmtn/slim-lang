import { EnumValue } from "../types.js"
import { Type, type } from "./matching.js"

export function __sizeof__(value) {
    if (value === null || value === undefined) return 0
    if (typeof value === "string") return value.length
    if (Array.isArray(value)) return value.length
    if (value instanceof Map || value instanceof Set) return value.size
    if (typeof value === "object") return Object.keys(value).length
    if (typeof value === "number") return value.toString().length
    if (typeof value === "boolean") return 1
    return 0
}

export function __is_empty__(obj) {
    return __sizeof__(obj) === 0
}

export function __copyof__(obj) {
    if (Array.isArray(obj)) return [...obj]
    if (Type.isObj(obj)) return { ...obj }
    throw new TypeError(`Copy target must be object or array, not ${type(obj)}`)
}

export function __intdiv__(a, b) {
    if (typeof a === "bigint" && typeof b === "bigint") return a / b
    return Math.trunc(a / b)
}

export function __match_eq__(subject, pattern) {
    const a = subject instanceof EnumValue ? subject.value : subject
    const b = pattern instanceof EnumValue ? pattern.value : pattern
    return a === b
}

export function __match_rest__(subject, taken) {
    const rest = {}
    for (const key of Object.keys(subject)) if (!taken.includes(key)) rest[key] = subject[key]
    return rest
}
