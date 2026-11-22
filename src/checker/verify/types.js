import * as t from "@babel/types"
import { formatType, readType } from "../../external/typeSyntax.js"
import { didYouMean } from "../../suggest.js"
import { knownGlobal } from "../globals.js"
import { BUILTIN_CLASSES, expandAlias, KNOWN, accepts, describe, single, typeNames } from "../core.js"
import { functionTypeDefaults, signatureFor, structLiteralName } from "../infer.js"
import { __custom_types__ as RUNTIME_TYPES } from "../../external/runtime-core.js"
import { predicateHolds } from "../predicates.js"
import { checkValue } from "./values.js"
import { checkThisPlace } from "./classes.js"
import { constantValue, previewConstant } from "./operators.js"

export const VARIANT_SHORTHANDS = new Map([["Ok", "Result"], ["Err", "Result"], ["Some", "Option"], ["None", "Option"]])

const BUILTIN_ARITY = {
    Map: [2, 2], WeakMap: [2, 2], Set: [1, 1], WeakSet: [1, 1], Promise: [1, 1], Record: [2, 2], Iterator: [1, 1],
    Iterable: [1, 1], AsyncIterable: [1, 1], AsyncIterator: [1, 1], Generator: [1, 3], AsyncGenerator: [1, 3], Array: [1, 1], ArrayLike: [1, 1], Struct: [0, 1]
}

function typeArity(name, env) {
    if (env.genericAliases.has(name)) {
        const { params, defaults = [] } = env.genericAliases.get(name)
        return [params.filter((param, index) => !defaults[index]).length, params.length]
    }
    if (env.aliases.has(name) || env.customTypes.has(name)) return null
    const definition = env.structs.get(name) ?? env.enums.get(name)
    if (definition) {
        const params = definition.typeParams ?? []
        return [params.filter(param => !definition.typeDefaults?.has(param)).length, params.length]
    }
    if (env.classDefs.has(name)) return null
    if (Object.hasOwn(BUILTIN_ARITY, name)) return BUILTIN_ARITY[name]
    if (KNOWN.has(name) || BUILTIN_CLASSES.has(name)) return [0, 0]
    return null
}

function checkTypeArity(type, node, env, report) {
    const arity = typeArity(type.name, env)
    if (!arity) return
    const [least, most] = arity
    const count = type.args.length
    if (count >= least && count <= most) return
    if (most === 0) {
        report(node, `"${type.name}" has no type parameters, but got ${describe(type)}`)
        return
    }
    const wanted = least === most ? `${least}` : `${least} to ${most}`
    report(node, `"${type.name}" takes ${wanted} type argument${wanted === "1" ? "" : "s"}, got ${count} in ${describe(type)}`)
}

function checkTypeArguments(type, node, env, report) {
    if (type.kind === "generic") {
        checkTypeArity(type, node, env, report)
        const definition = env.structs.get(type.name)
        for (const [index, param] of (definition?.typeParams ?? []).entries()) {
            const constraint = definition.constraints?.get(param)
            const arg = type.args[index]
            if (constraint && arg && arg.kind !== "any" && !accepts(constraint, arg, env)) {
                report(node, `type argument ${describe(arg)} of "${type.name}" must fit ${describe(constraint)}`)
            }
        }
        type.args.forEach(arg => checkTypeArguments(arg, node, env, report))
        return
    }
    const children = type.kind === "array" ? [type.element] : type.kind === "function" ? [...type.params.map(param => param.type), type.returns]
        : type.kind === "shape" ? type.fields.map(field => field.type) : type.items ?? type.types ?? []
    children.forEach(child => checkTypeArguments(child, node, env, report))
}

function aliasCycle(name, env) {
    const expanded = new Set()
    const visit = (type, chain) => {
        if (type.kind === "named" && env.aliases.has(type.name) && !env.genericAliases.has(type.name)) {
            if (type.name === name) return chain
            if (chain.includes(type.name)) return null
            return visit(env.aliases.get(type.name), [...chain, type.name])
        }
        if (type.kind === "generic" && env.genericAliases.has(type.name)) {
            if (type.name === name) return chain
            const key = formatType(type)
            if (expanded.has(key) || expanded.size > 24) return null
            expanded.add(key)
            return visit(expandAlias(type, env), [...chain, key])
        }
        if (type.kind === "union" || type.kind === "intersection") {
            for (const part of type.types) {
                const found = visit(part, chain)
                if (found) return found
            }
        }
        return null
    }
    const body = env.genericAliases.get(name)?.body ?? env.aliases.get(name)
    return body ? visit(body, [name]) : null
}

export function checkAliasCycle(node, env, report) {
    const [nameArg, value] = node.arguments
    if (!t.isStringLiteral(nameArg) || !t.isStringLiteral(value)) return
    const chain = aliasCycle(nameArg.value, env)
    if (!chain) return
    const name = nameArg.value
    const route = [...chain, name].join(" → ")
    report(node, `type "${name}" refers to itself without a structure in between (${route}), so checking a value against it never ends — put the recursion inside an array, object or function type`)
}

export function checkTypeNames(type, node, path_, env, report, typeParams = []) {
    checkTypeArguments(type, node, env, report)
    if (env.openGlobals) return
    const known = name => name === "this" || Object.hasOwn(BUILTIN_ARITY, name) || Object.hasOwn(RUNTIME_TYPES, name) ||
        KNOWN.has(name) || BUILTIN_CLASSES.has(name) || typeParams.includes(name) ||
        env.structs.has(name) || env.enums.has(name) || env.aliases.has(name) || env.customTypes.has(name) ||
        env.importedLocals.has(name) || !!path_.scope.getBinding(name) || knownGlobal(name, env)
    const candidates = () => [
        ...KNOWN, ...BUILTIN_CLASSES, ...typeParams, ...env.structs.keys(), ...env.enums.keys(),
        ...env.aliases.keys(), ...env.customTypes, ...env.importedLocals
    ]

    const hidden = name => env.ambientNames.has(name) && !path_.scope.getBinding(name) &&
        (env.structs.get(name) ?? env.enums.get(name) ?? env.classDefs.get(name) ?? env.aliases.get(name)) === env.ambientNames.get(name)

    for (const name of new Set(typeNames(type))) {
        if (hidden(name)) {
            report(node, `type "${name}" is not exported by the module that declares it — export it there and bring it in with "use"`)
            continue
        }
        if (known(name)) continue
        const suggestion = didYouMean(name, candidates())
        report(node, `unknown type "${name}"${suggestion || ` — declare it, or bring it in with "use"`}`)
    }
}

export function checkTypeArgumentCount(node, path_, env, report) {
    const given = node._slimTypeArgs
    if (!given?.length) return false
    const constructed = structLiteralName(node, env)
    const signature = !constructed && t.isIdentifier(node.callee) ? signatureFor(node.callee.name, path_, env) : null
    const params = constructed ? env.structs.get(constructed).typeParams ?? [] : signature?.typeParams ?? null
    if (params === null) return false
    const name = constructed ? `${constructed}.new` : node.callee.name
    const defaults = signature ? functionTypeDefaults(signature.node) : null
    const structDefaults = constructed ? env.structs.get(constructed).typeDefaults : null
    const required = defaults ? params.filter((param, index) => !defaults[index]).length
        : structDefaults ? params.filter(param => !structDefaults.has(param)).length : params.length
    if (given.length >= required && given.length <= params.length) return false
    const wanted = required === params.length ? `${params.length}` : `${required} to ${params.length}`
    report(node, params.length === 0
        ? `"${name}" has no type parameters, but got <${given.join(", ")}>`
        : `"${name}" takes ${wanted} type argument${wanted === "1" ? "" : "s"}, got ${given.length}`)
    return true
}

export function checkDeclaredTypes(path_, env, report) {
    const call = path_.node
    if (!t.isIdentifier(call.callee)) return
    const fn = path_.getFunctionParent()
    const [first, second] = call.arguments
    const scopeParams = []
    for (let current = fn; current; current = current.parentPath?.getFunctionParent()) scopeParams.push(...(current.node._slimSignature?.typeParams ?? []))

    if (call.callee.name === "__typed_parameter__" && t.isIdentifier(first) && t.isStringLiteral(second)) {
        const param = fn?.node.params.find(p => (t.isAssignmentPattern(p) ? p.left : p)?.name === first.name)
        checkTypeNames(readType(second.value), param ?? fn?.node ?? call, path_, env, report, scopeParams)
        checkThisPlace(readType(second.value), fn, param ?? call, env, report)
    } else if (call.callee.name === "__declare_return__" && t.isStringLiteral(first)) {
        checkTypeNames(readType(first.value), fn?.node ?? call, path_, env, report, scopeParams)
        checkThisPlace(readType(first.value), fn, fn?.node ?? call, env, report)
    } else if (call.callee.name === "__def_struct__" && t.isObjectExpression(second)) {
        const typeParams = t.isArrayExpression(call.arguments[6])
            ? call.arguments[6].elements.filter(element => t.isStringLiteral(element)).map(element => element.value)
            : []
        for (const property of second.properties) {
            if (t.isObjectProperty(property) && t.isStringLiteral(property.value)) {
                checkTypeNames(readType(property.value.value), call, path_, env, report, typeParams)
            }
        }
    }
}

export function checkCustomTypeLiteral(target, node, actual, env, report, describeTarget, phrase) {
    const atom = single(target, env)
    const predicate = atom?.kind === "named" ? env.customPredicates.get(atom.name) : null
    if (!predicate) return
    const found = constantValue(node)
    if (!found) return
    const fitsBase = !predicate.base || !actual || accepts(readType(predicate.base), actual, env)
    if (fitsBase && predicateHolds(predicate, found.value) !== false) return
    report(node, `${describeTarget} ${phrase} ${atom.name}, got ${previewConstant(found.value)}`)
}

export function checkTypedPattern(node, path_, env, report) {
    const { id, init } = node
    if (!t.isArrayPattern(id) && !t.isObjectPattern(id)) return
    if (!t.isCallExpression(init) || !t.isIdentifier(init.callee, { name: "__typed_pattern__" })) return
    const [value, label] = init.arguments
    if (!t.isStringLiteral(label) || !value) return
    checkValue(readType(label.value), value, path_, env, report, "the destructured value", "must be")
}
