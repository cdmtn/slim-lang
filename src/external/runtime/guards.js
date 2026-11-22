import { SlimVariableTypes, Struct } from "../types.js"
import { ANY, readType } from "../typeSyntax.js"
import { __traits__ } from "./registry.js"
import { __type_label__, __type_matches__, lookupType, matchesNode, referenceLabel, resolveReference, skipsOptional, typeError } from "./matching.js"

const guardedValues = new WeakMap()
export const guardTargets = new WeakMap()
const scopedVariableTypes = new WeakMap()
const typedStaticFields = new WeakMap()

export function setVariableType(bindingId, definition) {
    if (bindingId && (typeof bindingId === "object" || typeof bindingId === "function")) {
        scopedVariableTypes.set(bindingId, definition)
    } else {
        SlimVariableTypes[bindingId] = definition
    }
}

export function getVariableType(bindingId) {
    if (bindingId && (typeof bindingId === "object" || typeof bindingId === "function")) {
        return scopedVariableTypes.get(bindingId)
    }
    return SlimVariableTypes[bindingId]
}

export function setStaticFieldType(owner, field, definition) {
    const fields = typedStaticFields.get(owner) ?? new Map()
    fields.set(field, definition)
    typedStaticFields.set(owner, fields)
}

export function getStaticFieldType(owner, field) {
    return typedStaticFields.get(owner)?.get(field)
}

const isIndex = property => typeof property === "string" && /^\d+$/.test(property)
const isEnumerable = Object.prototype.propertyIsEnumerable

function matchesRecordKey(node, key) {
    if (matchesNode(node, key)) return true
    const number = Number(key)
    return String(number) === key && matchesNode(node, number)
}

function traitCheck(trait) {
    const fields = new Map(trait.schema.map(([field, label, optional]) => [field, { type: readType(label), optional }]))
    const methods = new Set(trait.methods)
    return (target, property) => {
        const field = fields.get(property)
        if (field) {
            if (field.optional && target[property] === undefined) return true
            return property in target && matchesNode(field.type, target[property])
        }
        return !methods.has(property) || typeof target[property] === "function"
    }
}

function propertyCheck(specification) {
    if (!Array.isArray(specification) || specification.length !== 1) return null

    const reference = specification[0]
    const node = readType(referenceLabel(reference))
    const resolved = resolveReference(reference)

    if (node.kind === "array") {
        return (target, property) =>
            !isIndex(property) || !(property in target) || matchesNode(node.element, target[property], resolved)
    }

    if (node.kind === "generic" && node.name === "Record" && resolved === undefined && lookupType("Record") === undefined) {
        const [key = ANY, entry = ANY] = node.args
        return (target, property) => typeof property !== "string" || !isEnumerable.call(target, property) ||
            (matchesRecordKey(key, property) && matchesNode(entry, target[property]))
    }

    const definition = node.kind === "named" ? resolved ?? lookupType(node.name) : null
    if (definition && __traits__[node.name] === definition && Array.isArray(definition.schema) && !definition.typeParams?.length) {
        return traitCheck(definition)
    }
    if (definition?.type !== Struct || definition.typeParams.length > 0) return null

    return (target, property) => {
        const field = definition.scheme[property]
        if (!field) return false
        if (skipsOptional(target, property, field.optional)) return true
        if (!(property in target)) return false
        return __type_matches__(field.specification, target[property])
    }
}

const readonlyViews = new WeakMap()

function readonlyView(value, varName, label) {
    const cached = readonlyViews.get(value)
    if (cached) return cached
    const refuse = () => { throw new TypeError(`"${varName}" is ${label}: it can't be changed`) }
    const view = new Proxy(value, { set: refuse, deleteProperty: refuse, defineProperty: refuse })
    readonlyViews.set(value, view)
    return view
}

export function guardTypedValue(value, specification, varName) {
    if (!value || typeof value !== "object") return value
    const label = __type_label__(specification)
    if (label === "any") return value
    if (readType(label).readonly) return readonlyView(value, varName, label)
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return value

    const key = `${label}\0${varName}`
    const cached = guardedValues.get(value)
    if (cached?.has(key)) return cached.get(key)

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
    entries.set(key, proxy)
    guardedValues.set(value, entries)
    guardTargets.set(proxy, value)
    return proxy
}
