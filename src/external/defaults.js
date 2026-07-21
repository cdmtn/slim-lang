import { 
    StructPassedError, StructError, StructExpectError, StructResultError, ArgumentDeclarationTypeError,
    EnumError
} from "./classErrors.js"
import {
    SlimVariableType, SlimVariableTypes, Struct, Component, Enum, EnumValue
} from "./types.js"
import { formatError } from "./classErrors.js"

export function __handle_async_error__(err) {
    if (err?.tag) {
        process.stderr.write(formatError(
            err.tag,
            err.message,
            err.file       ?? null,
            err.line       ?? null,
            err.col        ?? null,
            err.sourceLine ?? null,
        ) + "\n")
    } else {
        process.stderr.write(`\nError: ${err?.message ?? String(err)}\n\n`)
    }
    process.exit(1)
}
export function __handle_sync_error__(err) {
    if (err?.tag) {
        process.stderr.write(formatError(
            err.tag,
            err.message,
            err.file       ?? null,
            err.line       ?? null,
            err.col        ?? null,
            err.sourceLine ?? null,
        ) + "\n")
    } else {
        process.stderr.write(`\nError: ${err?.message ?? String(err)}\n\n`)
    }
    process.exit(1)
}

// Console aliases
function logProcessed(args) {
    return args.map(arg => {
        if(Type.isTyped(arg) && "value" in arg) {
            return arg.value
        }
        if(Type.isTyped(arg) && "scheme" in arg) {
            return arg.scheme
        }
        return arg
    })
}
export const log = (...args) => {
    const processed = logProcessed(args)
    console.log(...processed)
}
export const warn = (...args) => {
    const processed = logProcessed(args)
    console.warn(...processed)
}
export const error = (...args) => {
    const processed = logProcessed(args)
    console.error(...processed)
}
export const info = (...args) => {
    const processed = logProcessed(args)
    console.info(...processed)
}
export const debug = (...args) => {
    console.log(...args)
}

export const PI = Math.PI

export class Type {
    static isStruct(obj) {
        return type(obj) == "struct"
    }
    static isEnum(obj) {
        return type(obj) == "enum"
    }
    static isEnumValue(obj) {
        return obj instanceof EnumValue
    }
    static isObj(obj) {
        return type(obj) == "object"
    }
    static isTyped(obj) {
        if(obj instanceof SlimVariableType || obj instanceof EnumValue || obj instanceof Struct) {
            return true
        }
        else {
            return false
        }
    }
    static isObj(obj) {
        return type(obj) == "object"
    }
    static isAnyArray(obj) {
        if(type(obj) == "array") return true
        else if(type(obj).endsWith("[]")) return true
        else return false
    }
}
export class Debug {
    static log(...args) {
        console.log(`[SLIM]`, ...args)
    }
}

export function type(obj) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    const urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/

    const isArray = (obj) => {
        return typeof obj === "object" && Array.isArray(obj)
    }
    const isTypedArray = (arr, t) => {
        return arr.every(element => type(element) === t)
    }
    const isTypedOfArray = (arr, t) => {
        return arr.every(element => typeof element === t)
    }
    
    if(obj == null) return "null"
    if(obj == undefined) return "undefined"
    if(obj == NaN) return "NaN"

    if(typeof obj == "object" && obj instanceof SlimVariableType) {
        return obj.kind
    }

    if(typeof obj == "object" && !Array.isArray(obj) && "type" in obj && obj.type == Struct) {
        return "struct"
    }
    if(typeof obj == "object" && !Array.isArray(obj) && "type" in obj && obj.type instanceof Enum) {
        return "enum"
    }
    if(typeof obj == "object" && !Array.isArray(obj) && obj instanceof EnumValue) {
        return "enum"
    }

    if(typeof obj === "function" && obj.prototype instanceof Component) return "component"
    
    if(isArray(obj) && isTypedArray(obj, "undefined")) return "null[]"
    if(isArray(obj) && isTypedArray(obj, "string")) return "string[]"
    if(isArray(obj) && isTypedArray(obj, "int")) return "int[]"
    if(isArray(obj) && isTypedArray(obj, "float")) return "float[]"
    if(isArray(obj) && isTypedArray(obj, "object")) return "object[]"
    if(isArray(obj) && isTypedOfArray(obj, "number")) return "number[]"
    if(isArray(obj) && isTypedArray(obj, "enum")) return "enum[]"
    if(isArray(obj) && isTypedArray(obj, "struct")) return "struct[]"
    if(isArray(obj) && isTypedArray(obj, "array")) return "array[]"

    if(isArray(obj)) return "array"
    if(typeof obj === "object" && !Array.isArray(obj)) return "object"

    if(typeof obj === "string") return "string"
    if(typeof obj === "number" && Number.isInteger(obj)) return "int"
    if(typeof obj === "number" && !Number.isInteger(obj)) return "float"

    if(typeof obj === "boolean") return "bool"

    if(typeof obj === "function" && /^\s*class\s+/.test(obj.toString())) return "class"
    if(typeof obj == "function") return "function"

    return undefined
}

// structures

const __structs__ = {}
const __enums__ = {}
const __RESERVED_DEFINES__ = new Set([
    "Error", "Object", "Array", "String", "Number",
    "Boolean", "Function", "Symbol", "Map", "Set",
    "Promise", "Proxy", "Reflect", "Math", "JSON",
    "Date", "RegExp", "WeakMap", "WeakSet", "WeakRef",
    "ArrayBuffer", "DataView", "Iterator",
    "Int8Array", "Uint8Array", "Uint8ClampedArray",
    "Int16Array", "Uint16Array", "Int32Array",
    "Uint32Array", "Float32Array", "Float64Array",
    "undefined", "null", "NaN", "Infinity",
    "globalThis", "global", "process", "console",
    "setTimeout", "setInterval", "clearTimeout", "clearInterval",
    "queueMicrotask", "structuredClone",
    "eval", "isNaN", "isFinite", "parseFloat", "parseInt",
    "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent",
    "type", "schemeArray", "verify", "values", "verifySafe"
])

export function __def_struct__(name, schema) {
    const schemeArray = {}

    Object.keys(schema).forEach(item => {
        let fieldName = item
        let isOptional = false
        let value = schema[item]

        if(fieldName.startsWith("*")) {
            isOptional = true
            fieldName = fieldName.slice(1).trim()
        }

        schemeArray[fieldName] = {
            type: value,
            optional: isOptional
        }
    })

    __structs__[name] = {
        type: Struct,
        name: name,
        scheme: schemeArray,
        verify: (object) => {
            __typed__(object, name)
        },
        verifySafe: (object) => {
            return __typed__(object, name, "errorResult")
        }
    }

    if (!__RESERVED_DEFINES__.has(name)) {
        globalThis[name] = __structs__[name]
    }
    else {
        throw new StructError(`Name "${name}" is reserved`)
    }

    return __structs__[name]
}
export function __def_enum__(name, schema) {
    const schemeArray = []

    Object.keys(schema).forEach(item => {
        let fieldName = item

        if (schema[item] === undefined) {
            schemeArray[fieldName] = {
                type: new Enum(name),
                name: item
            }
        } else {
            schemeArray[fieldName] = schema[item]
        }
    })

    __enums__[name] = {
        type: new Enum(name),
        name: name,
        scheme: () => {
            return schemeArray
        },
        values: () => {
            return Object.values(schemeArray).map(item => {
                if(typeof item === "object" && "name" in item) {
                    return item.name
                }
                else {
                    return item
                }
            })
        },
        keys: () => {
            return Object.keys(schemeArray)
        },
        has: (val) => {
            let result = false

            Object.keys(schemeArray).forEach(e => {
                result = val == schemeArray[e]
            })

            return result
        }
    }

    Object.keys(schemeArray).forEach(e => {
        __enums__[name][e] = new EnumValue(schemeArray[e])
    })

    if (!__RESERVED_DEFINES__.has(name)) {
        globalThis[name] = __enums__[name]
    }
    else {
        throw new EnumError(`Name "${name}" is reserved`)
    }

    return __enums__[name]
}

export function __typed_variable__(value, expectedType, varName) {
    const types = expectedType.split("|").map(t => t.trim())
    const currentType = type(value)

    if(expectedType === "any" || types.includes(currentType)) {
        const typed = new SlimVariableType(value, expectedType)
        SlimVariableTypes[varName] = typed

        return value
    }
    else {
        throw new TypeError(`The variable "${varName}" is of type ${expectedType}, but was assigned a ${currentType}`)
    }
}
export function __typed_variable_check__(varName, value) {
    if(varName in SlimVariableTypes) {
        const typed = SlimVariableTypes[varName]
        const expected = typed.expected
        const types = expected.split("|").map(t => t.trim())
        const currentType = type(value)

        if(expected === "any" || types.includes(currentType)) {
            return value
        }
        else {
            throw new TypeError(`The variable "${varName}" is of type ${expected}, but it was redefined with type ${currentType}`)
        }
    }
    else {
        return value
    }
}

export function __typed__(value, structName, returnMethod = "default") {
    function structOk() {
        return {
            success: true,
            result: value
        }
    }
    function structErr(value) {
        return {
            success: false,
            result: {
                type: value.tag,
                msg: String(value)
            }
        }
    }
    function checkType(expectedType, val) {
        function isEnum(t = expectedType, v = val) {
            return t in __enums__ && (v in __enums__[t].values() || __enums__[t].values().some(value1 => value1.name === v.value.name))
        }
        function isStruct(t = expectedType, v = val) {
            return t in __structs__ && v.name == t
        }

        if(expectedType.includes("::")) {
            const type = expectedType.split("::")[0].trim()
            const typeValue = expectedType.split("::")[1].trim()

            if(type in __enums__ && typeValue in __enums__[type]) {
                return __enums__[type][typeValue] == val
            }
        }

        if(isEnum()) {
            return true
        }
        if(isStruct()) {
            return true
        }

        return expectedType == "any" || type(val) == expectedType
    }

    const structDef = __structs__[structName]
    if (!structDef) throw new StructError(`Unknown struct "${structName}"`)

    const schema = structDef.scheme

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        let err = new StructError(`Expected object for "${structName}"`)

        if(returnMethod == "errorResult") {
            return structErr(err)
        }
        else {
            throw err
        }
    }

    const valueKeys = Object.keys(value)
    const schemaKeys = Object.keys(schema)

    const extraKeys = valueKeys.filter(k => !(k in schema))

    if (extraKeys.length > 0) {
        let err = new StructPassedError(
            `"${structName}" does not contain any keys named "${extraKeys.join(", ")}", but it receives them`
        )

        if(returnMethod == "errorResult") {
            return structErr(err)
        }
        else {
            throw err
        }
    }

    for (const field of schemaKeys) {
        const def = schema[field]

        if (!(field in value)) {
            if (!def.optional) {
                let err = new StructExpectError(
                    `"${structName}" is receiving fewer keys than expected. The key "${field}" have not been received`
                )

                if(returnMethod == "errorResult") {
                    return structErr(err)
                }
                else {
                    throw err
                }
            }
            continue
        }

        const val = value[field]
        const expectedType = def.type

        const isMultipleTypes = expectedType.includes("|")

        if(isMultipleTypes) {
            const types = expectedType.split("|").map(item => item.trim())
            let multipleTypesVerifyResult = false

            types.forEach(t => {
                if(checkType(t, val)) multipleTypesVerifyResult = true
            })

            if (!multipleTypesVerifyResult) {
                throwError({ field: field, expectedType: `${types.join(" or ")}`, val: val })
            }
        }
        else if (!checkType(expectedType, val)) {
            throwError({ field: field, expectedType: expectedType, val: val })
        }

        function throwError({ field, expectedType, val }) {
            let value = type(val)
            let expected = expectedType

            if(Type.isEnum(val)) {
                value = `${val.name} ${type(val)}`
            }
            if(Type.isStruct(val)) {
                value = `${val.name} ${type(val)}`
            }

            if(expected in __enums__) {
                expected = `${expected} enum`
            }
            if(expected in __structs__) {
                expected = `${expected} struct`
            }

            let err = new StructError(
                `"${structName}.${field}" expected ${expected}, got ${value}`
            )

            if(returnMethod == "errorResult") {
                return structErr(err)
            }
            else {
                throw err
            }
        }
    }

    if(returnMethod == "default") return value
    if(returnMethod == "errorResult") return structOk()
}
//

export function __sizeof__(value) {
    if (value === null || value === undefined) return 0
    if (typeof value === "string")  return value.length
    if (Array.isArray(value))       return value.length
    if (typeof value === "object")  return Object.keys(value).length
    if (typeof value === "number")  return value.toString().length
    if (typeof value === "boolean") return 1
    return 0
}

export function __is_empty__(obj) {
    if(__sizeof__(obj) == 0) {
        return true
    }
    else {
        return false
    }
}

export function __copyof__(obj) {
    if(Type.isObj(obj)) {
        return {...obj}
    }
    else if(Type.isAnyArray(obj)) {
        const arrCopy = []
        obj.forEach(item => arrCopy.push(item))
        return arrCopy
    }
    else {
        throw TypeError(`Copy target must be object or array, not ${type(obj)}`)
    }
}

export function __intdiv__(a, b) {
    return Math.trunc(a / b)
}

const IMMUTABLE = new WeakMap()

export function __lock_object__(obj) {
    if (obj === null || typeof obj !== "object") return obj

    if (IMMUTABLE.has(obj)) return IMMUTABLE.get(obj)

    const handler = {
        set() {
            throw new Error("locked object mutation")
        },
        deleteProperty() {
            throw new Error("locked object mutation")
        },
        defineProperty() {
            throw new Error("locked object mutation")
        },
        setPrototypeOf() {
            throw new Error("locked object mutation")
        }
    }

    const wrapped = new Proxy(obj, handler)

    IMMUTABLE.set(obj, wrapped)

    const keys = Reflect.ownKeys(obj)

    for (const key of keys) {
        const value = obj[key]

        if (value && typeof value === "object") {
            obj[key] = __lock_object__(value)
        }
    }

    Object.freeze(obj)

    return wrapped
}

Object.assign(globalThis, {
    log, warn, error, info, debug,

    type,

    Component, Type, Struct,

    __def_struct__, __def_enum__, __typed__, __handle_async_error__, 
    __handle_sync_error__, __sizeof__, __is_empty__, __lock_object__,
    __typed_variable__, __typed_variable_check__, __intdiv__, __copyof__,

    StructError, StructPassedError, StructExpectError, ArgumentDeclarationTypeError,

    PI
})