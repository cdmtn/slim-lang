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

// Element kinds whose homogeneous arrays are reported as "<kind>[]".
// "undefined" maps to "null[]"; the empty array is also "null[]".
const ARRAY_KINDS = {
    __proto__: null,
    undefined: "null[]", string: "string[]", int: "int[]", float: "float[]",
    object: "object[]", enum: "enum[]", struct: "struct[]", array: "array[]"
}

// One pass over the elements. Tracks whether every element has the same kind
// and whether every element is a raw JS number (int/float mix, NaN), and stops
// as soon as neither can still hold. Holes are skipped like Array#every does.
function arrayKind(arr) {
    let kind
    let same = true
    let numeric = true
    let seen = false
    for (let i = 0; i < arr.length; i++) {
        const element = arr[i]
        if (element === undefined && !(i in arr)) continue
        if (numeric && typeof element !== "number") numeric = false
        if (same) {
            const k = type(element)
            if (!seen) { kind = k; seen = true }
            else if (k !== kind) same = false
        }
        if (!same && !numeric) return "array"
    }
    if (!seen) return "null[]"
    if (same) {
        const label = ARRAY_KINDS[kind]
        if (label !== undefined) return label
    }
    return numeric ? "number[]" : "array"
}

export function type(obj, properties = {}) {
    switch (typeof obj) {
        case "string": return "string"
        case "number":
            if (obj !== obj) return "NaN"
            return Number.isInteger(obj) ? "int" : "float"
        case "boolean": return "bool"
        case "undefined": return "undefined"
        case "bigint": return "bigint"
        case "symbol": return "symbol"
    }
    if (obj === null) return "null"

    // The optional DOM layer requires structural element detection.
    const nodeType = obj.nodeType
    if (nodeType !== undefined) {
        if (nodeType === 1 && typeof obj === "object") return "element"
        if (nodeType === 11) return "fragment"
    }

    if (typeof obj === "function") {
        if (obj.__type__ == true) return "type"
        if (obj.__component__ == true) return "component"
        return /^\s*class\s+/.test(obj.toString()) ? "class" : "function"
    }

    if (obj instanceof SlimVariableType) return obj.kind

    if (Array.isArray(obj)) return arrayKind(obj)

    if ("type" in obj && obj.type == Struct) return "struct"
    if ("type" in obj && obj.type instanceof Enum) return "enum"
    if (obj instanceof EnumValue) return "enum"

    if (obj instanceof Map) return "map"
    if (obj instanceof Set) return "set"
    if (obj instanceof Date) return "date"
    if (obj instanceof Promise) return "promise"
    if (obj instanceof RegExp) return "regexp"
    if (obj instanceof Error) return "error"

    return "object"
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

// Type checks are compiled once per label into closures. Labels are parsed
// only at compile time; the hot path never touches strings. Names resolve
// lazily and are re-resolved only when a definition is registered, so
// declaration order and cyclic structs behave the same as before.
let registryVersion = 0

function lookupName(name) {
    return __custom_types__[name] ?? __structs__[name] ?? __enums__[name]
}

const classCache = new WeakMap()

function isClass(value) {
    if (typeof value !== "function") return false
    let result = classCache.get(value)
    if (result === undefined) {
        result = /^\s*class\s+/.test(Function.prototype.toString.call(value))
        classCache.set(value, result)
    }
    return result
}

const NEVER = () => false
const ALWAYS = () => true

// Matches a definition (function, class, spec array or plain value).
function definitionPredicate(definition) {
    if (Array.isArray(definition)) {
        let compiled = null
        return value => (compiled ??= compileSpec(definition))(value)
    }

    if (typeof definition === "function") {
        if (isClass(definition)) return value => value instanceof definition
        return value => definition(value) === true
    }

    return value => isSameType(definition, value)
}

const resolvedPredicates = new WeakMap()

function resolvedPredicate(resolved) {
    if (resolved === null) return NEVER

    const cacheable = typeof resolved === "object" || typeof resolved === "function"
    if (cacheable) {
        const cached = resolvedPredicates.get(resolved)
        if (cached) return cached
    }

    let predicate
    if (resolved?.type === Struct) {
        predicate = structPredicate(resolved)
    } else if (resolved?.type instanceof Enum) {
        const members = resolved.values()
        predicate = value => {
            for (let i = 0; i < members.length; i++) {
                if (value === members[i] || (value instanceof EnumValue && value.value === members[i])) return true
            }
            return false
        }
    } else if (resolved instanceof EnumValue) {
        predicate = value => resolved === value
    } else if (typeof resolved === "function" && resolved.__type__ === true) {
        predicate = value => resolved(value) === true
    } else {
        predicate = definitionPredicate(resolved)
    }

    if (cacheable) resolvedPredicates.set(resolved, predicate)
    return predicate
}

const structPredicates = new WeakMap()

function compileFields(schema) {
    const fields = Object.entries(schema).map(([name, definition]) => ({
        name,
        optional: definition.optional,
        test: compileSpec(definition.specification)
    }))
    return { fields, names: new Set(fields.map(field => field.name)) }
}

// One predicate per struct: shape, extra keys, optional fields and field types.
function structPredicate(definition) {
    let predicate = structPredicates.get(definition)
    if (predicate) return predicate

    let compiledFor = null
    let fields = null
    let names = null
    predicate = value => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return false

        const schema = definition.scheme
        if (compiledFor !== schema) {
            const compiled = compileFields(schema)
            fields = compiled.fields
            names = compiled.names
            compiledFor = schema
        }

        // `in schema` also accepts inherited names such as "constructor"; keep that.
        const keys = Object.keys(value)
        for (let i = 0; i < keys.length; i++) {
            if (!names.has(keys[i]) && !(keys[i] in schema)) return false
        }

        for (let i = 0; i < fields.length; i++) {
            const field = fields[i]
            const entry = value[field.name]
            if (entry === undefined && !(field.name in value)) {
                if (!field.optional) return false
                continue
            }
            if (!field.test(entry)) return false
        }
        return true
    }
    structPredicates.set(definition, predicate)
    return predicate
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

const isIntElement = item => typeof item === "number" && Number.isInteger(item)
const isStringElement = item => typeof item === "string"

// Primitive tests equivalent to `type(value) === label`. Objects still go
// through type() because it unwraps SlimVariableType instances.
function numberViaType(value) {
    if (typeof value !== "object" || value === null) return false
    const kind = type(value)
    return kind === "int" || kind === "float"
}

function primitivePredicate(label) {
    const viaType = value => typeof value === "object" && value !== null && type(value) === label
    switch (label) {
        case "int": return value => typeof value === "number" ? Number.isInteger(value) : viaType(value)
        case "string": return value => typeof value === "string" || viaType(value)
        case "float": return value => typeof value === "number" ? !Number.isInteger(value) && !Number.isNaN(value) : viaType(value)
        case "number": return value => typeof value === "number" ? !Number.isNaN(value) : numberViaType(value)
        case "bool": return value => typeof value === "boolean" || viaType(value)
        case "bigint": return value => typeof value === "bigint" || viaType(value)
        case "symbol": return value => typeof value === "symbol" || viaType(value)
        case "null": return value => value === null
        case "undefined": return value => value === undefined
    }
    if (label in BUILTIN_CLASSES) return value => value instanceof BUILTIN_CLASSES[label]
    return value => type(value) === label
}

// Returns (value, resolved) => boolean. `resolved` is whatever the name
// resolves to at call time, or undefined when nothing is registered.
// `test.plain(value)` is the same test for resolved === undefined.
function compileTest(label) {
    const test = compileTestBody(label)
    if (test.plain === undefined) test.plain = value => test(value, undefined)
    return test
}

function compileTestBody(label) {
    if (label === "any") return ALWAYS

    if (label.length > 2 && label.startsWith("[") && label.endsWith("]")) {
        const parts = splitTypeList(label.slice(1, -1)).map(labelPredicate)
        return value => {
            if (!Array.isArray(value) || value.length !== parts.length) return false
            for (let i = 0; i < parts.length; i++) if (!parts[i](value[i])) return false
            return true
        }
    }

    const generic = label.indexOf("<")
    if (generic !== -1 && label.endsWith(">")) {
        const container = label.slice(0, generic).trim()
        const args = splitTypeList(label.slice(generic + 1, -1))
        const first = args[0] ?? "any"

        if (container === "Array") {
            const element = labelPredicate(first)
            const each = item => element(item)
            return value => Array.isArray(value) && value.every(each)
        }
        if (container === "Set") {
            const element = labelPredicate(first)
            return value => {
                if (!(value instanceof Set)) return false
                for (const item of value) if (!element(item)) return false
                return true
            }
        }
        if (container === "Map") {
            const keyType = labelPredicate(first)
            const valueType = labelPredicate(args[1] ?? "any")
            return value => {
                if (!(value instanceof Map)) return false
                for (const [key, entry] of value) if (!keyType(key) || !valueType(entry)) return false
                return true
            }
        }
        if (container === "Promise") return value => value instanceof Promise

        return compileTest(container)
    }

    if (label.endsWith("[]")) {
        const elementLabel = label.slice(0, -2)
        const emptyMatches = label === "null[]" || elementLabel === "any"
        // A failed fast check still defers to type() so wrapped values behave as before.
        const fallback = elementLabel === "int" ? value => value.every(isIntElement) || type(value) === label
            : elementLabel === "string" ? value => value.every(isStringElement) || type(value) === label
            : value => type(value) === label

        let lastResolved
        let lastEach
        const test = (value, resolved) => {
            if (!Array.isArray(value)) return false
            if (value.length === 0) return emptyMatches
            if (resolved === undefined) return fallback(value)

            if (resolved !== lastResolved || lastEach === undefined) {
                lastEach = resolvedPredicate(resolved)
                lastResolved = resolved
            }
            return value.every(lastEach)
        }
        test.plain = value => Array.isArray(value) && (value.length === 0 ? emptyMatches : fallback(value))
        return test
    }

    const enumSeparator = label.indexOf("::")
    if (enumSeparator !== -1) {
        const enumName = label.slice(0, enumSeparator)
        const member = label.slice(enumSeparator + 2)
        return (value, resolved) => {
            const enumDef = resolved ?? __enums__[enumName]
            return !!enumDef && enumDef[member] === value
        }
    }

    const primitive = primitivePredicate(label)
    let lastResolved
    let lastPredicate
    const test = (value, resolved) => {
        if (resolved === undefined) return primitive(value)
        if (resolved !== lastResolved || lastPredicate === undefined) {
            lastPredicate = resolvedPredicate(resolved)
            lastResolved = resolved
        }
        return lastPredicate(value)
    }
    test.plain = primitive
    return test
}

const labelPredicates = new Map()
const boundPredicates = new Map()

function nameOfLabel(label) {
    return label.replace(/(?:\[\])+$/, "").split("::")[0]
}

// Returns (value, resolve?) => boolean, cached per label. The optional
// `resolve` thunk comes from the reference and wins over name lookup.
function labelPredicate(label) {
    let predicate = labelPredicates.get(label)
    if (predicate) return predicate

    const test = compileTest(label)
    const name = nameOfLabel(label)
    let version = -1
    let found

    predicate = (value, resolve) => {
        if (typeof resolve === "function") return test(value, resolve())
        if (version !== registryVersion) {
            found = lookupName(name)
            version = registryVersion
        }
        return test(value, found)
    }
    labelPredicates.set(label, predicate)
    return predicate
}

// Same as labelPredicate(label) with no resolve thunk, flattened to one
// closure: while the registry is unchanged it calls the final test directly.
function boundPredicate(label) {
    let predicate = boundPredicates.get(label)
    if (predicate) return predicate

    const test = compileTest(label)
    const name = nameOfLabel(label)
    let version = -1
    let current

    predicate = value => {
        if (version !== registryVersion) {
            const found = lookupName(name)
            current = found === undefined ? test.plain : value => test(value, found)
            version = registryVersion
        }
        return current(value)
    }
    boundPredicates.set(label, predicate)
    return predicate
}

function referencePredicate(reference) {
    const label = typeof reference === "string" ? reference : reference?.label
    if (!label) return NEVER

    const resolve = typeof reference === "string" ? undefined : reference.resolve
    if (typeof resolve !== "function") return boundPredicate(label)

    const predicate = labelPredicate(label)
    return value => predicate(value, resolve)
}

// Compiles a whole specification (union, or intersection when marked) once.
function compileSpec(specification) {
    if (specification && specification.__slim_all__) {
        const all = specification.references.map(referencePredicate)
        return value => {
            for (let i = 0; i < all.length; i++) if (!all[i](value)) return false
            return true
        }
    }

    const any = (Array.isArray(specification) ? specification : [specification]).map(referencePredicate)
    if (any.length === 1) return any[0]
    return value => {
        for (let i = 0; i < any.length; i++) if (any[i](value)) return true
        return false
    }
}

let lastBoundLabel = ""
let lastBound = NEVER

function matchesReference(reference, value) {
    let label = reference
    if (typeof reference !== "string") {
        label = reference?.label
        if (!label) return false
        const resolve = reference.resolve
        if (typeof resolve === "function") return labelPredicate(label)(value, resolve)
    }

    if (label !== lastBoundLabel) {
        lastBound = boundPredicate(label)
        lastBoundLabel = label
    }
    return lastBound(value)
}

export function __type_matches__(specification, value) {
    if (Array.isArray(specification)) {
        if (specification.length === 1) return matchesReference(specification[0], value)
        for (let i = 0; i < specification.length; i++) {
            if (matchesReference(specification[i], value)) return true
        }
        return false
    }
    if (specification !== null && typeof specification === "object" && specification.__slim_all__) {
        const references = specification.references
        for (let i = 0; i < references.length; i++) {
            if (!matchesReference(references[i], value)) return false
        }
        return true
    }
    return matchesReference(specification, value)
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
const VARIABLE_TYPE = Symbol("slim.variableType")
const typedStaticFields = new WeakMap()

// Bindings are plain objects created per scope, so the declared
// specification lives on the binding itself; non-extensible ids fall back to
// a WeakMap. Only the specification is stored: labels are built on failure.
function setVariableType(bindingId, definition) {
    if (bindingId && (typeof bindingId === "object" || typeof bindingId === "function")) {
        if (Object.isExtensible(bindingId)) bindingId[VARIABLE_TYPE] = definition
        else scopedVariableTypes.set(bindingId, definition)
    } else {
        SlimVariableTypes[bindingId] = definition
    }
}

function getVariableType(bindingId) {
    if (bindingId && (typeof bindingId === "object" || typeof bindingId === "function")) {
        return bindingId[VARIABLE_TYPE] ?? scopedVariableTypes.get(bindingId)
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

// "any" is the only label the guard skips; it is a single-member specification.
function isAnySpecification(specification) {
    const references = specification && specification.__slim_all__
        ? specification.references
        : Array.isArray(specification) ? specification : [specification]
    return references.length === 1 && referenceLabel(references[0]) === "any"
}

// A specification that guards one value keeps that guard on itself, so the
// common case (a fresh specification per declaration) never touches a
// WeakMap. The first time it sees a second value the single entry moves into
// guardedValues, which then keeps the per-value cache exactly as before.
const GUARD_SLOT = Symbol("slim.guard")
const GUARD_SHARED = Symbol("slim.guard.shared")

function cachedGuard(value, specification) {
    if (specification !== null && typeof specification === "object") {
        const slot = specification[GUARD_SLOT]
        if (slot !== undefined && slot !== GUARD_SHARED) {
            if (slot.target === value) return slot.proxy
            const entries = guardedValues.get(slot.target) ?? new Map()
            entries.set(specification, slot.proxy)
            guardedValues.set(slot.target, entries)
            specification[GUARD_SLOT] = GUARD_SHARED
        }
    }
    return guardedValues.get(value)?.get(specification)
}

function storeGuard(value, specification, proxy) {
    if (specification !== null && typeof specification === "object" && Object.isExtensible(specification)) {
        const slot = specification[GUARD_SLOT]
        if (slot === undefined) {
            specification[GUARD_SLOT] = { target: value, proxy }
            return
        }
    }
    const entries = guardedValues.get(value) ?? new Map()
    entries.set(specification, proxy)
    guardedValues.set(value, entries)
}

// Callers have already matched `value` against `specification`.
function guardTypedValue(value, specification, varName) {
    if (!value || typeof value !== "object") return value
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return value
    if (isAnySpecification(specification)) return value

    const cached = cachedGuard(value, specification)
    if (cached) return cached

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

    storeGuard(value, specification, proxy)
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

    // verify, verifySafe and new share one compiled predicate; the slow
    // __typed__ pass only runs to explain a failure.
    let check = null
    const defaultKeys = Object.keys(mergedDefaults)
    const hasMethods = Object.keys(mergedMethods).length > 0
    const definition = {
        type: Struct,
        name,
        scheme: schemeArray,
        __defaults__: mergedDefaults,
        __methods__: mergedMethods,
        verify: object => check(object) ? object : __typed__(object, definition),
        verifySafe: object => check(object) ? { success: true, result: object } : __typed__(object, definition, "errorResult"),
        new: (values = {}) => {
            let merged
            if (defaultKeys.length === 0) {
                merged = { ...values }
            } else {
                const filled = {}
                for (let i = 0; i < defaultKeys.length; i++) {
                    const key = defaultKeys[i]
                    if (!(key in values)) filled[key] = mergedDefaults[key]()
                }
                merged = { ...filled, ...values }
            }
            const data = check(merged) ? merged : __typed__(merged, definition)
            return hasMethods ? Object.assign(Object.create(mergedMethods), data) : data
        }
    }

    check = structPredicate(definition)
    __structs__[name] = definition
    registryVersion++
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
    registryVersion++
    if (__RESERVED_DEFINES__.has(name)) throw new EnumError(`Name "${name}" is reserved`)
    globalThis[name] = definition
    return definition
}

export function __typed_variable__(value, specification, bindingId, varName = bindingId) {
    if (!__type_matches__(specification, value)) typeError(varName, __type_label__(specification), value)

    setVariableType(bindingId, specification)
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
    const expected = getVariableType(bindingId)
    if (!expected) return value
    if (!__type_matches__(expected, value)) typeError(varName, __type_label__(expected), value, "redefined")
    return guardTypedValue(value, expected, varName)
}

export function __typed_parameter__(value, specification, bindingId, varName, optional, message) {
    if (optional && (value === undefined || value === null)) {
        setVariableType(bindingId, specification)
        return value
    }

    if (!__type_matches__(specification, value)) {
        throw new ArgumentDeclarationTypeError(typeof message === "function" ? message() : message, { skipUserFrames: 1 })
    }

    setVariableType(bindingId, specification)
    return guardTypedValue(value, specification, varName)
}

export function __typed_static_field__(owner, field, value, specification, displayName) {
    if (!__type_matches__(specification, value)) typeError(displayName, __type_label__(specification), value)
    setStaticFieldType(owner, field, specification)
    return guardTypedValue(value, specification, displayName)
}

export function __typed_static_field_check__(owner, field, value, displayName) {
    const expected = getStaticFieldType(owner, field)
    if (!expected) return value
    if (!__type_matches__(expected, value)) {
        typeError(displayName, __type_label__(expected), value, "redefined")
    }
    return guardTypedValue(value, expected, displayName)
}

export function __argument_typed__(value, expectedType) {
    return __type_matches__(expectedType, value)
}

export function __type_def__(name, definition, properties = {}) {
    const inherited = properties.extends ?? null
    const matchesBase = definitionPredicate(definition)
    const customType = value => {
        if (inherited && !__type_matches__(inherited, value)) return false
        return matchesBase(value)
    }

    customType.__type__ = true
    customType.__slim_type_name__ = name
    customType.value = definition
    __custom_types__[name] = customType
    registryVersion++
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

    if (structPredicate(structDef)(value)) {
        return returnMethod === "errorResult" ? { success: true, result: value } : value
    }

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
