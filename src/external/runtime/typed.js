import { StructPassedError, StructError, StructExpectError, ArgumentDeclarationTypeError } from "../classErrors.js"
import { Struct } from "../types.js"
import { readType, formatType } from "../typeSyntax.js"
import { RELEASE, __custom_types__, __structs__ } from "./registry.js"
import { __type_label__, __type_matches__, hasField, lookupType, matchesDefinition, matchesNode, previewValue, skipsOptional, substituteTypeParams, type, typeError } from "./matching.js"
import { getStaticFieldType, getVariableType, guardTypedValue, setStaticFieldType, setVariableType } from "./guards.js"

const isNumber = value => typeof value === "number" && value === value
const PRIMITIVE_TESTS = {
    number: isNumber,
    float: isNumber,
    int: value => Number.isSafeInteger(value),
    string: value => typeof value === "string",
    bool: value => typeof value === "boolean"
}

function primitiveTest(specification) {
    if (!Array.isArray(specification) || specification.length !== 1) return null
    const reference = specification[0]
    if (reference === null || typeof reference !== "object" || reference.resolve) return null
    return Object.hasOwn(PRIMITIVE_TESTS, reference.label) ? PRIMITIVE_TESTS[reference.label] : null
}

function matchesSpec(specification, value) {
    const test = primitiveTest(specification)
    return test ? test(value) : __type_matches__(specification, value)
}

export function __typed_variable__(value, specification, bindingId, varName = bindingId) {
    if (RELEASE) return value
    const test = primitiveTest(specification)
    if (test && !bindingId && test(value)) return value
    const expected = __type_label__(specification)
    if (!(test ? test(value) : __type_matches__(specification, value))) typeError(varName, expected, value)

    if (bindingId) {
        setVariableType(bindingId, {
            expected: specification,
            label: expected,
            name: varName
        })
    }
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

export function toStruct(value, type) {
    if (Array.isArray(value) && type.kind === "array" && structNamed(type.element)) {
        return value.map(item => toStruct(item, type.element))
    }
    if (!isPlainObject(value)) return value
    const definition = structNamed(type)
    if (!definition) return value
    const made = STRUCT_INSTANCES.get(value)
    if (made && (made === definition || descendsFrom(made, definition))) return value
    return definition.new(value)
}

export function __typed_catch__(error, specification) {
    if (!__type_matches__(specification, error)) throw error
}

export function __match_type__(value, label) {
    return matchesNode(readType(label), value)
}

export function __as_struct__(value, label) {
    return toStruct(value, readType(label))
}

export function __typed_return__(value, specification, fnName) {
    if (RELEASE) return value

    if (!matchesSpec(specification, value)) {
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
    if (isPlainObject(value) || Array.isArray(value)) value = toStruct(value, readType(typed.label))
    if (!matchesSpec(typed.expected, value)) typeError(varName, typed.label, value, "redefined")
    return guardTypedValue(value, typed.expected, varName)
}

export function __typed_parameter__(value, specification, bindingId, varName, optional, message) {
    if (RELEASE) return value
    if (optional && (value === undefined || value === null)) {
        if (bindingId) {
            setVariableType(bindingId, {
                expected: specification,
                label: __type_label__(specification),
                name: varName
            })
        }
        return value
    }

    if (!matchesSpec(specification, value)) {
        throw new ArgumentDeclarationTypeError(message + type(value), { skipUserFrames: 1 })
    }

    if (bindingId) {
        setVariableType(bindingId, {
            expected: specification,
            label: __type_label__(specification),
            name: varName
        })
    }
    return value
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
    if (typeof properties.params === "string" && typeof properties.generic === "string") {
        customType.__generic__ = {
            params: properties.params.split(",").map(param => param.trim()).filter(Boolean),
            label: properties.generic
        }
    }
    __custom_types__[name] = customType
    return customType
}

const activeStructChecks = new WeakMap()
export const STRUCT_INSTANCES = new WeakMap()

function descendsFrom(definition, ancestor) {
    for (let current = definition?.parent; current; current = current.parent) if (current === ancestor) return true
    return false
}

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
    const made = STRUCT_INSTANCES.get(value)
    const allowed = descendsFrom(made, structDef) ? made.scheme : schema
    const extra = Object.keys(value).filter(key => !Object.hasOwn(allowed, key))
    if (extra.length > 0) {
        return fail(new StructPassedError(
            `"${name}" does not contain any keys named "${extra.join(", ")}", but it receives them`
        ))
    }

    let active = activeStructChecks.get(structDef)
    if (active?.has(value)) return returnMethod === "errorResult" ? { success: true, result: value } : value
    if (!active) activeStructChecks.set(structDef, active = new WeakSet())
    active.add(value)
    try {
        for (const [field, definition] of Object.entries(schema)) {
            if (skipsOptional(value, field, definition.optional)) continue
            if (!hasField(value, field)) {
                return fail(new StructExpectError(
                    `"${name}" is receiving fewer keys than expected. The key "${field}" have not been received`
                ))
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
    } finally {
        active.delete(value)
    }

    return returnMethod === "errorResult"
        ? { success: true, result: value }
        : value
}
