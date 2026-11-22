import * as t from "@babel/types"
import { ANY, enumMember, genericOf, literal, named, readType, substituteType, unionOf } from "../../external/typeSyntax.js"
import { FUNCTION, INT, UNDEFINED, atoms, classFor, isArrayLike, isNamed, isNullish, single, staticSignature, structFor, variantField, widen } from "../core.js"
import { infer } from "../infer.js"
import { elementType, indexOutOfRange, returnType, signatureFor, signatureOfType, typedVariableLabel } from "./signatures.js"
import { bindTypeParams, inferReturn } from "./generics.js"
import { BUILTIN_FIELDS, GLOBAL_CALLS, RUNTIME_CALLS, callbackReturn, formType, methodType, staticCallType, tryFailures } from "./methods.js"
import { enumTypeArgs, tryTarget, variantOf, variantSignature } from "./variants.js"
import { matchExpression, missingCases } from "./match.js"

export function structDefinitionType(name, env) {
    const definition = env.structs.get(name)
    if (!definition || definition.trait) return null
    const params = definition.typeParams ?? []
    return genericOf("Struct", [params.length ? genericOf(name, params.map(() => ANY)) : named(name)])
}

export function callType(node, path_, env) {
    const callee = node.callee

    if (t.isFunction(callee)) {
        const match = matchExpression(node)
        if (match) return inferReturn(callee, env, missingCases(match, path_, env)?.missing.length === 0 ? match.fallback : null)
        return returnType({ async: callee.async, node: callee }, env)
    }

    if (t.isIdentifier(callee)) {
        const label = typedVariableLabel(node)
        if (label) return readType(label)

        const name = callee.name
        if (name === "__try__") {
            const target = tryTarget(infer(node.arguments[0], path_, env), env)
            return target?.kind === "generic" ? target.args[0] ?? ANY : null
        }
        if (name === "__try_return__") return tryFailures(path_, env)
        if (name === "__def_struct__" && t.isStringLiteral(node.arguments[0])) return structDefinitionType(node.arguments[0].value, env)
        if (name === "__variant_value__") {
            const variant = variantOf(node.arguments[1], env)
            const field = variant?.definition.variants.get(variant.tag)?.[node.arguments[2]?.value]
            if (!field) return null
            return substituteType(field.type, enumTypeArgs(variant.definition, variant.name, infer(node.arguments[0], path_, env), env))
        }
        if (!path_.scope.getBinding(name)) {
            if (name === "createForm") return formType(node.arguments[0], env)
            if (Object.hasOwn(RUNTIME_CALLS, name)) return RUNTIME_CALLS[name]
            if (Object.hasOwn(GLOBAL_CALLS, name)) return GLOBAL_CALLS[name]
        }
        if (name === "__copyof__" || name === "__lock_object__" || name === "__as_struct__") return infer(node.arguments[0], path_, env)
        return returnType(signatureFor(name, path_, env), env, node, path_)
    }

    if (!(t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) || callee.computed || !t.isIdentifier(callee.property)) return null
    const method = callee.property.name
    const owner = callee.object

    if (t.isIdentifier(owner) && env.enums.get(owner.name)?.variants && !path_.scope.getBinding(owner.name)?.constantViolations.length) {
        const definition = env.enums.get(owner.name)
        const generic = definition.typeParams?.length ? genericOf(owner.name, definition.typeParams.map(() => ANY)) : named(owner.name)
        if (method === "fromJSON") return generic
        if (owner.name === "Option" && method === "from" && definition.builtin) {
            const value = node.arguments[0] ? infer(node.arguments[0], path_, env) : null
            const present = value ? atoms(value, env).filter(atom => !isNullish(atom)) : []
            return genericOf("Option", [present.length ? widen(unionOf(present)) : ANY])
        }
        if (owner.name === "Result" && definition.builtin && (method === "attempt" || method === "fromPromise")) {
            const source = method === "attempt" ? callbackReturn(node.arguments[0], path_, env) : infer(node.arguments[0], path_, env)
            const atom = source && single(source, env)
            const promised = atom?.kind === "generic" && atom.name === "Promise"
            const result = genericOf("Result", [(promised ? atom.args[0] : source) ?? ANY, ANY])
            return promised || method === "fromPromise" ? genericOf("Promise", [result]) : result
        }
    }

    if (t.isIdentifier(owner)) {
        const variant = variantOf(callee, env)
        if (variant) {
            const params = variant.definition.typeParams ?? []
            if (!params.length) return named(variant.name)
            const bound = bindTypeParams(variantSignature(variant.definition, variant.tag), node, path_, env)
            return genericOf(variant.name, params.map(param => bound.get(param) ?? ANY))
        }
        if (env.enums.has(owner.name) && method === "from") return named(owner.name)
        if (env.structs.has(owner.name) && method === "verify") return named(owner.name)
        const ownStatic = staticSignature(owner, method, path_, env)
        if (ownStatic?.signature) return returnType(ownStatic.signature, env, node, path_)
        const result = staticCallType(owner.name, method, node, path_, env)
        if (result) return result
    }

    let receiver = infer(owner, path_, env)
    if (!receiver) return null
    let shortCircuits = false
    if (t.isOptionalCallExpression(node) || t.isOptionalMemberExpression(callee)) {
        const all = atoms(receiver, env)
        const present = all.filter(atom => !isNullish(atom))
        if (present.length && present.length < all.length) {
            shortCircuits = true
            receiver = unionOf(present)
        }
    }
    const result = methodType(receiver, method, node, path_, env) ?? signatureOfType(memberType(callee, path_, env), env)?.returns ?? null
    return result && shortCircuits ? unionOf([result, UNDEFINED]) : result
}

function literalKeys(type, env) {
    const all = type ? atoms(type, env) : []
    return all.length && all.every(atom => atom.kind === "literal") ? all.map(atom => String(atom.value)) : null
}

function literalOf(init) {
    let value = typedVariableLabel(init) ? init.arguments[0] : init
    while (t.isCallExpression(value) && t.isIdentifier(value.callee) && (value.callee.name === "__as_struct__" || value.callee.name === "__lock_object__")) value = value.arguments[0]
    return t.isObjectExpression(value) ? value : null
}

function constLiteralKeys(object, path_) {
    if (!t.isIdentifier(object)) return null
    const binding = path_.scope.getBinding(object.name)
    if (binding?.kind !== "const" || !binding.path.isVariableDeclarator()) return null
    const literal = literalOf(binding.path.node.init)
    if (!literal) return null
    const removed = binding.referencePaths.some(reference => {
        const parent = reference.parentPath
        if (parent.isMemberExpression() && parent.node.object === reference.node) return parent.parentPath.isUnaryExpression({ operator: "delete" })
        return parent.isCallExpression() && t.isMemberExpression(parent.node.callee) && t.isIdentifier(parent.node.callee.object, { name: "Object" })
    })
    if (removed) return null
    const keys = new Set()
    for (const property of literal.properties) {
        if (!t.isObjectProperty(property) && !t.isObjectMethod(property)) continue
        if (property.computed && !t.isStringLiteral(property.key) && !t.isNumericLiteral(property.key)) continue
        const key = t.isIdentifier(property.key) && !property.computed ? property.key.name
            : t.isStringLiteral(property.key) || t.isNumericLiteral(property.key) ? String(property.key.value) : null
        if (key !== null) keys.add(key)
    }
    return keys
}

export function memberType(node, path_, env) {
    const object = infer(node.object, path_, env)

    const record = object && single(object, env)
    if (record?.kind === "generic" && record.name === "Record") {
        const value = record.args[1] ?? ANY
        const keys = atoms(record.args[0] ?? ANY, env)
        const exact = keys.length > 0 && keys.every(key => key.kind === "literal")
        if (exact) {
            const known = new Set(keys.map(key => String(key.value)))
            const property = node.property
            const fields = !node.computed && t.isIdentifier(property) ? [property.name]
                : t.isStringLiteral(property) || t.isNumericLiteral(property) ? [String(property.value)]
                : node.computed ? literalKeys(infer(property, path_, env), env) : null
            if (fields?.length && fields.every(field => known.has(field))) return value
        }
        const own = constLiteralKeys(node.object, path_)
        const field = !node.computed && t.isIdentifier(node.property) ? node.property.name
            : t.isStringLiteral(node.property) || t.isNumericLiteral(node.property) ? String(node.property.value) : null
        if (own && field !== null && own.has(field)) return value
        return unionOf([value, UNDEFINED])
    }

    if (node.computed) {
        if (!object) return null
        if (indexOutOfRange(node, path_, env)) return UNDEFINED
        const atom = single(object, env)
        if (atom?.kind === "literal" && typeof atom.value === "string" && t.isNumericLiteral(node.property)) return literal(atom.value[node.property.value])
        if (atom?.kind === "tuple" && t.isNumericLiteral(node.property)) return atom.items[node.property.value] ?? UNDEFINED
        if (atom && (isArrayLike(atom) || isNamed(atom, "string"))) return elementType(atom, env)
        return null
    }
    if (!t.isIdentifier(node.property)) return null

    const name = node.property.name
    if (t.isIdentifier(node.object) && !path_.scope.getBinding(node.object.name)?.constantViolations.length) {
        const definition = env.enums.get(node.object.name)
        if (definition?.members.has(name)) return enumMember(node.object.name, name)
    }
    if (!object) return null

    const results = []
    for (const atom of atoms(object, env)) {
        if (isNullish(atom)) {
            if (node.optional || (t.isOptionalMemberExpression(node) && isNamed(atom, "undefined"))) results.push(UNDEFINED)
            continue
        }
        const variant = variantField(atom, name, env)
        if (variant) {
            if (!variant.type) return null
            results.push(variant.type)
            continue
        }
        const struct = structFor(atom, env) ?? classFor(atom, env)
        const field = struct?.fields.get(name)
        if (field) results.push(field.optional ? unionOf([field.type, UNDEFINED]) : field.type)
        else if (struct?.methods.has(name)) results.push(FUNCTION)
        else if (name === "length" && (isArrayLike(atom) || isNamed(atom, "string") || (atom.kind === "literal" && typeof atom.value === "string"))) results.push(INT)
        else if (name === "size" && (atom.kind === "generic" || atom.kind === "named") && (atom.name === "Map" || atom.name === "Set")) results.push(INT)
        else if (atom.kind === "named" && Object.hasOwn(BUILTIN_FIELDS, atom.name) && Object.hasOwn(BUILTIN_FIELDS[atom.name], name)) results.push(BUILTIN_FIELDS[atom.name][name])
        else return null
    }
    return results.length ? unionOf(results) : null
}
