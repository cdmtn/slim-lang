import { StructError, EnumError } from "../classErrors.js"
import { Struct, Enum, EnumValue } from "../types.js"
import { readType } from "../typeSyntax.js"
import { RELEASE, __RESERVED_DEFINES__, __custom_types__, __enums__, __structs__, __traits__ } from "./registry.js"
import { UNSAFE_MEMBER_NAMES, VARIANT, exposeGlobal, hasField, lookupType, matchesNode, previewValue, substituteTypeParams, type } from "./matching.js"
import { STRUCT_INSTANCES, __typed__, toStruct } from "./typed.js"

export function __uses__() {}

export function __def_trait__(name, schema, required = {}, defaults = {}, typeParams = null) {
    if (__RESERVED_DEFINES__.has(name)) throw new StructError(`Name "${name}" is reserved`)

    const fields = Object.entries(schema).map(([key, label]) => key.startsWith("*") ? [key.slice(1).trim(), label, true] : [key, label, false])
    const methods = Object.keys(required)
    const trait = (value, typeArgs = []) => {
        if (value === null || value === undefined) return false
        const target = Object(value)
        return fields.every(([field, label, optional]) => (optional && target[field] === undefined) || (field in target
            && matchesNode(typeParams?.length ? substituteTypeParams(label, typeParams, typeArgs) : readType(label), target[field])))
            && methods.every(method => typeof target[method] === "function")
    }
    trait.__type__ = true
    trait.__slim_type_name__ = name
    trait.fields = fields.map(([field]) => field)
    trait.schema = fields
    trait.typeParams = typeParams ?? []
    trait.methods = methods
    trait.defaults = defaults
    __traits__[name] = trait
    __custom_types__[name] = trait
    return trait
}

function withTraits(owner, inherited, own, traits, ErrorType) {
    const merged = { ...inherited }
    const names = (traits ?? []).map(trait => trait.replace(/<[\s\S]*$/, ""))
    for (const traitName of names) {
        const trait = __traits__[traitName]
        if (!trait) throw new ErrorType(`${owner} implements unknown trait "${traitName}"`)
        for (const [method, fn] of Object.entries(trait.defaults)) if (!(method in merged)) merged[method] = fn
    }
    Object.assign(merged, own)
    for (const traitName of names) {
        const missing = __traits__[traitName].methods.find(method => typeof merged[method] !== "function")
        if (missing) throw new ErrorType(`${owner} doesn't implement "${missing}()" from trait "${traitName}"`)
    }
    return merged
}

export function __def_struct__(
    name, schema, specifications = {}, defaults = {}, extendsName = null, methods = {},
    typeParams = null, readonly = null, traits = null
) {
    if (__RESERVED_DEFINES__.has(name)) throw new StructError(`Name "${name}" is reserved`)

    const parent = extendsName ? __structs__[extendsName] : null
    if (extendsName && !parent) throw new StructError(`Struct "${name}" extends unknown struct "${extendsName}"`)

    const schemeArray = parent ? { ...parent.scheme } : {}
    const mergedDefaults = parent ? { ...parent.__defaults__, ...defaults } : defaults
    const inherited = parent ? { ...parent.__methods__ } : {}
    const mergedMethods = withTraits(`Struct "${name}"`, inherited, methods ?? {}, traits, StructError)
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
            specification: (Object.hasOwn(specifications, fieldName) ? specifications[fieldName] : undefined) ?? schema[item],
            optional
        }
    })

    const definition = {
        type: Struct,
        name,
        parent,
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
                if (!hasField(values, key) || values[key] === undefined) filled[key] = mergedDefaults[key]()
            }
            const data = __typed__(Object.assign({ ...filled, ...values }, filled), definition)
            for (const [field, { type: label }] of Object.entries(schemeArray)) {
                if (Object.hasOwn(data, field)) data[field] = toStruct(data[field], readType(label))
            }
            const instance = Object.keys(mergedMethods).length ? Object.assign(Object.create(mergedMethods), data) : data

            for (const field of readonlyFields) {
                if (Object.hasOwn(instance, field)) {
                    Object.defineProperty(instance, field, { value: instance[field], enumerable: true, writable: false, configurable: false })
                }
            }
            STRUCT_INSTANCES.set(instance, definition)
            return instance
        }
    }

    __structs__[name] = definition
    exposeGlobal(name, definition)
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
        if (Object.hasOwn(definition, key) || UNSAFE_MEMBER_NAMES.has(key)) {
            throw new EnumError(`Enum "${name}" can't have a member named "${key}": the name is reserved`)
        }
        definition[key] = new EnumValue(values[key])
    })

    __enums__[name] = definition
    exposeGlobal(name, definition)
    return definition
}

const VARIANT_INSPECT = Symbol.for("nodejs.util.inspect.custom")

const VariantPrototype = {
    get $tag() {
        return this[VARIANT].tag
    },
    toString() {
        const { enum: name, tag, values } = this[VARIANT]
        return values.length ? `${name}.${tag}(${values.map(previewValue).join(", ")})` : `${name}.${tag}`
    },
    toJSON() {
        return { $tag: this[VARIANT].tag, ...this }
    },
    [VARIANT_INSPECT](depth, options, inspect) {
        const { enum: name, tag, values } = this[VARIANT]
        if (!values.length) return `${name}.${tag}`
        const show = typeof inspect === "function" ? value => inspect(value, options) : previewValue
        return `${name}.${tag}(${values.map(show).join(", ")})`
    }
}

function makeVariant(prototype, name, tag, fields, values) {
    const variant = Object.create(prototype)
    Object.defineProperty(variant, VARIANT, { value: { enum: name, tag, values } })
    fields.forEach((field, index) => { variant[field] = values[index] })
    return Object.freeze(variant)
}

export function matchesVariant(definition, value, typeArgs) {
    if (!definition.has(value)) return false
    const fields = definition.__variants__[value[VARIANT].tag]
    if (!fields || !typeArgs?.length) return true
    return fields.every(([, label], index) =>
        matchesNode(substituteTypeParams(label, definition.typeParams, typeArgs), value[VARIANT].values[index]))
}

export function __def_variants__(name, variants, typeParams = null, methods = null, traits = null, release = false, global = true) {
    if (__RESERVED_DEFINES__.has(name)) throw new EnumError(`Name "${name}" is reserved`)

    const prototype = Object.assign(Object.create(VariantPrototype), withTraits(`Enum "${name}"`, {}, methods ?? {}, traits, EnumError))
    const params = typeParams ?? []
    const definition = {
        type: new Enum(name),
        name,
        typeParams: params,
        __variants__: variants,
        keys: () => Object.keys(variants),
        values: () => Object.keys(variants).map(tag => definition[tag]),
        has: value => value?.[VARIANT]?.enum === name && Object.hasOwn(variants, value[VARIANT].tag)
    }

    definition.fromJSON = data => {
        if (typeof data === "string" && variants[data] === null) return definition[data]
        if (typeof data !== "object" || data === null) throw new EnumError(`${previewValue(data)} is not a value of enum "${name}"`)
        if (data[VARIANT]) {
            if (definition.has(data)) return data
            throw new EnumError(`${previewValue(data)} is not a value of enum "${name}"`)
        }
        const tag = data.$tag
        if (typeof tag !== "string" || !Object.hasOwn(variants, tag)) throw new EnumError(`${previewValue(tag)} is not a member of enum "${name}"`)
        const fields = variants[tag]
        if (fields === null) return definition[tag]
        return definition[tag](...fields.map(([field, label]) => fromJSONValue(data[field], readType(label))))
    }

    for (const [tag, fields] of Object.entries(variants)) {
        if (Object.hasOwn(definition, tag) || UNSAFE_MEMBER_NAMES.has(tag)) {
            throw new EnumError(`Enum "${name}" can't have a member named "${tag}": the name is reserved`)
        }
        if (fields === null) {
            definition[tag] = makeVariant(prototype, name, tag, [], [])
            continue
        }
        const names = fields.map(([field]) => field)
        const checks = fields.map(([field, label]) => [field, label, substituteTypeParams(label, params, [])])
        const create = (...values) => {
            if (values.length !== fields.length) {
                throw new TypeError(`${name}.${tag} takes ${fields.length} value${fields.length === 1 ? "" : "s"}, got ${values.length}`)
            }
            if (!RELEASE && !release) {
                checks.forEach(([field, label, expected], index) => {
                    if (!matchesNode(expected, values[index])) {
                        throw new TypeError(`${name}.${tag}: "${field}" expected ${label}, got ${type(values[index])}: ${previewValue(values[index])}`)
                    }
                })
            }
            return makeVariant(prototype, name, tag, names, values)
        }
        create.tag = tag
        create.enumName = name
        create.fields = names
        definition[tag] = create
    }

    __enums__[name] = definition
    if (global) exposeGlobal(name, definition)
    return definition
}

function fromJSONValue(value, type) {
    if (type.kind === "array" && Array.isArray(value)) return value.map(item => fromJSONValue(item, type.element))
    if (type.kind === "union") {
        const part = type.types.find(option => (option.kind === "named" || option.kind === "generic") && lookupType(option.name)?.__variants__)
        return part ? fromJSONValue(value, part) : value
    }
    const definition = (type.kind === "named" || type.kind === "generic") ? lookupType(type.name) : null
    if (definition?.__variants__ && value !== null && typeof value === "object" && !value[VARIANT]) return definition.fromJSON(value)
    if (definition?.type === Struct) return toStruct(value, type)
    return value
}

export function __variant_is__(value, variant) {
    if (typeof variant !== "function") return value === variant
    const info = value?.[VARIANT]
    return !!info && info.tag === variant.tag && info.enum === variant.enumName
}

export function __variant_value__(value, variant, index) {
    return value[VARIANT].values[index]
}
