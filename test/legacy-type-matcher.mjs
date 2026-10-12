// Reference implementation of the original string-interpreting type matcher
// (src/external/core.js before predicates were compiled). It keeps its own
// registries so it can run next to the real runtime, and exists only so the
// tests can prove that the compiled predicates give identical results.
// core.js must load before types.js: the two modules import each other.
import { type, __type_label__ } from "../src/external/core.js"
import { Struct, Enum, EnumValue, isSameType } from "../src/external/types.js"
import { StructError, StructPassedError, StructExpectError } from "../src/external/classErrors.js"

export function createLegacyRuntime() {
    const structs = {}
    const enums = {}
    const customs = {}

    function resolveTypeReference(reference) {
        if (reference && typeof reference === "object" && reference.__slim_type_ref__) {
            if (typeof reference.resolve === "function") return reference.resolve()

            const name = reference.label.replace(/(?:\[\])+$/, "").split("::")[0]
            return customs[name] ?? structs[name] ?? enums[name]
        }

        if (typeof reference === "string") {
            const name = reference.replace(/(?:\[\])+$/, "").split("::")[0]
            return customs[name] ?? structs[name] ?? enums[name]
        }

        return reference
    }

    function isClass(value) {
        return typeof value === "function" && /^\s*class\s+/.test(Function.prototype.toString.call(value))
    }

    function matchesDefinition(definition, value) {
        if (Array.isArray(definition)) return matches(definition, value)

        if (typeof definition === "function") {
            if (isClass(definition)) return value instanceof definition
            return definition(value) === true
        }

        return isSameType(definition, value)
    }

    function matchesResolvedType(resolved, label, value) {
        if (resolved === undefined || resolved === null) return false

        if (resolved?.type === Struct) {
            return typed(value, resolved, "errorResult").success
        }

        if (resolved?.type instanceof Enum) return resolved.has(value)
        if (resolved instanceof EnumValue) return resolved === value

        if (typeof resolved === "function" && resolved.__type__ === true) {
            return resolved(value) === true
        }

        return matchesDefinition(resolved, value)
    }

    const BUILTIN_CLASSES = { Map, Set, Date, Promise, RegExp, Error }

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

    const ref = (label, resolve = null) => ({ __slim_type_ref__: true, label, resolve })

    function matchesLabel(label, value) {
        return matches([ref(label)], value)
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
            const enumDef = resolved ?? enums[enumName]
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

    function matches(specification, value) {
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

    function defStruct(name, schema, specifications = {}, defaults = {}, extendsName = null) {
        const parent = extendsName ? structs[extendsName] : null
        const scheme = parent ? { ...parent.scheme } : {}

        Object.keys(schema).forEach(item => {
            let fieldName = item
            let optional = false
            if (fieldName.startsWith("*")) {
                optional = true
                fieldName = fieldName.slice(1).trim()
            }

            scheme[fieldName] = {
                type: schema[item],
                specification: specifications[fieldName] ?? schema[item],
                optional
            }
        })

        const definition = { type: Struct, name, scheme }
        structs[name] = definition
        return definition
    }

    function defEnum(name, schema) {
        const values = { ...schema }
        const definition = {
            type: new Enum(name),
            name,
            values: () => Object.values(values),
            has: value => Object.values(values).some(item =>
                value === item || (value instanceof EnumValue && value.value === item)
            )
        }
        Object.keys(values).forEach(key => { definition[key] = new EnumValue(values[key]) })
        enums[name] = definition
        return definition
    }

    function defType(name, definition, properties = {}) {
        const inherited = properties.extends ?? null
        const customType = value => {
            if (inherited && !matches(inherited, value)) return false
            return matchesDefinition(definition, value)
        }
        customType.__type__ = true
        customType.__slim_type_name__ = name
        customType.value = definition
        customs[name] = customType
        return customType
    }

    // Mirrors __typed__, including every error message and its properties.
    function typed(value, structDef, returnMethod = "default") {
        const name = structDef.name

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

            if (!matches(definition.specification, value[field])) {
                return fail(new StructError(
                    `"${name}.${field}" expected ${__type_label__(definition.specification)}, got ${type(value[field])}: ${previewValue(value[field])}`
                ), {
                    name,
                    field,
                    expected: __type_label__(definition.specification),
                    got: type(value[field]),
                    fieldName: `${name}.${field}`
                })
            }
        }

        return returnMethod === "errorResult" ? { success: true, result: value } : value
    }

    return { structs, enums, customs, matches, typed, defStruct, defEnum, defType }
}
