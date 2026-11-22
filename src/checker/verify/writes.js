import * as t from "@babel/types"
import { ANY, unionOf } from "../../external/typeSyntax.js"
import { didYouMean } from "../../suggest.js"
import { exactRecordKeys, atoms, describe, isNamed, isNullish, single, sourceText, structFor, widen } from "../core.js"
import { infer } from "../infer.js"
import { checkValue } from "./values.js"

export const MUTATING = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"])

function readonlyList(node, path_, env) {
    const type = infer(node, path_, env)
    const present = type ? atoms(type, env).filter(atom => !isNullish(atom)) : []
    return present.length > 0 && present.every(atom => atom.readonly) ? unionOf(present) : null
}

export function checkReadonlyChange(target, change, path_, env, report) {
    const list = readonlyList(target, path_, env)
    if (!list) return false
    report(target, `${sourceText(target) ? `"${sourceText(target)}"` : "this value"} is ${describe(list)}: ${change} would change it`)
    return true
}

const READONLY_BUILTIN = new Map([
    ["length", atom => isNamed(atom, "string") || (atom.kind === "literal" && typeof atom.value === "string")],
    ["size", atom => (atom.kind === "generic" || atom.kind === "named") && (atom.name === "Map" || atom.name === "Set")]
])

export function checkBuiltinWrite(target, path_, env, report) {
    if (!t.isMemberExpression(target) || target.computed || !t.isIdentifier(target.property)) return false
    const test = READONLY_BUILTIN.get(target.property.name)
    if (!test) return false
    const type = infer(target.object, path_, env)
    const present = type ? atoms(type, env).filter(atom => !isNullish(atom)) : []
    if (!present.length || !present.every(test)) return false
    report(target, `"${sourceText(target) ?? target.property.name}" can't be changed: ${describe(widen(type))} has a read-only "${target.property.name}"`)
    return true
}

export function staticMember(node) {
    if (!t.isMemberExpression(node)) return null
    if (!node.computed && t.isIdentifier(node.property)) return { object: node.object, name: node.property.name }
    if (node.computed && t.isStringLiteral(node.property)) return { object: node.object, name: node.property.value }
    return null
}

export function checkDelete(node, path_, env, report) {
    const member = staticMember(node.argument)
    if (!member) return
    const definition = structFor(infer(member.object, path_, env), env)
    const field = definition?.fields.get(member.name)
    if (!field || field.optional || definition.open) return
    report(node, `"${definition.label}.${member.name}" is required: deleting it breaks the ${definition.shape ? "object" : "struct"}`)
}

function rootIdentifier(node) {
    while (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) node = node.object
    return t.isIdentifier(node) ? node : null
}

function lockedAt(target, path_) {
    const root = rootIdentifier(target)
    if (!root || root === target) return null
    const binding = path_.scope.getBinding(root.name)
    if (!binding) return null
    const init = binding.path.isVariableDeclarator() ? binding.path.node.init : null
    if (binding.kind === "const" && t.isCallExpression(init) && t.isIdentifier(init.callee, { name: "__lock_object__" })) return binding.path
    const fn = path_.getFunctionParent()?.node ?? null
    return binding.referencePaths.find(reference => {
        const call = reference.parentPath
        if (!call?.isCallExpression() || !t.isIdentifier(call.node.callee, { name: "__lock_object__" }) || call.node.arguments[0] !== reference.node) return false
        const statement = call.parentPath
        if (!statement?.isExpressionStatement() || typeof statement.node.end !== "number" || statement.node.end > target.start) return false
        if ((statement.getFunctionParent()?.node ?? null) !== fn) return false
        return !!path_.findParent(parent => parent === statement.parentPath)
    }) ?? null
}

export function checkLockedWrite(target, path_, report) {
    if (typeof target.start !== "number" || !lockedAt(target, path_)) return false
    report(target, `"${rootIdentifier(target).name}" is locked: changing "${sourceText(target) ?? "it"}" throws`)
    return true
}

export function checkRecordWrite(target, value, path_, env, report) {
    const objectType = infer(target.object, path_, env)
    const keys = exactRecordKeys(objectType, env)
    if (!keys) return false
    const name = target.property.name
    const subject = sourceText(target.object) ?? "this record"
    if (!keys.map(String).includes(name)) {
        report(target.property, `"${subject}" is ${describe(objectType)}: it has no key "${name}"${didYouMean(name, keys.map(String))}`)
        return true
    }
    const record = single(objectType, env)
    checkValue(record.args[1] ?? ANY, value, path_, env, report, `"${subject}.${name}"`)
    return true
}

export function checkDeleteElement(node, path_, env, report) {
    if (node.operator !== "delete" || !t.isMemberExpression(node.argument) || !node.argument.computed) return
    const type = infer(node.argument.object, path_, env)
    if (!type || !atoms(type, env).every(atom => atom.kind === "array" || atom.kind === "tuple")) return
    report(node, `"delete" on an array element leaves a hole and keeps the length — use ${sourceText(node.argument.object) ?? "the array"}.splice(index, 1)`)
}

function declaredTarget(target, path_, env) {
    if (t.isIdentifier(target) && !path_.scope.getBinding(target.name) && env.declaredValues.has(target.name)) return { name: target.name, bare: true }
    if (!t.isMemberExpression(target) || !t.isIdentifier(target.object, { name: "globalThis" }) || path_.scope.getBinding("globalThis")) return null
    const name = !target.computed && t.isIdentifier(target.property) ? target.property.name : t.isStringLiteral(target.property) ? target.property.value : null
    return name !== null && env.declaredValues.has(name) ? { name, bare: false } : null
}

export function checkDeclaredWrite(node, target, path_, env, report) {
    const found = declaredTarget(target, path_, env)
    if (!found) return false
    if (found.bare && env.declaredConstants.has(found.name)) {
        report(node, `"${found.name}" is a read-only global: the host provides it, so it can't be assigned here — declare it with "global let" if scripts set it`)
        return true
    }
    if (t.isAssignmentExpression(node, { operator: "=" })) {
        checkValue(env.declaredValues.get(found.name), node.right, path_, env, report, found.bare ? `"${found.name}"` : `"globalThis.${found.name}"`)
    }
    return !t.isAssignmentExpression(node) || node.operator === "="
}
