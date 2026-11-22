import _traverse from "@babel/traverse"
import * as t from "@babel/types"
import { infer, accepts } from "../checker.js"
import { readType } from "../external/typeSyntax.js"
import { isRuntimeCall } from "./typeSpecs.js"

const traverse = _traverse.default ?? _traverse

const PRIMITIVES = new Set(["int", "float", "number", "string", "bool"])

export function isPrimitiveOnly(type) {
    if (!type) return false
    if (type.kind === "union") return type.types.length > 0 && type.types.every(isPrimitiveOnly)
    if (type.kind === "literal") return typeof type.value === "string" || typeof type.value === "number" || typeof type.value === "boolean"
    return type.kind === "named" && PRIMITIVES.has(type.name)
}

function declaredReturn(fn) {
    if (!t.isBlockStatement(fn.body)) return null
    for (const statement of fn.body.body) {
        const call = t.isExpressionStatement(statement) ? statement.expression : null
        if (isRuntimeCall(call, "__declare_return__") && t.isStringLiteral(call.arguments[0])) return call.arguments[0].value
    }
    return null
}

function proves(expected, value, path_, env) {
    if (!isPrimitiveOnly(expected)) return false
    let given
    try {
        given = infer(value, path_, env)
    } catch {
        return false
    }
    return isPrimitiveOnly(given) && accepts(expected, given, env)
}

export function markProvenReturns(ast, env) {
    traverse(ast, {
        ReturnStatement(path_) {
            const value = path_.node.argument
            if (!value) return
            const fn = path_.getFunctionParent()
            if (!fn || fn.node.async || fn.node.generator) return
            const label = declaredReturn(fn.node)
            if (label && proves(readType(label), value, path_, env)) value._slimProven = true
        }
    })
}
