// Portable core runtime with no Node or DOM dependencies.

import {
    StructPassedError, StructError, StructExpectError, ArgumentDeclarationTypeError,
    EnumError
} from "./classErrors.js"
import {
    SlimVariableType, SlimVariableTypes, Struct, Component, Enum, EnumValue,
    isSameType
} from "./types.js"
import { formatError, resolveErrorLocation } from "./classErrors.js"

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
export const __custom_types__ = {}

function writeError(text) {
    if (typeof process !== "undefined" && process.stderr) process.stderr.write(text)
    else console.error(text)
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
        return
    }
    reportError(err)
    if (typeof process !== "undefined" && typeof process.exit === "function") {
        process.exit(1)
    }
}

export function __handle_async_error__(err) {
    finalizeError(err)
}
export function __handle_sync_error__(err) {
    finalizeError(err)
}

function logProcessed(args) {
    return args.map(arg => {
        if (Type.isTyped(arg) && "value" in arg) {
            return arg.value
        }
        if (Type.isTyped(arg) && "scheme" in arg) {
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

const __test_stats__ = { passed: 0, failed: 0 }

export function test(name, fn) {
    try {
        fn()
        __test_stats__.passed++
        console.log(`  ✓ ${name}`)
    } catch (err) {
        __test_stats__.failed++
        if (typeof process !== "undefined") process.exitCode = 1
        console.log(`  ✗ ${name}\n      ${err?.message ?? err}`)
    }
}

export function assert(condition, message = "assertion failed") {
    if (!condition) throw new Error(message)
}

export function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
}

if (typeof process !== "undefined" && typeof process.on === "function") {
    process.on("exit", () => {
        const total = __test_stats__.passed + __test_stats__.failed
        if (total > 0) console.log(`\n${__test_stats__.passed} passed, ${__test_stats__.failed} failed`)
    })
}

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
        if (obj instanceof SlimVariableType || obj instanceof EnumValue || obj instanceof Struct) {
            return true
        }
        else {
            return false
        }
    }
    static isAnyArray(obj) {
        if (type(obj) == "array") return true
        else if (type(obj).endsWith("[]")) return true
        else return false
    }

    static isRegistredCustom(type) {
        return Object.keys(__custom_types__).includes(type)
    }

    static Customs = __custom_types__
}
export class Debug {
    static log(...args) {
        console.log(`[SLIM]`, ...args)
    }
}

export function type(obj, properties = {}) {
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

    if (obj === null) return "null"
    if (obj === undefined) return "undefined"
    if (Number.isNaN(obj)) return "NaN"

    // The optional DOM layer requires structural element detection.
    if (obj && typeof obj === "object" && obj.nodeType === 1) return "element"
    if (obj && obj.nodeType === 11) return "fragment"

    if(typeof obj == "function" && obj.__type__ == true) return "type"

    if (typeof obj == "object" && obj instanceof SlimVariableType) {
        return obj.kind
    }

    if (typeof obj == "object" && !Array.isArray(obj) && "type" in obj && obj.type == Struct) {
        return "struct"
    }
    if (typeof obj == "object" && !Array.isArray(obj) && "type" in obj && obj.type instanceof Enum) {
        return "enum"
    }
    if (typeof obj == "object" && !Array.isArray(obj) && obj instanceof EnumValue) {
        return "enum"
	}

    if (typeof obj === "function" && obj.__component__ == true) return "component"

    if (isArray(obj) && isTypedArray(obj, "undefined")) return "null[]"
    if (isArray(obj) && isTypedArray(obj, "string")) return "string[]"
    if (isArray(obj) && isTypedArray(obj, "int")) return "int[]"
    if (isArray(obj) && isTypedArray(obj, "float")) return "float[]"
    if (isArray(obj) && isTypedArray(obj, "object")) return "object[]"
    if (isArray(obj) && isTypedOfArray(obj, "number")) return "number[]"
    if (isArray(obj) && isTypedArray(obj, "enum")) return "enum[]"
    if (isArray(obj) && isTypedArray(obj, "struct")) return "struct[]"
    if (isArray(obj) && isTypedArray(obj, "array")) return "array[]"

    if (isArray(obj)) return "array"

    if (obj instanceof Map) return "map"
    if (obj instanceof Set) return "set"
    if (obj instanceof Date) return "date"
    if (obj instanceof Promise) return "promise"
    if (obj instanceof RegExp) return "regexp"
    if (obj instanceof Error) return "error"

    if (typeof obj === "object" && !Array.isArray(obj)) return "object"

    if (typeof obj === "string") return "string"
    if (typeof obj === "number" && Number.isInteger(obj)) return "int"
    if (typeof obj === "number" && !Number.isInteger(obj)) return "float"

    if (typeof obj === "boolean") return "bool"
    if (typeof obj === "bigint") return "bigint"
    if (typeof obj === "symbol") return "symbol"

    if (typeof obj === "function" && /^\s*class\s+/.test(obj.toString())) return "class"
    if (typeof obj == "function") return "function"

    return undefined
}


export function __type_ref__(label, resolve = null) {
    return { __slim_type_ref__: true, label, resolve }
}

export function __type_spec__(...references) {
    return references
}

export function __type_spec_all__(...references) {
    return { __slim_all__: true, references }
}

function referenceLabel(reference) {
    return typeof reference === "string" ? reference : reference?.label ?? String(reference)
}

export function __type_label__(specification) {
    if (specification && specification.__slim_all__) {
        return specification.references.map(referenceLabel).join(" & ")
    }
    const refs = Array.isArray(specification) ? specification : [specification]
    return refs.map(referenceLabel).join(" | ")
}

function resolveTypeReference(reference) {
    if (reference && typeof reference === "object" && reference.__slim_type_ref__) {
        if (typeof reference.resolve === "function") return reference.resolve()

        const name = reference.label.replace(/(?:\[\])+$/, "").split("::")[0]
        return __custom_types__[name] ?? __structs__[name] ?? __enums__[name]
    }

    if (typeof reference === "string") {
        const name = reference.replace(/(?:\[\])+$/, "").split("::")[0]
        return __custom_types__[name] ?? __structs__[name] ?? __enums__[name]
    }

    return reference
}

function isClass(value) {
    return typeof value === "function" && /^\s*class\s+/.test(Function.prototype.toString.call(value))
}

function matchesDefinition(definition, value) {
    if (Array.isArray(definition)) return __type_matches__(definition, value)

    if (typeof definition === "function") {
        if (isClass(definition)) return value instanceof definition
        return definition(value) === true
    }

    return isSameType(definition, value)
}

function matchesResolvedType(resolved, label, value) {
    if (resolved === undefined || resolved === null) return false

    if (resolved?.type === Struct) {
        return __typed__(value, resolved, "errorResult").success
    }

    if (resolved?.type instanceof Enum) return resolved.has(value)
    if (resolved instanceof EnumValue) return resolved === value

    if (typeof resolved === "function" && resolved.__type__ === true) {
        return resolved(value) === true
    }

    return matchesDefinition(resolved, value)
}

const BUILTIN_CLASSES = { Map, Set, Date, Promise, RegExp, Error }

// Split tuple and generic members only at top-level commas.
function splitTypeList(text) {
    const parts = []
    let depth = 0
    let current = ""

    for (const char of text) {
        if (char === "<" || char === "[" || char === "(") depth++
        else if (char === ">" || char === "]" || char === ")") depth--
        else if (char === "," && depth === 0) { parts.push(current.trim()); current = ""; continue }
        current += char
    }
    if (current.trim()) parts.push(current.trim())
    return parts
}

function matchesLabel(label, value) {
    return __type_matches__(__type_spec__(__type_ref__(label)), value)
}

function matchesNamedType(label, resolved, value) {
    if (label === "any") return true

    if (label.length > 2 && label.startsWith("[") && label.endsWith("]")) {
        if (!Array.isArray(value)) return false

        const parts = splitTypeList(label.slice(1, -1))
        if (value.length !== parts.length) return false
        return parts.every((part, index) => matchesLabel(part, value[index]))
    }

    const generic = label.indexOf("<")
    if (generic !== -1 && label.endsWith(">")) {
        const container = label.slice(0, generic).trim()
        const args = splitTypeList(label.slice(generic + 1, -1))
        const first = args[0] ?? "any"

        if (container === "Array") {
            return Array.isArray(value) && value.every(item => matchesLabel(first, item))
        }
        if (container === "Set") {
            return value instanceof Set && [...value].every(item => matchesLabel(first, item))
        }
        if (container === "Map") {
            const second = args[1] ?? "any"
            return value instanceof Map && [...value].every(([key, entry]) =>
                matchesLabel(first, key) && matchesLabel(second, entry))
        }
        if (container === "Promise") return value instanceof Promise

        return matchesNamedType(container, resolved, value)
    }

    if (label.endsWith("[]")) {
        if (!Array.isArray(value)) return false

        const elementLabel = label.slice(0, -2)
        if (value.length === 0) return type(value) === label || elementLabel === "any"

        if (resolved !== undefined) {
            return value.every(item => matchesResolvedType(resolved, elementLabel, item))
        }

        return type(value) === label
    }

    const enumSeparator = label.indexOf("::")
    if (enumSeparator !== -1) {
        const enumName = label.slice(0, enumSeparator)
        const member = label.slice(enumSeparator + 2)
        const enumDef = resolved ?? __enums__[enumName]
        return !!enumDef && enumDef[member] === value
    }

    if (resolved !== undefined) return matchesResolvedType(resolved, label, value)
    if (label === "number") return type(value) === "int" || type(value) === "float"

    if (label in BUILTIN_CLASSES) return value instanceof BUILTIN_CLASSES[label]

    return type(value) === label
}

function matchesReference(reference, value) {
    const label = typeof reference === "string" ? reference : reference?.label
    if (!label) return false
    return matchesNamedType(label, resolveTypeReference(reference), value)
}

export function __type_matches__(specification, value) {
    if (specification && specification.__slim_all__) {
        return specification.references.every(reference => matchesReference(reference, value))
    }
    const references = Array.isArray(specification) ? specification : [specification]
    return references.some(reference => matchesReference(reference, value))
}

function previewValue(value) {
    try {
        if (typeof value === "string") return JSON.stringify(value)
        if (typeof value === "function") return type(value)
        const text = JSON.stringify(value)
        if (text === undefined) return String(value)
        return text.length > 40 ? text.slice(0, 40) + "…" : text
    } catch {
        return String(value)
    }
}

function typeError(varName, expected, value, action = "assigned") {
    const actual = type(value)
    const preview = previewValue(value)
    if (action === "redefined") {
        throw new TypeError(`The variable "${varName}" is of type ${expected}, but it was redefined with type ${actual}: ${preview}`)
    }
    if (action === "mutated") {
        throw new TypeError(`The variable "${varName}" is of type ${expected}, but it was mutated into type ${actual}: ${preview}`)
    }
    throw new TypeError(`The "${varName}" is of type ${expected}, but was assigned a ${actual}: ${preview}`)
}

const guardedValues = new WeakMap()
const scopedVariableTypes = new WeakMap()
const typedStaticFields = new WeakMap()

function setVariableType(bindingId, definition) {
    if (bindingId && (typeof bindingId === "object" || typeof bindingId === "function")) {
        scopedVariableTypes.set(bindingId, definition)
    } else {
        SlimVariableTypes[bindingId] = definition
    }
}

function getVariableType(bindingId) {
    if (bindingId && (typeof bindingId === "object" || typeof bindingId === "function")) {
        return scopedVariableTypes.get(bindingId)
    }
    return SlimVariableTypes[bindingId]
}

function setStaticFieldType(owner, field, definition) {
    const fields = typedStaticFields.get(owner) ?? new Map()
    fields.set(field, definition)
    typedStaticFields.set(owner, fields)
}

function getStaticFieldType(owner, field) {
    return typedStaticFields.get(owner)?.get(field)
}

function guardTypedValue(value, specification, varName) {
    if (!value || typeof value !== "object" || !__type_matches__(specification, value)) return value
    if (__type_label__(specification) === "any") return value
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return value

    const cached = guardedValues.get(value)
    if (cached?.has(specification)) return cached.get(specification)

    const restore = (target, property, descriptor) => {
        if (descriptor) Reflect.defineProperty(target, property, descriptor)
        else Reflect.deleteProperty(target, property)
    }
    const check = (target, property, descriptor) => {
        if (__type_matches__(specification, target)) return
        restore(target, property, descriptor)
        typeError(varName, __type_label__(specification), target, "mutated")
    }
    const proxy = new Proxy(value, {
        set(target, property, next) {
            const descriptor = Object.getOwnPropertyDescriptor(target, property)
            const succeeded = Reflect.set(target, property, next, target)
            if (!succeeded) return false
            check(target, property, descriptor)
            return true
        },
        deleteProperty(target, property) {
            const descriptor = Object.getOwnPropertyDescriptor(target, property)
            const succeeded = Reflect.deleteProperty(target, property)
            if (!succeeded) return false
            check(target, property, descriptor)
            return true
        },
        defineProperty(target, property, descriptor) {
            const previous = Object.getOwnPropertyDescriptor(target, property)
            const succeeded = Reflect.defineProperty(target, property, descriptor)
            if (!succeeded) return false
            check(target, property, previous)
            return true
        }
    })

    const entries = cached ?? new Map()
    entries.set(specification, proxy)
    guardedValues.set(value, entries)
    return proxy
}


export function __def_struct__(name, schema, specifications = {}, defaults = {}, extendsName = null, methods = {}) {
    const parent = extendsName ? __structs__[extendsName] : null
    if (extendsName && !parent) throw new StructError(`Struct "${name}" extends unknown struct "${extendsName}"`)

    const schemeArray = parent ? { ...parent.scheme } : {}
    const mergedDefaults = parent ? { ...parent.__defaults__, ...defaults } : defaults
    const mergedMethods = parent ? { ...parent.__methods__, ...methods } : methods

    Object.keys(schema).forEach(item => {
        let fieldName = item
        let optional = false
        if (fieldName.startsWith("*")) {
            optional = true
            fieldName = fieldName.slice(1).trim()
        }

        schemeArray[fieldName] = {
            type: schema[item],
            specification: specifications[fieldName] ?? schema[item],
            optional
        }
    })

    const definition = {
        type: Struct,
        name,
        scheme: schemeArray,
        __defaults__: mergedDefaults,
        __methods__: mergedMethods,
        verify: object => __typed__(object, definition),
        verifySafe: object => __typed__(object, definition, "errorResult"),
        new: (values = {}) => {
            const filled = {}
            for (const key of Object.keys(mergedDefaults)) {
                if (!(key in values)) filled[key] = mergedDefaults[key]()
            }
            const data = __typed__({ ...filled, ...values }, definition)
            return Object.keys(mergedMethods).length ? Object.assign(Object.create(mergedMethods), data) : data
        }
    }

    __structs__[name] = definition
    if (__RESERVED_DEFINES__.has(name)) throw new StructError(`Name "${name}" is reserved`)
    globalThis[name] = definition
    return definition
}

export function __def_enum__(name, schema) {
    const values = { ...schema }
    const definition = {
        type: new Enum(name),
        name,
        scheme: () => values,
        values: () => Object.values(values),
        keys: () => Object.keys(values),
        has: value => Object.values(values).some(item =>
            value === item || (value instanceof EnumValue && value.value === item)
        )
    }

    Object.keys(values).forEach(key => {
        definition[key] = new EnumValue(values[key])
    })

    __enums__[name] = definition
    if (__RESERVED_DEFINES__.has(name)) throw new EnumError(`Name "${name}" is reserved`)
    globalThis[name] = definition
    return definition
}

export function __typed_variable__(value, specification, bindingId, varName = bindingId) {
    const expected = __type_label__(specification)
    if (!__type_matches__(specification, value)) typeError(varName, expected, value)

    setVariableType(bindingId, {
        expected: specification,
        label: expected,
        name: varName
    })
    return guardTypedValue(value, specification, varName)
}

export function __typed_return__(value, specification, fnName) {
    if (!__type_matches__(specification, value)) {
        throw new TypeError(
            `function "${fnName}" must return ${__type_label__(specification)}, got ${type(value)}: ${previewValue(value)}`
        )
    }
    return value
}

export function __typed_pattern__(value, typeLabel) {
    if (!__type_matches__(typeLabel, value)) {
        throw new TypeError(`destructured value does not match type ${typeLabel}: ${previewValue(value)}`)
    }
    return value
}

export function __typed_variable_check__(bindingId, value, varName = bindingId) {
    const typed = getVariableType(bindingId)
    if (!typed) return value
    if (!__type_matches__(typed.expected, value)) typeError(varName, typed.label, value, "redefined")
    return guardTypedValue(value, typed.expected, varName)
}

export function __typed_parameter__(value, specification, bindingId, varName, optional, message) {
    if (optional && (value === undefined || value === null)) {
        setVariableType(bindingId, {
            expected: specification,
            label: __type_label__(specification),
            name: varName
        })
        return value
    }

    if (!__type_matches__(specification, value)) {
        throw new ArgumentDeclarationTypeError(message, { skipUserFrames: 1 })
    }

    setVariableType(bindingId, {
        expected: specification,
        label: __type_label__(specification),
        name: varName
    })
    return guardTypedValue(value, specification, varName)
}

export function __typed_static_field__(owner, field, value, specification, displayName) {
    const label = __type_label__(specification)
    if (!__type_matches__(specification, value)) typeError(displayName, label, value)
    setStaticFieldType(owner, field, { expected: specification, label })
    return guardTypedValue(value, specification, displayName)
}

export function __typed_static_field_check__(owner, field, value, displayName) {
    const definition = getStaticFieldType(owner, field)
    if (!definition) return value
    if (!__type_matches__(definition.expected, value)) {
        typeError(displayName, definition.label, value, "redefined")
    }
    return guardTypedValue(value, definition.expected, displayName)
}

export function __argument_typed__(value, expectedType) {
    return __type_matches__(expectedType, value)
}

export function __type_def__(name, definition, properties = {}) {
    const inherited = properties.extends ?? null
    const customType = value => {
        if (inherited && !__type_matches__(inherited, value)) return false
        return matchesDefinition(definition, value)
    }

    customType.__type__ = true
    customType.__slim_type_name__ = name
    customType.value = definition
    __custom_types__[name] = customType
    return customType
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
__type_def__("email", value => typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
__type_def__("url", value => typeof value === "string" && /^https?:\/\/[^\s]+$/.test(value))
__type_def__("uuid", value => typeof value === "string" && UUID.test(value))
__type_def__("positive", value => typeof value === "number" && value > 0)
__type_def__("negative", value => typeof value === "number" && value < 0)
__type_def__("natural", value => Number.isInteger(value) && value >= 0)
__type_def__("nonempty", value => (typeof value === "string" || Array.isArray(value)) && value.length > 0)

export function __typed__(value, structName, returnMethod = "default") {
    const name = typeof structName === "string" ? structName : structName?.name
    const structDef = typeof structName === "string" ? __structs__[structName] : structName
    if (!structDef) throw new StructError(`Unknown struct "${structName}"`)

    const fail = (error, properties = {}) => {
        if (returnMethod === "errorResult") {
            return { success: false, result: { type: error.tag, msg: String(error) }, properties }
        }
        throw error
    }

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return fail(new StructError(`Expected object for "${name}"`))
    }

    const schema = structDef.scheme
    const extra = Object.keys(value).filter(key => !(key in schema))
    if (extra.length > 0) {
        return fail(new StructPassedError(
            `"${name}" does not contain any keys named "${extra.join(", ")}", but it receives them`
        ))
    }

    for (const [field, definition] of Object.entries(schema)) {
        if (!(field in value)) {
            if (!definition.optional) {
                return fail(new StructExpectError(
                    `"${name}" is receiving fewer keys than expected. The key "${field}" have not been received`
                ))
            }
            continue
        }

        if (!__type_matches__(definition.specification, value[field])) {
            return fail(new StructError(
                `"${name}.${field}" expected ${__type_label__(definition.specification)}, got ${type(value[field])}: ${previewValue(value[field])}`
            ), {
            	name: name,
             	field: field,
              	expected: __type_label__(definition.specification),
               	got: type(value[field]),
                fieldName: `${name}.${field}`
            })
        }
    }

    return returnMethod === "errorResult"
        ? { success: true, result: value }
        : value
}

export function __sizeof__(value) {
    if (value === null || value === undefined) return 0
    if (typeof value === "string") return value.length
    if (Array.isArray(value)) return value.length
    if (typeof value === "object") return Object.keys(value).length
    if (typeof value === "number") return value.toString().length
    if (typeof value === "boolean") return 1
    return 0
}

export function __is_empty__(obj) {
    if (__sizeof__(obj) == 0) {
        return true
    }
    else {
        return false
    }
}

export function __copyof__(obj) {
    if (Type.isObj(obj)) {
        return { ...obj }
    }
    else if (Type.isAnyArray(obj)) {
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

export function __match_eq__(subject, pattern) {
    const a = subject instanceof EnumValue ? subject.value : subject
    const b = pattern instanceof EnumValue ? pattern.value : pattern
    return a === b
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

    onError, test, assert, assertEqual,

    __def_struct__, __def_enum__, __typed__, __handle_async_error__,
    __handle_sync_error__, __sizeof__, __is_empty__, __lock_object__,
    __typed_variable__, __typed_variable_check__, __typed_pattern__, __typed_return__,
    __intdiv__, __copyof__, __match_eq__,
    __typed_parameter__, __typed_static_field__, __typed_static_field_check__,
    __type_def__, __argument_typed__,
    __type_ref__, __type_spec__, __type_spec_all__, __type_matches__, __type_label__,

    StructError, StructPassedError, StructExpectError, ArgumentDeclarationTypeError,

    PI
})
