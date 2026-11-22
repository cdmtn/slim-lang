import _generate from "@babel/generator"
import { parseExpression } from "@babel/parser"
import * as t from "@babel/types"
import { __kindof__, __sizeof__ } from "../external/runtime-core.js"

const generate = _generate.default ?? _generate

const UNARY = new Set(["!", "-", "+", "typeof"])
const BINARY = new Set(["==", "!=", "===", "!==", "<", "<=", ">", ">=", "+", "-", "*", "/", "%", "**"])
const LOGICAL = new Set(["&&", "||", "??"])
const GLOBAL_VALUES = { undefined: undefined, NaN: NaN, Infinity: Infinity }
const HELPERS = { __kindof__, __sizeof__ }
const STATICS = {
    Number: { isInteger: Number.isInteger, isFinite: Number.isFinite, isNaN: Number.isNaN, isSafeInteger: Number.isSafeInteger },
    Array: { isArray: Array.isArray }
}
const STRING_METHODS = new Set(["startsWith", "endsWith", "includes"])
const UNKNOWN = Symbol("unknown")
const parsed = new Map()

function returnedExpression(fn) {
    if (t.isExpression(fn.body)) return fn.body
    const statements = fn.body.body
    if (statements.length !== 1 || !t.isReturnStatement(statements[0]) || !statements[0].argument) return null
    return statements[0].argument
}

function isSafe(node, param) {
    if (t.isIdentifier(node)) return node.name === param || Object.hasOwn(GLOBAL_VALUES, node.name)
    if (t.isNumericLiteral(node) || t.isStringLiteral(node) || t.isBooleanLiteral(node) || t.isNullLiteral(node) || t.isBigIntLiteral(node)) return true
    if (t.isRegExpLiteral(node)) return true
    if (t.isUnaryExpression(node)) return UNARY.has(node.operator) && isSafe(node.argument, param)
    if (t.isBinaryExpression(node)) return BINARY.has(node.operator) && isSafe(node.left, param) && isSafe(node.right, param)
    if (t.isLogicalExpression(node)) return LOGICAL.has(node.operator) && isSafe(node.left, param) && isSafe(node.right, param)
    if (t.isConditionalExpression(node)) return isSafe(node.test, param) && isSafe(node.consequent, param) && isSafe(node.alternate, param)
    if (t.isMemberExpression(node)) return !node.computed && t.isIdentifier(node.property, { name: "length" }) && isSafe(node.object, param)
    if (!t.isCallExpression(node) || node.arguments.length !== 1 || !t.isExpression(node.arguments[0]) || !isSafe(node.arguments[0], param)) return false
    const callee = node.callee
    if (t.isIdentifier(callee)) return Object.hasOwn(HELPERS, callee.name)
    if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.property)) return false
    const method = callee.property.name
    if (t.isRegExpLiteral(callee.object)) return method === "test"
    if (t.isIdentifier(callee.object) && Object.hasOwn(STATICS, callee.object.name)) return Object.hasOwn(STATICS[callee.object.name], method)
    return STRING_METHODS.has(method) && isSafe(callee.object, param)
}

function baseLabel(properties) {
    if (!t.isObjectExpression(properties)) return null
    const entry = properties.properties.find(property => t.isObjectProperty(property) && !property.computed &&
        (t.isStringLiteral(property.key, { value: "extends" }) || t.isIdentifier(property.key, { name: "extends" })))
    const spec = entry?.value
    if (t.isStringLiteral(spec)) return spec.value
    if (!t.isCallExpression(spec) || !t.isIdentifier(spec.callee, { name: "__type_spec__" })) return null
    const labels = spec.arguments.map(ref => t.isCallExpression(ref) && t.isIdentifier(ref.callee, { name: "__type_ref__" }) && t.isStringLiteral(ref.arguments[0]) ? ref.arguments[0].value : null)
    return labels.length && labels.every(Boolean) ? labels.join(" | ") : null
}

function bodyPredicate(fn) {
    if (!(t.isArrowFunctionExpression(fn) || t.isFunctionExpression(fn)) || fn.async || fn.generator) return null
    if (fn.params.length !== 1 || !t.isIdentifier(fn.params[0])) return null
    const expression = returnedExpression(fn)
    const param = fn.params[0].name
    if (!expression || !isSafe(expression, param)) return null
    return { param, source: generate(expression, { comments: false }).code }
}

export function describePredicate(fn, properties) {
    const body = bodyPredicate(fn)
    const base = baseLabel(properties)
    if (!body && !base) return null
    return { ...body, ...(base ? { base } : {}) }
}

function binary(operator, left, right) {
    switch (operator) {
        case "==": return left == right
        case "!=": return left != right
        case "===": return left === right
        case "!==": return left !== right
        case "<": return left < right
        case "<=": return left <= right
        case ">": return left > right
        case ">=": return left >= right
        case "+": return left + right
        case "-": return left - right
        case "*": return left * right
        case "/": return left / right
        case "%": return left % right
        case "**": return left ** right
    }
    throw UNKNOWN
}

function evaluate(node, param, value) {
    if (t.isIdentifier(node)) {
        if (node.name === param) return value
        if (Object.hasOwn(GLOBAL_VALUES, node.name)) return GLOBAL_VALUES[node.name]
        throw UNKNOWN
    }
    if (t.isNumericLiteral(node) || t.isStringLiteral(node) || t.isBooleanLiteral(node)) return node.value
    if (t.isNullLiteral(node)) return null
    if (t.isBigIntLiteral(node)) return BigInt(node.value)
    if (t.isUnaryExpression(node)) {
        const argument = evaluate(node.argument, param, value)
        if (node.operator === "!") return !argument
        if (node.operator === "typeof") return typeof argument
        if (node.operator === "-") return -argument
        if (typeof argument === "bigint") throw UNKNOWN
        return +argument
    }
    if (t.isBinaryExpression(node)) {
        const left = evaluate(node.left, param, value)
        const right = evaluate(node.right, param, value)
        if ((typeof left === "bigint") !== (typeof right === "bigint") && !["==", "!=", "===", "!==", "<", "<=", ">", ">="].includes(node.operator)) throw UNKNOWN
        return binary(node.operator, left, right)
    }
    if (t.isLogicalExpression(node)) {
        const left = evaluate(node.left, param, value)
        if (node.operator === "&&") return left ? evaluate(node.right, param, value) : left
        if (node.operator === "||") return left ? left : evaluate(node.right, param, value)
        return left ?? evaluate(node.right, param, value)
    }
    if (t.isConditionalExpression(node)) {
        return evaluate(node.test, param, value) ? evaluate(node.consequent, param, value) : evaluate(node.alternate, param, value)
    }
    if (t.isMemberExpression(node)) {
        const object = evaluate(node.object, param, value)
        if (typeof object === "string" || Array.isArray(object)) return object.length
        throw UNKNOWN
    }
    if (t.isCallExpression(node)) {
        const argument = evaluate(node.arguments[0], param, value)
        const callee = node.callee
        if (t.isIdentifier(callee)) return HELPERS[callee.name](argument)
        const method = callee.property.name
        if (t.isRegExpLiteral(callee.object)) {
            return new RegExp(callee.object.pattern, callee.object.flags.replace(/[gy]/g, "")).test(String(argument))
        }
        if (t.isIdentifier(callee.object) && Object.hasOwn(STATICS, callee.object.name)) return STATICS[callee.object.name][method](argument)
        const object = evaluate(callee.object, param, value)
        if (typeof object !== "string" || typeof argument !== "string") throw UNKNOWN
        return object[method](argument)
    }
    throw UNKNOWN
}

export function predicateHolds(predicate, value) {
    if (!predicate.source) return null
    let expression = parsed.get(predicate.source)
    if (!expression) {
        try {
            expression = parseExpression(predicate.source)
        } catch {
            return null
        }
        parsed.set(predicate.source, expression)
    }
    try {
        return Boolean(evaluate(expression, predicate.param, value))
    } catch {
        return null
    }
}
