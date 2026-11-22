import * as t from "@babel/types"
import { ANY, readType, substituteType, unionOf } from "../../external/typeSyntax.js"
import { UNDEFINED, accepts, atoms, isNullish, structFor, widen } from "../core.js"
import { exits } from "../narrowing.js"
import { infer } from "../infer.js"
import { elementType, mentions } from "./signatures.js"
import { objectLiteralType } from "./methods.js"

function unify(pattern, actual, params, bound, env, literals = new Set()) {
    if (!pattern || !actual) return
    if (pattern.kind === "named" && params.includes(pattern.name)) {
        const given = literals.has(pattern.name) ? actual : widen(actual)
        const existing = bound.get(pattern.name)
        if (!existing) bound.set(pattern.name, given)
        else if (!accepts(existing, given, env) && accepts(given, existing, env)) bound.set(pattern.name, given)
        return
    }
    if (!mentions(pattern, params)) return

    const present = atoms(actual, env).filter(atom => !isNullish(atom))
    const atom = present.length === 1 ? present[0] : null

    switch (pattern.kind) {
        case "array":
            unify(pattern.element, elementType(actual, env), params, bound, env, literals)
            break
        case "tuple":
            if (atom?.kind === "tuple") pattern.items.forEach((item, index) => unify(item, atom.items[index], params, bound, env, literals))
            break
        case "generic":
            if (atom?.kind === "generic" && atom.name === pattern.name) {
                pattern.args.forEach((arg, index) => unify(arg, atom.args[index], params, bound, env, literals))
            }
            break
        case "function":
            if (atom?.kind === "function") {
                pattern.params.forEach((param, index) => atom.params[index] && unify(param.type, atom.params[index].type, params, bound, env, literals))
                unify(pattern.returns, atom.returns, params, bound, env, literals)
            }
            break
        case "shape": {
            const given = atom && structFor(atom, env)
            if (given) pattern.fields.forEach(field => unify(field.type, given.fields.get(field.name)?.type, params, bound, env, literals))
            break
        }
        case "union": {
            const generic = pattern.types.filter(part => mentions(part, params))
            const optional = pattern.types.some(isNullish)
            if (optional && present.length === 0) break
            if (generic.length === 1) unify(generic[0], present.length && optional ? unionOf(present) : actual, params, bound, env, literals)
        }
    }
}

function keepsLiterals(constraint, env) {
    if (!constraint) return false
    if (constraint.kind === "keyof") return true
    const all = atoms(constraint, env)
    return all.length > 0 && all.every(atom => atom.kind === "literal")
}

export function functionTypeDefaults(fn) {
    const signature = fn?._slimSignature
    const labels = signature?.defaults
    if (!labels || typeof labels !== "object" || !Object.keys(labels).length) return null
    return (signature.typeParams ?? []).map(name => typeof labels[name] === "string" ? readType(labels[name]) : null)
}

export function bindTypeParams(signature, call, path_, env, bound = null, skipCallbacks = false) {
    const result = new Map(bound ?? [])
    const params = signature.typeParams ?? []
    if (params.length === 0 || !path_) return result
    if (call._slimTypeArgs?.length === params.length) {
        params.forEach((param, index) => result.set(param, readType(call._slimTypeArgs[index])))
        return result
    }
    const defaults = call._slimTypeArgs?.length ? functionTypeDefaults(signature.node) : null
    if (defaults && call._slimTypeArgs.length < params.length) {
        params.forEach((param, index) => {
            const given = call._slimTypeArgs[index]
            const fallback = defaults[index]
            result.set(param, given ? readType(given) : fallback ? substituteType(fallback, result) : ANY)
        })
        return result
    }

    const open = params.filter(param => !result.has(param))
    const literals = new Set(open.filter(param => keepsLiterals(signature.constraints?.get(param), env)))
    const order = call.arguments.map((argument, index) => index).sort((a, b) =>
        t.isFunction(call.arguments[a]) - t.isFunction(call.arguments[b]))
    for (const index of order) {
        const argument = call.arguments[index]
        const parameter = signature.parameters[index]
        if (!parameter?.type || t.isSpreadElement(argument) || !mentions(parameter.type, open)) continue
        if (skipCallbacks && t.isFunction(argument)) continue
        unify(parameter.type, infer(argument, path_, env), open, result, env, literals)
    }
    for (const name of params) if (!result.has(name)) result.set(name, ANY)
    return result
}

export function inferReturn(fn, env, skip = null) {
    if (!fn || fn.generator) return null
    if (!skip && env.inferredReturns.has(fn)) {
        if (env.pending.has(fn)) env.taint++
        return env.inferredReturns.get(fn)
    }
    const fnPath = env.functionPaths.get(fn)
    if (!fnPath) return null

    if (!skip) {
        env.inferredReturns.set(fn, null)
        env.pending.add(fn)
    }

    let result = null
    if (!t.isBlockStatement(fn.body)) {
        result = (t.isObjectExpression(fn.body) && objectLiteralType(fn.body, fnPath.get("body"), env)) || widen(infer(fn.body, fnPath.get("body"), env))
    } else {
        const found = []
        let unknown = false
        fnPath.traverse({
            Function(inner) { inner.skip() },
            ReturnStatement(statement) {
                if (statement.node === skip) return
                if (!statement.node.argument) { found.push(UNDEFINED); return }
                const argument = statement.node.argument
                const type = (t.isObjectExpression(argument) && objectLiteralType(argument, statement, env)) || infer(argument, statement, env)
                if (type) found.push(widen(type))
                else unknown = true
            }
        })

        const last = fn.body.body.at(-1)
        if (found.length === 0) result = unknown ? null : UNDEFINED
        else if (!unknown && (exits(last) || skip)) result = unionOf(found)
    }

    if (!skip) {
        env.inferredReturns.set(fn, result)
        env.pending.delete(fn)
    }
    return result
}
