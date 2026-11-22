import * as t from "@babel/types"
import { ANY, unionOf } from "../../external/typeSyntax.js"
import { didYouMean } from "../../suggest.js"
import { INT, classFor, NUMERIC, UNDEFINED, accepts, atoms, describe, isNamed, isNever, isNullish, isOpen, single, sourceText, structFor, widen } from "../core.js"
import { infer } from "../infer.js"
import { checkEnumRawComparison } from "./enums.js"
import { checkNotNullish } from "./nullable.js"
import { staticMember } from "./writes.js"

export const ARITHMETIC = new Set(["-", "*", "/", "%", "**", "&", "|", "^", "<<", ">>", ">>>", "<", ">", "<=", ">="])

const MIXABLE = new Set(["+", "-", "*", "/", "%", "**"])

export function checkBigIntMix(node, path_, env, report) {
    if (!MIXABLE.has(node.operator)) return false
    const kind = side => {
        const type = infer(side, path_, env)
        if (!type) return null
        const all = atoms(type, env).filter(atom => !isNullish(atom))
        if (all.length && all.every(atom => isNamed(atom, "bigint"))) return "bigint"
        if (all.length && all.every(atom => NUMERIC.has(atom.name) || (atom.kind === "literal" && typeof atom.value === "number"))) return "number"
        return null
    }
    const left = kind(node.left)
    const right = kind(node.right)
    if (!left || !right || left === right) return false
    const numberSide = left === "number" ? node.left : node.right
    const text = sourceText(numberSide)
    const fix = t.isNumericLiteral(numberSide) ? `${numberSide.value}n` : `BigInt(${text ?? "..."})`
    report(node, `"${node.operator}" can't mix bigint and number: it throws at runtime — write ${fix}, or Number(...) on the bigint side`)
    return true
}

export function checkArithmetic(node, path_, env, report) {
    if (node.operator === "+") {
        const numeric = side => {
            const type = infer(side, path_, env)
            return !!type && atoms(type, env).every(atom => isNullish(atom) || NUMERIC.has(atom.name) || (atom.kind === "literal" && typeof atom.value === "number"))
        }
        if (!numeric(node.left) || !numeric(node.right)) return
    } else if (!ARITHMETIC.has(node.operator)) return
    for (const side of [node.left, node.right]) {
        if (t.isNullLiteral(side) || t.isIdentifier(side, { name: "undefined" })) continue
        checkNotNullish(side, path_, env, report, `in "${node.operator}" gives a wrong result`)
    }
}

const COMPOUND = new Set(["+=", "-=", "*=", "/=", "%=", "**=", "&=", "|=", "^=", "<<=", ">>=", ">>>="])

function targetType(target, path_, env) {
    if (t.isIdentifier(target)) {
        const binding = path_.scope.getBinding(target.name)
        return binding ? env.bindings.get(binding) ?? null : null
    }
    const member = staticMember(target)
    if (!member) return null
    const objectType = infer(member.object, path_, env)
    const definition = structFor(objectType, env) ?? classFor(objectType, env)
    const field = definition?.fields.get(member.name)
    return field ? (field.optional ? unionOf([field.type, UNDEFINED]) : field.type) : null
}

export function checkCompound(node, path_, env, report) {
    if (!COMPOUND.has(node.operator)) return
    const declared = targetType(node.left, path_, env)
    if (!declared) return
    const result = infer(t.binaryExpression(node.operator.slice(0, -1), node.left, node.right), path_, env)
    if (!result || accepts(declared, result, env)) return
    const subject = sourceText(node.left) ?? "this value"
    const hint = node.operator === "/=" && isNamed(single(declared, env) ?? ANY, "int") ? ` — use "${subject} = ${subject} ~/ ..." for integer division` : ""
    report(node, `"${subject}" is ${describe(declared)}, but "${node.operator}" makes it ${describe(widen(result))}${hint}`)
}

export function checkIncrement(node, path_, env, report) {
    const declared = targetType(node.argument, path_, env)
    if (!declared || accepts(declared, INT, env) || atoms(declared, env).some(atom => isOpen(atom, env))) return
    report(node, `"${sourceText(node.argument) ?? "this value"}" is ${describe(declared)}: "${node.operator}" only works on numbers`)
}

export function literalValue(node) {
    if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) return { value: node.value }
    if (t.isUnaryExpression(node, { operator: "-" }) && t.isNumericLiteral(node.argument)) return { value: -node.argument.value }
    return null
}

export function constantValue(node) {
    if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) return { value: node.value }
    if (t.isNullLiteral(node)) return { value: null }
    if (t.isBigIntLiteral(node)) return { value: BigInt(node.value) }
    if (t.isTemplateLiteral(node) && node.expressions.length === 0) return { value: node.quasis[0].value.cooked }
    if (t.isUnaryExpression(node, { operator: "-" })) {
        const inner = constantValue(node.argument)
        return inner && (typeof inner.value === "number" || typeof inner.value === "bigint") ? { value: -inner.value } : null
    }
    if (t.isArrayExpression(node)) {
        const items = []
        for (const element of node.elements) {
            const item = element && !t.isSpreadElement(element) ? constantValue(element) : null
            if (!item) return null
            items.push(item.value)
        }
        return { value: items }
    }
    return null
}

export function previewConstant(value) {
    if (typeof value === "bigint") return `${value}n`
    if (Array.isArray(value)) return `[${value.map(previewConstant).join(", ")}]`
    return JSON.stringify(value)
}

const TYPEOF_RESULTS = new Set(["string", "number", "bigint", "boolean", "symbol", "undefined", "object", "function"])

export function overlaps(left, right, env) {
    const own = type => atoms(type, env).filter(atom => !isNullish(atom))
    const a = own(left)
    const b = own(right)
    if (a.length === 0 || b.length === 0) return true
    if ([...a, ...b].some(atom => atom.kind === "any" || isOpen(atom, env) || isNever(atom) || isNamed(atom, "object") || atom.kind === "shape")) return true
    const number = atom => NUMERIC.has(atom.name) || (atom.kind === "literal" && typeof atom.value === "number")
    if ((a.some(atom => isNamed(atom, "bigint")) && b.some(number)) || (b.some(atom => isNamed(atom, "bigint")) && a.some(number))) return true
    return a.some(x => b.some(y => accepts(x, y, env) || accepts(y, x, env)))
}

function primitiveKind(atom) {
    if (atom.kind === "literal") return typeof atom.value
    if (atom.kind !== "named") return null
    if (NUMERIC.has(atom.name)) return "number"
    if (atom.name === "string") return "string"
    if (atom.name === "bool") return "boolean"
    return null
}

function looselyOverlaps(left, right, env) {
    const kinds = type => new Set(atoms(type, env).map(primitiveKind).filter(Boolean))
    const a = kinds(left)
    const b = kinds(right)
    return [...a].some(kind => [...b].some(other => other !== kind))
}

export function checkComparison(node, path_, env, report) {
    if (!["==", "===", "!=", "!=="].includes(node.operator)) return
    const negated = node.operator.startsWith("!")
    for (const [side, other] of [[node.left, node.right], [node.right, node.left]]) {
        if (t.isUnaryExpression(side, { operator: "typeof" }) && t.isStringLiteral(other) && !TYPEOF_RESULTS.has(other.value)) {
            report(other, `typeof never gives "${other.value}"${didYouMean(other.value, [...TYPEOF_RESULTS])}`)
            return
        }
    }
    if ([node.left, node.right].some(side => t.isNullLiteral(side) || t.isIdentifier(side, { name: "undefined" }))) return
    const left = infer(node.left, path_, env)
    const right = infer(node.right, path_, env)
    if (!left || !right) return
    if (overlaps(left, right, env)) {
        checkEnumRawComparison(node, left, right, negated, env, report)
        return
    }
    if (node.operator.length === 2 && looselyOverlaps(left, right, env)) return
    report(node, `this comparison is always ${negated ? "true" : "false"}: ${describe(left)} and ${describe(right)} have no value in common`)
}

export function checkZeroDivisor(node, report) {
    if (!t.isCallExpression(node) || !t.isIdentifier(node.callee, { name: "__intdiv__" })) return
    const divisor = node.arguments[1]
    if (t.isNumericLiteral(divisor, { value: 0 })) report(divisor, `integer division by 0 has no result`)
}

export function checkNumberLiteral(node, report) {
    const raw = node.extra?.raw ?? ""
    if (!Number.isInteger(node.value) || Number.isSafeInteger(node.value) || /^[0-9_]*[.eE]/.test(raw)) return
    report(node, `${raw} is too large to be stored exactly (beyond ±2^53), it becomes ${node.value} — write ${raw.replace(/_/g, "")}n for a bigint`)
}

function constantNumber(node) {
    if (t.isNumericLiteral(node)) return node.value
    if (t.isUnaryExpression(node, { operator: "-" })) {
        const value = constantNumber(node.argument)
        return value === null ? null : -value
    }
    if (t.isBinaryExpression(node) && ["**", "*", "+", "-"].includes(node.operator)) {
        const left = constantNumber(node.left)
        const right = constantNumber(node.right)
        if (left === null || right === null) return null
        return node.operator === "**" ? left ** right : node.operator === "*" ? left * right : node.operator === "+" ? left + right : left - right
    }
    return null
}

export function checkConstantOverflow(path_, report) {
    if (path_.parentPath.isBinaryExpression() || path_.parentPath.isUnaryExpression()) return
    const value = constantNumber(path_.node)
    if (value === null || !Number.isInteger(value) || Number.isSafeInteger(value)) return
    if (constantNumber(path_.node.left) === null || ![path_.node.left, path_.node.right].every(side => Number.isSafeInteger(constantNumber(side)))) return
    const show = (node, suffix) => t.isNumericLiteral(node) ? `${(node.extra?.raw ?? String(node.value)).replace(/_/g, "")}${suffix}`
        : t.isUnaryExpression(node) ? `-${show(node.argument, suffix)}`
        : `${show(node.left, suffix)} ${node.operator} ${show(node.right, suffix)}`
    report(path_.node, `"${show(path_.node, "")}" is ${value}, too large to be stored exactly (beyond ±2^53) — use bigint: ${show(path_.node, "n")}`)
}
