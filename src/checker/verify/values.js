import * as t from "@babel/types"
import { ANY, literal, tupleOf, unionOf } from "../../external/typeSyntax.js"
import { closest, didYouMean } from "../../suggest.js"
import { UNDEFINED, accepts, atoms, describe, isArrayLike, isNamed, isNullish, propertyKey, resolveStruct, single, sourceText, structFor, widen } from "../core.js"
import { infer, matchExpression, missingCases } from "../infer.js"
import { checkCustomTypeLiteral } from "./types.js"

export function checkStructLiteral(target, node, path_, env, report, requireAll = true) {
    const definition = structFor(target, env)
    if (!definition) return
    const name = definition.component ?? definition.label
    const noun = definition.component ? "prop" : "field"
    const subject = key => definition.component ? `prop "${key}" of "${name}"` : `"${name}.${key}"`

    const seen = new Set()
    const guessed = new Set()
    const explicit = new Set(node.properties.map(property => t.isSpreadElement(property) ? null : propertyKey(property)))
    let unknownSpread = false
    for (const property of node.properties) {
        if (t.isSpreadElement(property)) {
            const spread = structFor(infer(property.argument, path_, env), env)
            if (!spread) {
                unknownSpread = true
                continue
            }
            const source = `"...${sourceText(property.argument) ?? "spread"}"`
            for (const [key, field] of spread.fields) {
                if (explicit.has(key)) continue
                if (!field.optional) seen.add(key)
                const target = definition.fields.get(key)
                if (!target) {
                    if (definition.trait) continue
                    report(property, `"${name}" has no ${noun} "${key}", which ${source} brings in`)
                    continue
                }
                const expected = target.optional ? unionOf([target.type, UNDEFINED]) : target.type
                const given = field.optional ? unionOf([field.type, UNDEFINED]) : field.type
                if (!accepts(expected, given, env)) {
                    report(property, `${subject(key)} expects ${describe(expected)}, got ${describe(given)} from ${source}`)
                }
            }
            continue
        }
        if (!t.isObjectProperty(property) && !t.isObjectMethod(property)) return
        const key = propertyKey(property)
        if (key === null) return

        seen.add(key)
        const field = definition.fields.get(key)
        if (!field) {
            if (definition.trait && (definition.methods.has(key) || !t.isValidIdentifier(key))) continue
            const guess = closest(key, [...definition.fields.keys()].filter(field => !explicit.has(field)))
            if (guess) guessed.add(guess)
            report(property, `"${name}" has no ${noun} "${key}"${didYouMean(key, definition.fields.keys())}`)
            continue
        }
        if (t.isObjectMethod(property)) continue

        const expected = field.optional ? unionOf([field.type, UNDEFINED]) : field.type
        checkValue(expected, property.value, path_, env, report, subject(key))
    }

    if (!requireAll || unknownSpread) return

    for (const [field, info] of definition.fields) {
        if (info.optional || seen.has(field) || definition.defaults.has(field) || guessed.has(field)) continue
        report(node, `"${name}" is missing ${noun} "${field}" of type ${describe(info.type)}`)
    }
    for (const method of definition.required ?? []) {
        if (!seen.has(method)) report(node, `"${name}" is missing method "${method}()"`)
    }
}

function hasLiterals(type, env) {
    return atoms(type, env).some(atom => atom.kind === "literal")
}

function arrayLiteralAsTuple(target, node, path_, env) {
    if (!t.isArrayExpression(node) || !atoms(target, env).some(atom => atom.kind === "tuple")) return null
    const items = []
    for (const element of node.elements) {
        if (!element || t.isSpreadElement(element)) return null
        const type = infer(element, path_, env)
        if (!type) return null
        items.push(type)
    }
    return tupleOf(items)
}

const PRIMITIVE_NAMES = new Set(["int", "float", "number", "string", "bool", "bigint", "symbol"])

function objectTargets(target, env) {
    if (structFor(target, env)) return [target]
    const candidates = []
    for (const atom of atoms(target, env)) {
        if (isNullish(atom) || atom.kind === "literal" || atom.kind === "function" || isArrayLike(atom)) continue
        if (atom.kind === "named" && PRIMITIVE_NAMES.has(atom.name)) continue
        if (!structFor(atom, env)) return null
        candidates.push(atom)
    }
    return candidates.length ? candidates : null
}

export function checkValue(target, node, path_, env, report, describeTarget, phrase = "expects") {
    if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: "__as_struct__" })) node = node.arguments[0]

    const candidates = t.isObjectExpression(node) && !node._slimCast ? objectTargets(target, env) : null
    if (candidates?.length === 1) {
        checkStructLiteral(candidates[0], node, path_, env, report)
        return
    }
    if (candidates) {
        let best = null
        for (const candidate of candidates) {
            const found = []
            checkStructLiteral(candidate, node, path_, env, (at, message) => found.push([at, message]))
            if (found.length === 0) return
            if (!best || found.length < best.length) best = found
        }
        for (const [at, message] of best) report(at, message)
        return
    }

    const list = single(target, env)
    if (t.isObjectExpression(node) && list?.kind === "generic" && list.name === "Record") {
        const [key = ANY, value = ANY] = list.args
        for (const property of node.properties) {
            if (!t.isObjectProperty(property)) continue
            const name = propertyKey(property)
            if (name !== null && !accepts(key, literal(name), env)) report(property, `${describeTarget} can't have the key "${name}": its keys are ${describe(key)}`)
            checkValue(value, property.value, path_, env, report, `${describeTarget}["${name ?? "?"}"]`, phrase)
        }
        const keys = atoms(key, env)
        const exact = keys.length > 0 && keys.every(atom => atom.kind === "literal" && typeof atom.value === "string")
        if (exact && node.properties.every(property => t.isObjectProperty(property) && propertyKey(property) !== null)) {
            const given = new Set(node.properties.map(propertyKey))
            const missing = keys.map(atom => atom.value).filter(name => !given.has(name))
            if (missing.length) report(node, `${describeTarget} is missing the key${missing.length === 1 ? "" : "s"} ${missing.map(name => `"${name}"`).join(", ")} — ${describe(list)} needs every key`)
        }
        return
    }
    if (t.isArrayExpression(node) && list?.kind === "array" && structFor(list.element, env)) {
        node.elements.forEach((element, index) => {
            if (element && !t.isSpreadElement(element)) checkValue(list.element, element, path_, env, report, `${describeTarget}[${index}]`, phrase)
        })
        return
    }

    const actual = arrayLiteralAsTuple(target, node, path_, env) ?? infer(node, path_, env)
    if (accepts(target, actual, env)) {
        checkCustomTypeLiteral(target, node, actual, env, report, describeTarget, phrase)
        return
    }

    const enumValues = enumValueList(target, env)
    const literalActual = actual && single(actual, env)
    const literalParts = actual ? atoms(actual, env).filter(atom => atom.kind === "literal").length : 0
    const binding = t.isIdentifier(node) ? path_.scope.getBinding(node.name) : null
    const declaredLiterals = !!binding && env.bindings.has(binding) && hasLiterals(env.bindings.get(binding), env)
    const shown = hasLiterals(target, env) || (enumValues && literalActual?.kind === "literal") || literalParts > 1 || declaredLiterals ? actual : widen(actual)
    const present = atoms(actual, env).filter(atom => !isNullish(atom))
    const onlyNullish = present.length && present.length < atoms(actual, env).length && accepts(target, unionOf(present), env)
    const match = onlyNullish && matchExpression(node)
    if (match && !match.wildcard && missingCases(match, path_, env)?.missing.length) return
    const hint = match && !match.wildcard
        ? ` — the match gives undefined when no case fits: cover every case or add a "_" fallback`
        : onlyNullish
        ? ` — check it for ${atoms(actual, env).some(atom => isNamed(atom, "null")) ? "null" : "undefined"} first`
        : valueHint(target, actual, node, env, enumValues)
    report(node, `${describeTarget} ${phrase} ${describe(target)}, got ${describe(shown)}${hint}`)
}

function enumValueList(target, env) {
    const atom = single(target, env)
    if (atom?.kind !== "named") return null
    const values = env.enums.get(atom.name)?.values
    return values ? [...values.values()] : null
}

function shapeHint(target, actual, env) {
    const wanted = structFor(target, env)
    const given = actual && single(actual, env)?.kind === "shape" ? structFor(actual, env) : null
    if (!wanted || wanted.shape || !given?.exact) return ""
    const missing = [...wanted.fields].filter(([name, field]) => !field.optional && !given.fields.has(name)).map(([name]) => `"${name}"`)
    const extra = [...given.fields.keys()].filter(name => !wanted.fields.has(name)).map(name => `"${name}"`)
    const make = `create it with ${wanted.label}.new(...)`
    if (!wanted.trait && wanted.methods.size > 0 && !missing.length && !extra.length) return ` — a plain object has none of "${wanted.label}"'s methods: ${make}`
    if (missing.length && missing.every(name => wanted.defaults.has(name.slice(1, -1)))) return ` — a plain object gets no defaults, it has no ${missing.join(", ")}: ${make}`
    if (missing.length) return ` — it has no ${missing.join(", ")}`
    if (extra.length) return ` — ${wanted.label} has no field ${extra.join(", ")}`
    return ""
}

function valueHint(target, actual, node, env, enumValues) {
    const shape = shapeHint(target, actual, env)
    if (shape) return shape
    if (enumValues && single(actual, env)?.kind === "literal") {
        return ` — use one of ${enumValues.map(value => JSON.stringify(value)).join(", ")}`
    }
    if (t.isBinaryExpression(node, { operator: "/" }) && isNamed(single(target, env) ?? ANY, "int") &&
        actual && atoms(actual, env).every(atom => isNamed(atom, "float") || isNamed(atom, "number"))) {
        return ` — "/" always gives a float, use "~/" for integer division`
    }
    return ""
}

export function checkStructDefaults(node, path_, env, report) {
    const [nameArg, , , defaults] = node.arguments
    if (!t.isStringLiteral(nameArg) || !t.isObjectExpression(defaults)) return
    const definition = env.structs.get(nameArg.value)
    if (!definition) return
    for (const property of defaults.properties) {
        if (!t.isObjectProperty(property)) continue
        const key = propertyKey(property)
        const field = key !== null ? definition.fields.get(key) : null
        const value = property.value
        if (!field || !t.isArrowFunctionExpression(value) || t.isBlockStatement(value.body)) continue
        if (atoms(field.type, env).some(atom => atom.kind === "named" && definition.typeParams?.includes(atom.name))) continue
        checkValue(field.optional ? unionOf([field.type, UNDEFINED]) : field.type, value.body, path_, env, report, `the default of "${nameArg.value}.${key}"`, "must be")
    }
}

export function checkStructParent(node, env, report) {
    const [nameArg] = node.arguments
    const parentArg = node.arguments[4]
    if (!t.isStringLiteral(nameArg) || !t.isStringLiteral(parentArg)) return
    const name = nameArg.value
    const parentName = parentArg.value
    const parent = env.structs.get(parentName)
    if (!parent) {
        const known = [...env.structs].filter(([, definition]) => !definition.trait && !definition.component).map(([known]) => known)
        report(node, `"${name}" extends unknown struct "${parentName}"${didYouMean(parentName, known)}`)
        return
    }
    if (parent.trait) {
        report(node, `"${name}" can't extend "${parentName}": it is a trait — write "implements ${parentName}"`)
        return
    }
    const chain = [name]
    for (let current = parentName; current; current = env.structs.get(current)?.parent ?? null) {
        if (chain.includes(current)) {
            report(node, `"${name}" extends itself: ${[...chain, current].join(" → ")}`)
            return
        }
        chain.push(current)
    }
    const inherited = resolveStruct(parentName, env)
    const own = env.structs.get(name)
    if (!inherited || !own) return
    const fieldType = field => field.optional ? unionOf([field.type, UNDEFINED]) : field.type
    for (const [field, info] of own.fields) {
        const base = inherited.fields.get(field)
        if (base && !accepts(fieldType(base), fieldType(info), env)) {
            report(node, `"${name}.${field}" is ${describe(fieldType(info))}, but "${parentName}.${field}" is ${describe(fieldType(base))} — an overriding field has to fit the parent's type`)
        }
    }
}

export function checkNewStruct(node, env, report) {
    if (!t.isIdentifier(node.callee)) return
    const name = node.callee.name
    if (env.classDefs.has(name) || env.classes.has(name)) return
    if (env.structs.has(name) && !env.structs.get(name).trait) report(node, `"${name}" is a struct, not a class: create it with ${name}.new({ ... }) or a literal`)
    else if (env.enums.has(name)) report(node, `"${name}" is an enum, not a class: use one of its members`)
}
