
import {
    StructPassedError, StructError, StructExpectError, ArgumentDeclarationTypeError,
    EnumError, formatError, resolveErrorLocation
} from "./classErrors.js"
import {
    SlimVariableType, SlimVariableTypes, Struct, Component, Enum, EnumValue,
    isSameType
} from "./types.js"
import { ANY, readType, formatType, substituteType } from "./typeSyntax.js"
import { REACTIVE_GLOBALS, Signal, __computed__, batch } from "./reactive.js"

export { effect, watch, untrack, batch, onCleanup, resource, createContext, provide, inject, catchError } from "./reactive.js"

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

const RELEASE = typeof process !== "undefined" && process.env?.SLIM_RELEASE === "1"

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

function unwrap(arg) {
    if (!Type.isTyped(arg)) return arg
    if ("value" in arg) return arg.value
    if ("scheme" in arg) return arg.scheme
    return arg
}

export const log = (...args) => console.log(...args.map(unwrap))
export const warn = (...args) => console.warn(...args.map(unwrap))
export const error = (...args) => console.error(...args.map(unwrap))
export const info = (...args) => console.info(...args.map(unwrap))
export const debug = (...args) => console.log(...args)

export const PI = Math.PI

const __test_stats__ = { passed: 0, failed: 0 }

const testGroups = []
let testQueue = Promise.resolve()

export function describe(name, fn) {
    testGroups.push(name)
    try {
        fn()
    } finally {
        testGroups.pop()
    }
}

export function test(name, fn) {
    const title = [...testGroups, name].join(" › ")

    testQueue = testQueue.then(async () => {
        try {
            await fn()
            __test_stats__.passed++
            console.log(`  ✓ ${title}`)
        } catch (err) {
            __test_stats__.failed++
            if (typeof process !== "undefined") process.exitCode = 1
            console.log(`  ✗ ${title}\n      ${err?.message ?? err}`)
        }
    })
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
        return obj instanceof SlimVariableType || obj instanceof EnumValue || obj instanceof Struct
    }
    static isAnyArray(obj) {
        return Array.isArray(obj)
    }

    static isRegistredCustom(name) {
        return Object.hasOwn(__custom_types__, name)
    }

    static Customs = __custom_types__
}
export class Debug {
    static log(...args) {
        console.log(`[SLIM]`, ...args)
    }
}

const ARRAY_KINDS = ["undefined", "string", "int", "float", "object", "enum", "struct", "array"]

function arrayType(items) {
    if (items.length === 0) return "null[]"

    const kinds = new Set(items.map(item => type(item)))
    if (kinds.size === 1) {
        const [kind] = kinds
        if (kind === "undefined") return "null[]"
        if (ARRAY_KINDS.includes(kind)) return `${kind}[]`
    }
    if ([...kinds].every(kind => kind === "int" || kind === "float" || kind === "NaN")) return "number[]"
    return "array"
}

export function type(obj) {
    if (obj === null) return "null"
    if (obj === undefined) return "undefined"
    if (Number.isNaN(obj)) return "NaN"

    if (typeof obj === "object" && obj.nodeType === 1) return "element"
    if (typeof obj === "object" && obj.nodeType === 11) return "fragment"

    if (typeof obj === "function" && obj.__type__ === true) return "type"
    if (obj instanceof SlimVariableType) return obj.kind

    if (typeof obj === "object" && !Array.isArray(obj)) {
        if (obj.type === Struct) return "struct"
        if (obj.type instanceof Enum || obj instanceof EnumValue) return "enum"
    }

    if (typeof obj === "function" && obj.__component__ === true) return "component"
    if (Array.isArray(obj)) return arrayType(obj)

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

function lookupType(name) {
    return __custom_types__[name] ?? __structs__[name] ?? __enums__[name]
}

function resolveReference(reference) {
    return typeof reference?.resolve === "function" ? reference.resolve() : undefined
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

function matchesResolvedType(resolved, value, typeArgs = null) {
    if (resolved === undefined || resolved === null) return false
    if (resolved.type === Struct) return __typed__(value, resolved, "errorResult", typeArgs).success
    if (resolved.type instanceof Enum) return resolved.has(value)
    if (resolved instanceof EnumValue) return resolved === value
    if (typeof resolved === "function" && resolved.__type__ === true) return resolved(value) === true
    return matchesDefinition(resolved, value)
}

const BUILTIN_CLASSES = { Map, Set, Date, Promise, RegExp, Error }

function matchesNamed(name, resolved, value) {
    if (resolved !== undefined) return matchesResolvedType(resolved, value)
    if (name === "number" || name === "float") return typeof value === "number" && !Number.isNaN(value)
    if (name === "array") return Array.isArray(value)
    if (name in BUILTIN_CLASSES) return value instanceof BUILTIN_CLASSES[name]
    return type(value) === name
}

function matchesNode(node, value, resolved) {
    switch (node.kind) {
        case "any":
            return true
        case "union":
            return node.types.some(part => matchesNode(part, value))
        case "intersection":
            return node.types.every(part => matchesNode(part, value))
        case "literal":
            return value === node.value
        case "tuple":
            return Array.isArray(value) && value.length === node.items.length &&
                node.items.every((part, index) => matchesNode(part, value[index]))
        case "array":
            if (!Array.isArray(value)) return false
            if (node.element.kind === "named" && node.element.name === "null") return value.every(item => item == null)
            return value.every(item => matchesNode(node.element, item, resolved))
        case "generic": {
            const [first = ANY, second = ANY] = node.args
            if (node.name === "Set") return value instanceof Set && [...value].every(item => matchesNode(first, item))
            if (node.name === "Map") {
                return value instanceof Map && [...value].every(([key, entry]) =>
                    matchesNode(first, key) && matchesNode(second, entry))
            }
            if (node.name === "Promise") return value instanceof Promise

            const definition = resolved ?? lookupType(node.name)
            if (definition?.type === Struct) return matchesResolvedType(definition, value, node.args)
            return matchesNamed(node.name, definition, value)
        }
        case "function":
            return typeof value === "function"
        case "enumMember": {
            const definition = resolved ?? __enums__[node.name]
            return !!definition && definition[node.member] === value
        }
        default:
            return matchesNamed(node.name, resolved ?? lookupType(node.name), value)
    }
}

function matchesReference(reference, value) {
    const label = typeof reference === "string" ? reference : reference?.label
    if (!label) return false
    return matchesNode(readType(label), value, resolveReference(reference))
}

export function __type_matches__(specification, value) {
    if (specification && specification.__slim_all__) {
        return specification.references.every(reference => matchesReference(reference, value))
    }
    const references = Array.isArray(specification) ? specification : [specification]
    return references.some(reference => matchesReference(reference, value))
}

function substituteTypeParams(label, params, args) {
    const bound = new Map(params.map((param, index) => {
        const arg = args?.[index] ?? ANY
        return [param, typeof arg === "string" ? readType(arg) : arg]
    }))
    return substituteType(readType(label), bound)
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

const isIndex = property => typeof property === "string" && /^\d+$/.test(property)

function propertyCheck(specification) {
    if (!Array.isArray(specification) || specification.length !== 1) return null

    const reference = specification[0]
    const node = readType(referenceLabel(reference))
    const resolved = resolveReference(reference)

    if (node.kind === "array") {
        return (target, property) =>
            !isIndex(property) || !(property in target) || matchesNode(node.element, target[property], resolved)
    }

    const definition = node.kind === "named" ? resolved ?? lookupType(node.name) : null
    if (definition?.type !== Struct || definition.typeParams.length > 0) return null

    return (target, property) => {
        const field = definition.scheme[property]
        if (!field) return false
        if (!(property in target)) return field.optional
        return __type_matches__(field.specification, target[property])
    }
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
    const quick = propertyCheck(specification)
    const check = (target, property, descriptor) => {
        if (quick ? quick(target, property) : __type_matches__(specification, target)) return
        restore(target, property, descriptor)
        typeError(varName, __type_label__(specification), target, "mutated")
    }
    const proxy = new Proxy(value, {
        set(target, property, next) {
            const descriptor = Object.getOwnPropertyDescriptor(target, property)
            const length = Array.isArray(target) ? target.length : -1
            const succeeded = Reflect.set(target, property, next, target)
            if (!succeeded) return false
            try {
                check(target, property, descriptor)
            } catch (error) {
                if (length !== -1) target.length = length
                throw error
            }
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


export function __def_struct__(
    name, schema, specifications = {}, defaults = {}, extendsName = null, methods = {},
    typeParams = null, readonly = null
) {
    if (__RESERVED_DEFINES__.has(name)) throw new StructError(`Name "${name}" is reserved`)

    const parent = extendsName ? __structs__[extendsName] : null
    if (extendsName && !parent) throw new StructError(`Struct "${name}" extends unknown struct "${extendsName}"`)

    const schemeArray = parent ? { ...parent.scheme } : {}
    const mergedDefaults = parent ? { ...parent.__defaults__, ...defaults } : defaults
    const mergedMethods = parent ? { ...parent.__methods__, ...(methods ?? {}) } : methods ?? {}
    const readonlyFields = new Set([...(parent?.readonly ?? []), ...(readonly ?? [])])

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
        typeParams: typeParams ?? [],
        readonly: [...readonlyFields],
        __defaults__: mergedDefaults,
        __methods__: mergedMethods,
        verify: (object, typeArgs = null) => __typed__(object, definition, "default", typeArgs),
        verifySafe: (object, typeArgs = null) => __typed__(object, definition, "errorResult", typeArgs),
        new: (values = {}) => {
            const filled = {}
            for (const key of Object.keys(mergedDefaults)) {
                if (!(key in values)) filled[key] = mergedDefaults[key]()
            }
            const data = __typed__({ ...filled, ...values }, definition)
            for (const [field, { type: label }] of Object.entries(schemeArray)) {
                if (field in data) data[field] = toStruct(data[field], readType(label))
            }
            const instance = Object.keys(mergedMethods).length ? Object.assign(Object.create(mergedMethods), data) : data

            for (const field of readonlyFields) {
                if (field in instance) {
                    Object.defineProperty(instance, field, { value: instance[field], enumerable: true, writable: false, configurable: false })
                }
            }
            return instance
        }
    }

    __structs__[name] = definition
    globalThis[name] = definition
    return definition
}

export function __def_enum__(name, schema) {
    if (__RESERVED_DEFINES__.has(name)) throw new EnumError(`Name "${name}" is reserved`)

    const values = { ...schema }
    const definition = {
        type: new Enum(name),
        name,
        scheme: () => values,
        values: () => Object.values(values),
        keys: () => Object.keys(values),
        has: value => Object.values(values).some(item =>
            value === item || (value instanceof EnumValue && value.value === item)
        ),
        from: value => {
            const raw = value instanceof EnumValue ? value.value : value
            const key = Object.keys(values).find(key => values[key] === raw)
            if (key === undefined) throw new EnumError(`${previewValue(value)} is not a value of enum "${name}"`)
            return definition[key]
        }
    }

    Object.keys(values).forEach(key => {
        definition[key] = new EnumValue(values[key])
    })

    __enums__[name] = definition
    globalThis[name] = definition
    return definition
}

export function __typed_variable__(value, specification, bindingId, varName = bindingId) {
    if (RELEASE) return value
    const expected = __type_label__(specification)
    if (!__type_matches__(specification, value)) typeError(varName, expected, value)

    setVariableType(bindingId, {
        expected: specification,
        label: expected,
        name: varName
    })
    return guardTypedValue(value, specification, varName)
}

const isPlainObject = value =>
    value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype

function structNamed(type) {
    if (type.kind === "union") {
        const found = type.types.map(structNamed).filter(Boolean)
        return found.length === 1 ? found[0] : null
    }
    if (type.kind !== "named" && type.kind !== "generic") return null
    const definition = lookupType(type.name)
    return definition?.type === Struct ? definition : null
}

function toStruct(value, type) {
    if (Array.isArray(value) && type.kind === "array" && structNamed(type.element)) {
        return value.map(item => toStruct(item, type.element))
    }
    if (!isPlainObject(value)) return value
    const definition = structNamed(type)
    return definition ? definition.new(value) : value
}

export function __match_type__(value, label) {
    return matchesNode(readType(label), value)
}

export function __as_struct__(value, label) {
    return toStruct(value, readType(label))
}

export function __typed_return__(value, specification, fnName) {
    if (RELEASE) return value

    if (!__type_matches__(specification, value)) {
        throw new TypeError(
            `function "${fnName}" must return ${__type_label__(specification)}, got ${type(value)}: ${previewValue(value)}`
        )
    }
    return value
}

export function __typed_pattern__(value, typeLabel) {
    if (RELEASE) return value
    if (!__type_matches__(typeLabel, value)) {
        throw new TypeError(`destructured value does not match type ${typeLabel}: ${previewValue(value)}`)
    }
    return value
}

export function __typed_variable_check__(bindingId, value, varName = bindingId) {
    if (RELEASE) return value
    const typed = getVariableType(bindingId)
    if (!typed) return value
    if (!__type_matches__(typed.expected, value)) typeError(varName, typed.label, value, "redefined")
    return guardTypedValue(value, typed.expected, varName)
}

export function __typed_parameter__(value, specification, bindingId, varName, optional, message) {
    if (RELEASE) return value
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
    if (RELEASE) return value
    const label = __type_label__(specification)
    if (!__type_matches__(specification, value)) typeError(displayName, label, value)
    setStaticFieldType(owner, field, { expected: specification, label })
    return guardTypedValue(value, specification, displayName)
}

export function __typed_static_field_check__(owner, field, value, displayName) {
    if (RELEASE) return value
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

export function __typed__(value, structName, returnMethod = "default", typeArgs = null) {
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

        const params = structDef.typeParams ?? []
        const expected = params.length
            ? substituteTypeParams(__type_label__(definition.specification), params, typeArgs)
            : null
        const fits = expected === null
            ? __type_matches__(definition.specification, value[field])
            : matchesNode(expected, value[field])

        if (!fits) {
            const label = expected ? formatType(expected) : __type_label__(definition.specification)
            return fail(new StructError(
                `"${name}.${field}" expected ${label}, got ${type(value[field])}: ${previewValue(value[field])}`
            ), {
                name,
                field,
                expected: label,
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
    return __sizeof__(obj) === 0
}

export function __copyof__(obj) {
    if (Array.isArray(obj)) return [...obj]
    if (Type.isObj(obj)) return { ...obj }
    throw new TypeError(`Copy target must be object or array, not ${type(obj)}`)
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

    for (const key of Reflect.ownKeys(obj)) {
        const descriptor = Object.getOwnPropertyDescriptor(obj, key)
        const value = descriptor.value
        if (!value || typeof value !== "object") continue

        const locked = __lock_object__(value)
        if (descriptor.writable) obj[key] = locked
    }

    if (!ArrayBuffer.isView(obj)) Object.freeze(obj)

    return wrapped
}


const FORM_NAMES = new Set(["errors", "valid", "values", "submit", "reset", "submitting", "touched"])
const isBlank = value => value === undefined || value === null || value === ""

function emptyValue(label) {
    if (label === "bool") return false
    return ""
}

export function createForm(definition, { initial = {}, messages = {} } = {}) {
    if (!definition?.scheme) throw new TypeError("createForm takes a struct: createForm(Signup)")
    const scheme = definition.scheme
    const fields = Object.keys(scheme)
    for (const field of fields) {
        if (FORM_NAMES.has(field)) throw new TypeError(`createForm: the field "${field}" of "${definition.name}" has the name of a form property, rename it`)
    }

    const startValue = field => field in initial ? initial[field]
        : field in definition.__defaults__ ? definition.__defaults__[field]()
        : emptyValue(scheme[field].type)
    const values = Object.fromEntries(fields.map(field => [field, new Signal(startValue(field))]))
    const touched = Object.fromEntries(fields.map(field => [field, new Signal(false)]))
    const submitted = new Signal(false)
    const submitting = new Signal(false)

    const coerce = (field, value) => {
        const { specification } = scheme[field]
        if (typeof value !== "string" || value.trim() === "" || __type_matches__(specification, value)) return value
        const number = Number(value)
        return !Number.isNaN(number) && __type_matches__(specification, number) ? number : value
    }

    const problems = Object.fromEntries(fields.map(field => [field, __computed__(() => {
        const { specification, optional } = scheme[field]
        const value = values[field].v
        if (isBlank(value)) return optional ? null : messages[field] ?? "required"
        if (__type_matches__(specification, value)) return null
        return messages[field] ?? `expected ${__type_label__(specification)}`
    })]))

    const errors = {}
    for (const field of fields) {
        Object.defineProperty(errors, field, {
            enumerable: true,
            get: () => touched[field].v || submitted.v ? problems[field].v : null
        })
    }

    const valid = __computed__(() => fields.every(field => problems[field].v === null))
    const snapshot = () => {
        const data = {}
        for (const field of fields) {
            const value = values[field].peek()
            if (!(isBlank(value) && scheme[field].optional)) data[field] = value
        }
        return data
    }

    const form = {
        errors,
        get valid() { return valid.v },
        get values() { return snapshot() },
        get submitting() { return submitting.v },
        touched: field => touched[field]?.v ?? false,
        submit(handler) {
            return event => {
                event?.preventDefault?.()
                submitted.v = true
                if (!valid.peek()) return
                const result = handler(definition.new(snapshot()))
                if (result && typeof result.then === "function") {
                    submitting.v = true
                    return result.finally(() => { submitting.v = false })
                }
                return result
            }
        },
        reset(next = {}) {
            batch(() => {
                for (const field of fields) {
                    values[field].v = field in next ? next[field] : startValue(field)
                    touched[field].v = false
                }
                submitted.v = false
            })
        }
    }
    for (const field of fields) {
        Object.defineProperty(form, field, {
            enumerable: true,
            get: () => values[field].v,
            set: value => batch(() => {
                values[field].v = coerce(field, value)
                touched[field].v = true
            })
        })
    }
    return form
}

Object.assign(globalThis, {
    log, warn, error, info, debug,

    createForm,

    type,

    Component, Type, Struct,

    onError, test, describe, assert, assertEqual,

    __def_struct__, __def_enum__, __typed__, __handle_async_error__,
    __handle_sync_error__, __sizeof__, __is_empty__, __lock_object__,
    __typed_variable__, __typed_variable_check__, __typed_pattern__, __typed_return__, __as_struct__,
    __intdiv__, __copyof__, __match_eq__, __match_type__,
    __typed_parameter__, __typed_static_field__, __typed_static_field_check__,
    __type_def__, __argument_typed__,
    __type_ref__, __type_spec__, __type_spec_all__, __type_matches__, __type_label__,

    StructError, StructPassedError, StructExpectError, ArgumentDeclarationTypeError,

    PI,

    ...REACTIVE_GLOBALS
})
