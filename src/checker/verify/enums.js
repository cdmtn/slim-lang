import * as t from "@babel/types"
import { didYouMean } from "../../suggest.js"
import { atoms, describe, isNamed, isNullish, sourceText, traitName, variantField, widen } from "../core.js"
import { infer, variantOf, variantSignature } from "../infer.js"
import { checkCall } from "./calls.js"
import { checkTry } from "./control.js"
import { ARITHMETIC, literalValue } from "./operators.js"

const ENUM_API = new Set(["from", "has", "keys", "values", "scheme", "name", "type", "fromJSON", "attempt", "fromPromise"])
const VARIANT_MEMBERS = new Set(["$tag", "toString", "toJSON", "unwrap", "unwrapOr", "map", "mapErr", "isOk", "isErr", "isSome", "isNone"])

export function checkVariantMember(node, present, env, report) {
    const name = node.property.name
    for (const atom of present) {
        const found = variantField(atom, name, env)
        const { definition } = found.variants
        if (found.missing.length === 0 || VARIANT_MEMBERS.has(name) || definition.methods?.has(name)) continue
        if ((definition.traits ?? []).some(label => env.structs.get(traitName(label))?.methods.has(name))) continue
        const label = tag => `${atom.name}.${tag}`
        if (found.owners.length) {
            report(node.property, `"${label(found.missing[0])}" has no field "${name}" — narrow it to ${found.owners.map(tag => `"${label(tag)}"`).join(" or ")} first`)
        } else {
            const known = [...definition.variants.values()].flatMap(fields => fields?.map(field => field.name) ?? [])
            const subject = atom.kind === "enumMember" ? label(atom.member) : atom.name
            report(node.property, `"${subject}" has no field "${name}"${didYouMean(name, [...known, ...(definition.methods?.keys() ?? [])])}`)
        }
        return
    }
}

export function checkEnumMember(node, path_, env, report) {
    if (!t.isIdentifier(node.object)) return false
    const definition = env.enums.get(node.object.name)
    const binding = path_.scope.getBinding(node.object.name)
    if (!definition || (binding && !isDefinedBy(binding, "__def_enum__"))) return false

    const member = node.property.name
    if (!definition.members.has(member) && !ENUM_API.has(member)) {
        report(node.property, `"${node.object.name}" has no member "${member}"${didYouMean(member, definition.members)}`)
    }
    return true
}

function isDefinedBy(binding, runtimeCall) {
    const init = binding.path.isVariableDeclarator() ? binding.path.node.init : null
    return t.isCallExpression(init) && t.isIdentifier(init.callee, { name: runtimeCall })
}

export function checkVariantCalls(node, path_, env, report) {
    const callee = node.callee
    if (t.isIdentifier(callee, { name: "__variant_value__" })) {
        const variant = variantOf(node.arguments[1], env)
        const fields = variant?.definition.variants.get(variant.tag)
        const index = node.arguments[2]?.value
        if (fields && index === fields.length) {
            report(node, `"${variant.name}.${variant.tag}" has ${fields.length} field${fields.length === 1 ? "" : "s"}, the pattern gives more`)
        }
        return true
    }
    if (t.isIdentifier(callee, { name: "__variant_is__" })) {
        const variant = variantOf(node.arguments[1], env)
        if (variant && !variant.definition.variants.get(variant.tag)) {
            report(node.arguments[1], `"${variant.name}.${variant.tag}" carries no data: match it without (...)`)
        }
        return true
    }
    if (t.isIdentifier(callee, { name: "__try__" })) {
        checkTry(node, path_, env, report)
        return true
    }
    const variant = variantOf(callee, env)
    if (!variant) return false
    checkCall(variantSignature(variant.definition, variant.tag), node, `${variant.name}.${variant.tag}`, path_, env, report)
    return true
}

export function checkEnumFrom(node, env, report) {
    const callee = node.callee
    if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.object) || !t.isIdentifier(callee.property, { name: "from" })) return
    const values = env.enums.get(callee.object.name)?.values
    const found = literalValue(node.arguments[0])
    if (!values || !found || [...values.values()].includes(found.value)) return
    report(node.arguments[0], `${JSON.stringify(found.value)} is not a value of "${callee.object.name}" — use one of ${[...values.values()].map(value => JSON.stringify(value)).join(", ")}`)
}

function plainEnumName(type, env) {
    const present = atoms(type, env).filter(atom => !isNullish(atom))
    const names = new Set(present.map(atom => {
        const definition = (atom.kind === "enumMember" || atom.kind === "named") && env.enums.get(atom.name)
        return definition && !definition.variants && !definition.builtin ? atom.name : null
    }))
    const [name] = names
    return present.length && names.size === 1 && name ? name : null
}

function rawValue(type, env) {
    const present = atoms(type, env).filter(atom => !isNullish(atom))
    return present.length > 0 && present.every(atom => atom.kind === "literal" || (atom.kind === "named" && ["int", "float", "number", "string", "bool"].includes(atom.name)))
}

export function checkEnumRawComparison(node, left, right, negated, env, report) {
    for (const [side, type, other] of [[node.left, left, right], [node.right, right, left]]) {
        const name = plainEnumName(type, env)
        if (!name || !rawValue(other, env)) continue
        const text = sourceText(side) ?? "the enum side"
        const rawNode = side === node.left ? node.right : node.left
        const raw = sourceText(rawNode) ?? (t.isStringLiteral(rawNode) || t.isNumericLiteral(rawNode) ? JSON.stringify(rawNode.value) : null)
        const constant = t.isMemberExpression(side) && t.isIdentifier(side.object, { name })
        const fix = raw ? `compare with ${name}.from(${raw})` : `compare with ${name}.from(value)`
        report(node, `this comparison is always ${negated ? "true" : "false"}: "${text}" is a ${name} member and ${describe(widen(other))} is a raw value — ${fix}${constant ? "" : `, or use ${text}.value`}`)
        return
    }
}

function enumOperand(node, path_, env) {
    const type = infer(node, path_, env)
    if (!type) return null
    const present = atoms(type, env).filter(atom => !isNullish(atom))
    if (present.length === 0) return null
    const plain = atom => {
        const definition = (atom.kind === "enumMember" || atom.kind === "named") && env.enums.get(atom.name)
        return !!definition && !definition.variants && !definition.builtin
    }
    return present.every(plain) ? type : null
}

export function checkEnumArithmetic(node, path_, env, report) {
    if (!ARITHMETIC.has(node.operator) && node.operator !== "+") return false
    if (node.operator === "+" && [node.left, node.right].some(side => {
        const type = infer(side, path_, env)
        return !!type && atoms(type, env).some(atom => isNamed(atom, "string") || (atom.kind === "literal" && typeof atom.value === "string"))
    })) return false
    for (const side of [node.left, node.right]) {
        const type = enumOperand(side, path_, env)
        if (!type) continue
        const text = sourceText(side)
        report(side, `${text ? `"${text}"` : "this value"} is ${describe(type)}, an enum member and not a number — use ${text ? `${text}.value` : ".value"} for its raw value`)
        return true
    }
    return false
}
