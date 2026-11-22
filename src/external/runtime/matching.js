import { StructPassedError, StructError, StructExpectError, ArgumentDeclarationTypeError, EnumError, LangError, StructResultError, TypeError_, RuntimeError, UseError, TypeDefError } from "../classErrors.js"
import { SlimVariableType, Struct, Enum, EnumValue, isSameType } from "../types.js"
import { ANY, readType, substituteType } from "../typeSyntax.js"
import { __custom_types__, __enums__, __structs__, __traits__ } from "./registry.js"
import { guardTargets } from "./guards.js"
import { __variant_is__, matchesVariant } from "./definitions.js"
import { __typed__ } from "./typed.js"


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

const ARRAY_KINDS = ["undefined", "string", "int", "float", "object", "enum", "struct", "array"]
export const VARIANT = Symbol("slim.variant")

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
    if (typeof obj === "string") return "string"
    if (typeof obj === "boolean") return "bool"
    if (typeof obj === "number") {
        if (Number.isNaN(obj)) return "NaN"
        return Number.isSafeInteger(obj) ? "int" : "float"
    }

    if (typeof obj === "object" && obj.nodeType === 1) return "element"
    if (typeof obj === "object" && obj.nodeType === 11) return "fragment"

    if (typeof obj === "function" && obj.__type__ === true) return "type"
    if (obj instanceof SlimVariableType) return obj.kind

    if (typeof obj === "object" && obj[VARIANT]) return "enum"

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

    if (typeof obj === "bigint") return "bigint"
    if (typeof obj === "symbol") return "symbol"

    if (typeof obj === "function" && /^\s*class\s+/.test(obj.toString())) return "class"
    if (typeof obj == "function") return "function"

    return undefined
}

const plainReferences = new Map()

export function __type_ref__(label, resolve = null, scope = null) {
    if (resolve || scope) return { __slim_type_ref__: true, label, resolve, scope }
    let reference = plainReferences.get(label)
    if (!reference) plainReferences.set(label, reference = { __slim_type_ref__: true, label, resolve })
    return reference
}

export function __type_spec__(...references) {
    if (references.length !== 1 || references[0]?.resolve !== null || references[0]?.scope) return references
    return references[0].specification ??= references
}

export function __type_spec_all__(...references) {
    return { __slim_all__: true, references }
}

export function referenceLabel(reference) {
    return typeof reference === "string" ? reference : reference?.label ?? String(reference)
}

function displayLabel(reference) {
    const label = referenceLabel(reference)
    if (typeof reference?.resolve !== "function" || !/\bthis\b/.test(label)) return label
    const resolved = reference.resolve()
    const name = typeof resolved === "function" ? resolved.name : resolved?.name
    return typeof name === "string" && name ? label.replace(/\bthis\b/g, name) : label
}

export function __type_label__(specification) {
    if (specification && specification.__slim_all__) {
        return specification.references.map(displayLabel).join(" & ")
    }
    const refs = Array.isArray(specification) ? specification : [specification]
    if (refs.length === 1) return displayLabel(refs[0])
    return refs.map(displayLabel).join(" | ")
}

let activeScope = null

export function lookupType(name) {
    if (activeScope && Object.hasOwn(activeScope, name) && activeScope[name] != null) return activeScope[name]
    return __custom_types__[name] ?? __structs__[name] ?? __enums__[name]
}

function scopeOf(reference) {
    if (typeof reference?.scope !== "function") return null
    try {
        return reference.scope()
    } catch {
        return null
    }
}

export function resolveReference(reference) {
    return typeof reference?.resolve === "function" ? reference.resolve() : undefined
}

function isClass(value) {
    return typeof value === "function" && /^\s*class\s+/.test(Function.prototype.toString.call(value))
}

export function matchesDefinition(definition, value) {
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
const SLIM_ERRORS = {
    LangError, StructError, StructPassedError, StructExpectError, StructResultError,
    ArgumentDeclarationTypeError, EnumError, RuntimeError, UseError, TypeDefError
}
export const UNSAFE_MEMBER_NAMES = new Set(["__proto__", "constructor", "prototype"])

export function exposeGlobal(name, definition) {
    const current = globalThis[name]
    if (current === undefined || current?.type === Struct || current?.type instanceof Enum || current?.__variants__) globalThis[name] = definition
}

export function hasField(object, key) {
    return Object.hasOwn(object, key) || (key in object && !(key in Object.prototype))
}

export function skipsOptional(object, key, optional) {
    return optional && (!hasField(object, key) || object[key] === undefined)
}

const isNumber = value => typeof value === "number" && !Number.isNaN(value)
const PRIMITIVE_CHECKS = new Map([
    ["number", isNumber],
    ["float", isNumber],
    ["int", Number.isSafeInteger],
    ["string", value => typeof value === "string"],
    ["bool", value => typeof value === "boolean"]
])

function matchesNamed(name, resolved, value) {
    if (resolved !== undefined) return matchesResolvedType(resolved, value)
    const primitive = PRIMITIVE_CHECKS.get(name)
    if (primitive) return primitive(value)
    if (name === "array") return Array.isArray(value)
    if (name === "function") return typeof value === "function"
    if (name === "Struct") return isStructDefinition(value, ANY)
    if (name === "Html" || name === "SafeHtml") return isMarkupValue(value)
    if (name === "TypeError") return value instanceof TypeError || value instanceof TypeError_
    if (Object.hasOwn(BUILTIN_CLASSES, name)) return value instanceof BUILTIN_CLASSES[name]
    if (Object.hasOwn(SLIM_ERRORS, name)) return value instanceof SLIM_ERRORS[name]
    const global = /^[A-Z]/.test(name) ? globalThis[name] : undefined
    if (typeof global === "function" && global.prototype && isClassLike(global)) return value instanceof global
    return type(value) === name
}

const MARKUP_CLASSES = new Set(["SafeHtml", "VNode"])

function isMarkupValue(value) {
    if (typeof value !== "object" || value === null) return false
    return typeof value.nodeType === "number" || MARKUP_CLASSES.has(value.constructor?.name)
}

function isStructDefinition(value, model) {
    if (typeof value !== "object" || value === null || value.type !== Struct) return false
    if (model.kind !== "named" && model.kind !== "generic") return true
    const wanted = lookupType(model.name)
    if (wanted?.type !== Struct) return true
    for (let definition = value; definition; definition = definition.parent) if (definition === wanted) return true
    return false
}

const NOT_INSTANCE_TYPES = new Set([Object, Function, Array, String, Number, Boolean, Symbol, BigInt])

function isClassLike(fn) {
    return !NOT_INSTANCE_TYPES.has(fn)
}

function matchesRecordKey(node, key) {
    if (matchesNode(node, key)) return true
    const number = Number(key)
    return String(number) === key && matchesNode(node, number)
}

export function matchesNode(node, value, resolved) {
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
            if (node.element.kind === "named" && resolved === undefined && lookupType(node.element.name) === undefined) {
                const primitive = PRIMITIVE_CHECKS.get(node.element.name)
                if (primitive) {
                    for (let index = 0; index < value.length; index++) {
                        if (!primitive(value[index])) return false
                    }
                    return true
                }
            }
            for (let index = 0; index < value.length; index++) {
                if (!matchesNode(node.element, value[index], resolved)) return false
            }
            return true
        case "generic": {
            const [first = ANY, second = ANY] = node.args
            if (node.name === "Set") return value instanceof Set && [...value].every(item => matchesNode(first, item))
            if (node.name === "Map") {
                return value instanceof Map && [...value].every(([key, entry]) =>
                    matchesNode(first, key) && matchesNode(second, entry))
            }
            if (node.name === "Promise") return value instanceof Promise
            if (node.name === "Struct" && lookupType("Struct") === undefined) return isStructDefinition(value, first)
            if (node.name === "Record") {
                if (typeof value !== "object" || value === null || Array.isArray(value)) return false
                return Object.entries(value).every(([key, entry]) => matchesRecordKey(first, key) && matchesNode(second, entry))
            }

            const definition = resolved ?? lookupType(node.name)
            if (definition?.__generic__) {
                const { params, label } = definition.__generic__
                return matchesNode(substituteTypeParams(label, params, node.args), value)
            }
            if (definition?.type === Struct) return matchesResolvedType(definition, value, node.args)
            if (definition?.__variants__) return matchesVariant(definition, value, node.args)
            if (definition && __traits__[node.name] === definition) return definition(value, node.args)
            return matchesNamed(node.name, definition, value)
        }
        case "function":
            return typeof value === "function"
        case "shape": {
            if (typeof value !== "object" || value === null || Array.isArray(value)) return false
            const names = new Set(node.fields.map(field => field.name))
            if (Object.keys(value).some(key => !names.has(key))) return false
            return node.fields.every(field => skipsOptional(value, field.name, field.optional)
                || (hasField(value, field.name) && matchesNode(field.type, value[field.name])))
        }
        case "keyof": {
            const keys = runtimeKeys(node.type, resolved)
            if (keys === null) return typeof value === "string" || typeof value === "number" || typeof value === "symbol"
            return typeof keys === "function" ? keys(value) : keys.includes(typeof value === "number" ? String(value) : value)
        }
        case "index":
            return matchesIndexed(node.object, node.index, value, resolved)
        case "enumMember": {
            const definition = resolved ?? __enums__[node.name]
            if (definition?.__variants__) return __variant_is__(value, definition[node.member])
            return !!definition && definition[node.member] === value
        }
        default:
            return matchesNamed(node.name, resolved ?? lookupType(node.name), value)
    }
}

function runtimeDefinition(node, resolved) {
    if (node.kind !== "named" && node.kind !== "generic") return undefined
    return resolved ?? lookupType(node.name)
}

function runtimeKeys(node, resolved) {
    if (node.kind === "shape") return node.fields.map(field => field.name)
    if (node.kind === "generic" && node.name === "Record") return key => matchesRecordKey(node.args[0] ?? ANY, String(key))
    const definition = runtimeDefinition(node, resolved)
    if (definition?.type === Struct) return [...Object.keys(definition.scheme), ...Object.keys(definition.__methods__ ?? {})]
    if (typeof definition === "function" && Array.isArray(definition.fields)) return [...definition.fields, ...(definition.methods ?? [])]
    return null
}

function matchesIndexed(object, index, value, resolved) {
    const keys = index.kind === "literal" ? [index.value]
        : index.kind === "union" && index.types.every(part => part.kind === "literal") ? index.types.map(part => part.value) : null
    if (object.kind === "generic" && object.name === "Record") return matchesNode(object.args[1] ?? ANY, value)
    if (object.kind === "array") return matchesNode(object.element, value)
    if (!keys) return true
    if (object.kind === "tuple") return keys.some(key => object.items[key] === undefined || matchesNode(object.items[key], value))
    if (object.kind === "shape") {
        return keys.some(key => {
            const field = object.fields.find(item => item.name === String(key))
            return !field || (field.optional && value === undefined) || matchesNode(field.type, value)
        })
    }
    const definition = runtimeDefinition(object, resolved)
    if (definition?.type !== Struct) return true
    return keys.some(key => {
        const field = definition.scheme[String(key)]
        if (!field) return typeof definition.__methods__?.[String(key)] !== "function" || typeof value === "function"
        return (field.optional && value === undefined) || __type_matches__(field.specification, value)
    })
}

function matchesReference(reference, value) {
    const label = typeof reference === "string" ? reference : reference?.label
    if (!label) return false
    const outer = activeScope
    activeScope = scopeOf(reference)
    try {
        return matchesNode(readType(label), value, resolveReference(reference))
    } finally {
        activeScope = outer
    }
}

export function __type_matches__(specification, value) {
    if (typeof value === "object" && value !== null) value = guardTargets.get(value) ?? value
    if (specification && specification.__slim_all__) {
        return specification.references.every(reference => matchesReference(reference, value))
    }
    const references = Array.isArray(specification) ? specification : [specification]
    return references.some(reference => matchesReference(reference, value))
}

export function substituteTypeParams(label, params, args) {
    const bound = new Map(params.map((param, index) => {
        const arg = args?.[index] ?? ANY
        return [param, typeof arg === "string" ? readType(arg) : arg]
    }))
    return substituteType(readType(label), bound)
}

export function previewValue(value) {
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

export function typeError(varName, expected, value, action = "assigned") {
    const actual = type(value)
    const preview = previewValue(value)
    if (action === "redefined") {
        throw new TypeError(`The variable "${varName}" is of type ${expected}, but it was redefined with type ${actual}: ${preview}`)
    }
    if (action === "mutated") {
        throw new TypeError(`The variable "${varName}" is of type ${expected}, but it was mutated into type ${actual}: ${preview}`)
    }
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value) && /\bint\b/.test(String(expected))) {
        throw new TypeError(`The "${varName}" is of type ${expected}, but was assigned ${preview}, which is too large to be an exact int (beyond ±2^53) — use bigint`)
    }
    throw new TypeError(`The "${varName}" is of type ${expected}, but was assigned a ${actual}: ${preview}`)
}
