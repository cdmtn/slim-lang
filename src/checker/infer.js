import * as t from "@babel/types"
import { arrayOf, genericOf, literal, named, readType, unionOf } from "../external/typeSyntax.js"
import { ARRAY, BOOL, BUILTIN_CLASSES, FLOAT, HTML, INT, NULL, NUMBER, OBJECT, STRING, UNDEFINED, atoms, isNamed, isNullish, isNumeric, single, widen } from "./core.js"
import { factContext, factsFrom, logicalAssigned, narrowed, withFacts } from "./narrowing.js"
import { elementType, functionTypeOf, structLiteralName } from "./infer/signatures.js"
import { callType, memberType } from "./infer/members.js"
import { falsyParts, identifierType, thisOwner, truthyParts } from "./infer/bindings.js"
export { signatureFor, signatureOfType, typedVariableLabel, indexOutOfRange, structLiteralName, elementType, asyncResult } from "./infer/signatures.js"
export { functionTypeDefaults, bindTypeParams, inferReturn } from "./infer/generics.js"
export { objectLiteralType, BUILTIN_FIELDS } from "./infer/methods.js"
export { enumMethod, variantSignature, variantOf, tryTarget } from "./infer/variants.js"
export { callType } from "./infer/members.js"
export { expectedType, contextualParam } from "./infer/expected.js"
export { matchExpression, missingCases } from "./infer/match.js"

function inferNode(node, path_, env) {
    if (t.isNumericLiteral(node) && Number.isInteger(node.value) && /[.eE]/.test(node.extra?.raw ?? "")) return FLOAT
    if (t.isNumericLiteral(node) || t.isStringLiteral(node) || t.isBooleanLiteral(node)) return literal(node.value)
    if (t.isBigIntLiteral(node)) return named("bigint")
    if (t.isTemplateLiteral(node)) return STRING
    if (t.isTaggedTemplateExpression(node) && node._slimMarkup) return HTML
    if (t.isNullLiteral(node)) return NULL
    if (t.isIdentifier(node, { name: "undefined" }) && !path_.scope.getBinding("undefined")) return UNDEFINED
    if (t.isObjectExpression(node)) return OBJECT
    if (t.isFunction(node)) return functionTypeOf(node, env)

    if (t.isArrayExpression(node)) {
        if (node.elements.length === 0) return arrayOf(NULL)

        const kinds = []
        for (const item of node.elements) {
            if (!item) {
                kinds.push(UNDEFINED)
                continue
            }
            const kind = t.isSpreadElement(item)
                ? elementType(infer(item.argument, path_, env), env)
                : widen(infer(item, path_, env))
            if (!kind) return ARRAY
            kinds.push(kind)
        }
        return arrayOf(unionOf(kinds))
    }

    const structInstance = structLiteralName(node, env)
    if (structInstance) return node._slimTypeArgs?.length ? genericOf(structInstance, node._slimTypeArgs.map(readType)) : named(structInstance)

    if (t.isNewExpression(node) && t.isIdentifier(node.callee)) {
        const name = node.callee.name
        if (node._slimTypeArgs?.length && (BUILTIN_CLASSES.has(name) || env.classes.has(name))) return genericOf(name, node._slimTypeArgs.map(readType))
        return env.classes.has(name) || BUILTIN_CLASSES.has(name) ? named(name) : null
    }

    if (t.isIdentifier(node)) return narrowed(node, path_, env, identifierType(node, path_, env))

    if (t.isThisExpression(node)) {
        const owner = thisOwner(path_, env)
        return owner ? named(owner) : null
    }

    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
        return narrowed(node, path_, env, memberType(node, path_, env))
    }

    if (t.isUnaryExpression(node)) {
        switch (node.operator) {
            case "!": return BOOL
            case "typeof": return STRING
            case "void": return UNDEFINED
            case "~": return INT
            case "-": {
                const operand = widen(infer(node.argument, path_, env))
                return isNumeric(operand) ? operand : NUMBER
            }
            case "+": {
                const operand = widen(infer(node.argument, path_, env))
                return isNumeric(operand) ? operand : NUMBER
            }
        }
        return null
    }

    if (t.isBinaryExpression(node)) {
        const operator = node.operator
        if (["==", "!=", "===", "!==", "<", ">", "<=", ">=", "instanceof", "in"].includes(operator)) return BOOL
        if (["&", "|", "^", "<<", ">>", ">>>"].includes(operator)) return INT

        const left = widen(infer(node.left, path_, env))
        const right = widen(infer(node.right, path_, env))
        const bothNumeric = isNumeric(left) && isNumeric(right)
        const integer = isNamed(left, "int") && isNamed(right, "int")

        if (operator === "+") {
            if (isNamed(left, "string") || isNamed(right, "string")) return STRING
            if (bothNumeric) return integer ? INT : FLOAT
            return pairwise(left, right, env, (a, b) => isNamed(a, "string") || isNamed(b, "string") ? STRING
                : isNumeric(a) && isNumeric(b) ? (isNamed(a, "int") && isNamed(b, "int") ? INT : FLOAT) : null)
        }
        if (operator === "**") {
            if (!bothNumeric) return null
            return integer && t.isNumericLiteral(node.right) && Number.isInteger(node.right.value) ? INT : integer ? NUMBER : FLOAT
        }
        if (["-", "*", "%"].includes(operator)) {
            if (bothNumeric) return integer ? INT : FLOAT
            return pairwise(left, right, env, (a, b) => isNumeric(a) && isNumeric(b) ? (isNamed(a, "int") && isNamed(b, "int") ? INT : FLOAT) : null)
        }
        if (operator === "/") return bothNumeric || pairwise(left, right, env, (a, b) => isNumeric(a) && isNumeric(b) ? FLOAT : null) ? FLOAT : null
        return null
    }

    if (t.isLogicalExpression(node)) {
        const left = infer(node.left, path_, env)
        if (!left) return null

        if (node.operator === "??") {
            const right = infer(node.right, path_, env)
            const present = atoms(left, env).filter(atom => !isNullish(atom))
            return right ? unionOf([...present, right]) : null
        }

        const andAlso = node.operator === "&&"
        const right = withFacts(env, factsFrom(node.left, andAlso, path_, env), () => infer(node.right, path_, env))
        if (!right) return null
        const kept = andAlso ? falsyParts(left, env) : truthyParts(left, env)
        return unionOf([...kept, right])
    }

    if (t.isConditionalExpression(node)) {
        const consequent = withFacts(env, factsFrom(node.test, true, path_, env), () => infer(node.consequent, path_, env))
        const alternate = withFacts(env, factsFrom(node.test, false, path_, env), () => infer(node.alternate, path_, env))
        return consequent && alternate ? unionOf([consequent, alternate]) : null
    }

    if (t.isAwaitExpression(node)) {
        let awaited = infer(node.argument, path_, env)
        for (let atom = awaited && single(awaited, env); atom?.kind === "generic" && atom.name === "Promise"; atom = awaited && single(awaited, env)) {
            awaited = atom.args[0] ?? null
        }
        if (awaited && isNamed(single(awaited, env), "Promise")) return null
        return awaited
    }

    if (t.isSequenceExpression(node)) return infer(node.expressions.at(-1), path_, env)
    if (t.isAssignmentExpression(node, { operator: "=" })) return infer(node.right, path_, env)
    if (t.isAssignmentExpression(node) && ["??=", "||=", "&&="].includes(node.operator)) {
        return logicalAssigned(node.operator, infer(node.left, path_, env), infer(node.right, path_, env), env)
    }
    if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
        const result = callType(node, path_, env)
        if (result && t.isOptionalCallExpression(node) && node.optional) {
            const callee = infer(node.callee, path_, env)
            if (callee && atoms(callee, env).some(isNullish)) return unionOf([result, UNDEFINED])
        }
        return result
    }

    return null
}

function pairwise(left, right, env, combine) {
    if (!left || !right) return null
    const results = []
    for (const a of atoms(left, env)) {
        for (const b of atoms(right, env)) {
            const result = combine(a, b)
            if (!result) return null
            results.push(result)
        }
    }
    return results.length ? unionOf(results) : null
}

function withoutNull(type, env) {
    const present = type ? atoms(type, env).filter(atom => !isNullish(atom)) : []
    return present.length ? unionOf(present) : null
}

function cacheSlot(node, path_, env) {
    const context = path_ ? factContext(path_, env) : null
    let byContext = env.inferCache.get(node)
    if (!byContext) {
        byContext = new Map()
        env.inferCache.set(node, byContext)
    }
    let slot = byContext.get(context)
    if (!slot) {
        slot = new Map()
        byContext.set(context, slot)
    }
    return slot
}

export function infer(node, path_, env) {
    if (!node) return null
    if (env.inferring.has(node)) {
        env.taint++
        return null
    }
    if (node._slimCast) return node._slimCast
    const slot = env.facts.length === 0 ? cacheSlot(node, path_, env) : null
    if (slot?.has(path_?.scope ?? null)) return slot.get(path_?.scope ?? null)
    const outermost = env.inferring.size === 0
    const taint = env.taint
    env.inferring.add(node)
    try {
        const inferred = inferNode(node, path_, env)
        const result = node._slimNonNull ? withoutNull(inferred, env) : inferred
        if (slot && (outermost || env.taint === taint)) slot.set(path_?.scope ?? null, result)
        return result
    } finally {
        env.inferring.delete(node)
    }
}

function declaredReturn(fn) {
    if (!t.isBlockStatement(fn.body)) return null

    for (const statement of fn.body.body) {
        if (!t.isExpressionStatement(statement)) continue
        const call = statement.expression
        if (!t.isCallExpression(call)) continue
        if (!t.isIdentifier(call.callee, { name: "__declare_return__" })) continue
        if (t.isStringLiteral(call.arguments[0])) return readType(call.arguments[0].value)
    }
    return null
}

export function collectParameters(fn) {
    const declared = new Map()
    const component = t.isCallExpression(fn.body) && t.isIdentifier(fn.body.callee, { name: "__component__" }) && t.isFunction(fn.body.arguments[0])
    const body = component ? fn.body.arguments[0].body : fn.body

    if (t.isBlockStatement(body)) {
        for (const statement of body.body) {
            if (!t.isExpressionStatement(statement)) continue
            const call = statement.expression
            if (!t.isCallExpression(call)) continue
            if (!t.isIdentifier(call.callee, { name: "__typed_parameter__" })) continue

            const [value, label, , optional] = call.arguments
            if (!t.isIdentifier(value) || !t.isStringLiteral(label)) continue
            declared.set(value.name, {
                type: readType(label.value),
                optional: t.isBooleanLiteral(optional) ? optional.value : false
            })
        }
    }

    const generic = fn._slimSignature
    const genericType = index => generic?.params[index] ? readType(generic.params[index]) : null

    let rest = false
    const parameters = fn.params.map((param, index) => {
        if (t.isRestElement(param)) {
            rest = true
            const name = t.isIdentifier(param.argument) ? param.argument.name : null
            return { name, type: genericType(index) ?? (name ? declared.get(name)?.type : null) ?? null, required: false, rest: true }
        }
        if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
            return { name: param.left.name, type: genericType(index) ?? declared.get(param.left.name)?.type ?? null, required: false }
        }
        if (t.isIdentifier(param)) {
            const info = declared.get(param.name)
            return { name: param.name, type: genericType(index) ?? info?.type ?? null, required: !info?.optional && !generic?.optional[index] }
        }
        return { name: null, type: null, required: false }
    })

    const returns = generic?.returns ? readType(generic.returns) : declaredReturn(fn)
    const typed = declared.size > 0 || !!returns || parameters.some(parameter => parameter.type)
    const constraints = new Map(Object.entries(generic?.constraints ?? {}).map(([name, label]) => [name, readType(label)]))
    const named = new Set(parameters.map(parameter => parameter.name))
    const destructured = [...declared].filter(([name]) => !named.has(name)).map(([name, info]) => ({ name, type: info.type, optional: info.optional }))
    return { parameters, rest, returns, async: !!fn.async, typed, node: fn, typeParams: generic?.typeParams ?? [], constraints, destructured }
}
