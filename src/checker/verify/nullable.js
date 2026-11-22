import * as t from "@babel/types"
import { formatType } from "../../external/typeSyntax.js"
import { didYouMean } from "../../suggest.js"
import { classFor, atoms, isNamed, isNullish, sourceText, structFor } from "../core.js"
import { infer } from "../infer.js"
import { hasMember, memberNames } from "./members.js"

export function checkNullable(node, path_, env, report, type = infer(node.object, path_, env)) {
    if (node.optional || t.isOptionalMemberExpression(node)) return false
    if (!type) return false

    const all = atoms(type, env)
    const nullish = all.filter(isNullish)
    if (nullish.length === 0) return false

    const subject = sourceText(node.object)
    const which = nullish.some(atom => isNamed(atom, "null")) ? "null" : "undefined"
    const shown = subject ? `"${subject}"` : "this value"
    if (nullish.length === all.length) report(node.object, `${shown} is ${which} here, so it has no properties`)
    else report(node.object, `${shown} may be ${which} here (${formatType(type)}) — check it first or use "?."`)
    return true
}

export function checkNullableCall(node, path_, env, report) {
    const callee = node.callee
    if (!t.isMemberExpression(callee) && !t.isIdentifier(callee)) return
    if (t.isMemberExpression(callee) && (callee.computed || !t.isIdentifier(callee.property))) return
    const type = infer(callee, path_, env)
    if (!type) return
    const all = atoms(type, env)
    const nullish = all.filter(isNullish)
    if (nullish.length === 0 || nullish.length === all.length) return
    const subject = sourceText(callee)
    if (!subject) return
    const which = nullish.some(atom => isNamed(atom, "null")) ? "null" : "undefined"
    report(callee, `"${subject}" may be ${which} here (${formatType(type)}) — check it first or call it with "?.()"`)
}

export function checkUnionMember(node, present, env, report) {
    const definitions = present.map(atom => structFor(atom, env) ?? classFor(atom, env))
    if (definitions.some(definition => !definition || definition.open)) return

    const field = node.property.name
    const missing = definitions.find(definition => !hasMember(definition, field))
    if (!missing) return
    const owners = definitions.filter(definition => hasMember(definition, field))
    const hint = owners.length ? ` — narrow it to ${owners.map(definition => `"${definition.label}"`).join(" or ")} first` : didYouMean(field, memberNames(missing))
    report(node.property, `"${missing.label}" has no field "${field}"${hint}`)
}

export function checkConstant(node, name, binding, report) {
    if (binding?.kind !== "const") return false
    report(node, `"${name}" is a constant: declare it with let to assign it again`)
    return true
}

function nullishParts(node, path_, env) {
    const type = infer(node, path_, env)
    if (!type) return null
    const all = atoms(type, env)
    const nullish = all.filter(isNullish)
    if (nullish.length === 0) return null
    return { type, all, nullish, which: nullish.some(atom => isNamed(atom, "null")) ? "null" : "undefined" }
}

export function checkNotNullish(node, path_, env, report, action) {
    const found = nullishParts(node, path_, env)
    if (!found) return false
    const subject = sourceText(node)
    const shown = subject ? `"${subject}"` : "this value"
    if (found.nullish.length === found.all.length) report(node, `${shown} is ${found.which} here, and ${found.which} ${action}`)
    else report(node, `${shown} may be ${found.which} here (${formatType(found.type)}) — check it first: ${found.which} ${action}`)
    return true
}

export function checkNullableConcat(node, path_, env, report) {
    if (node.operator !== "+") return
    const stringy = side => {
        const type = infer(side, path_, env)
        return !!type && atoms(type, env).every(atom => isNamed(atom, "string") || (atom.kind === "literal" && typeof atom.value === "string"))
    }
    for (const [side, other] of [[node.left, node.right], [node.right, node.left]]) {
        if (!stringy(other) || t.isNullLiteral(side) || t.isIdentifier(side, { name: "undefined" })) continue
        const type = infer(side, path_, env)
        if (!type) continue
        const all = atoms(type, env)
        const nullish = all.filter(isNullish)
        if (nullish.length === 0) continue
        const which = nullish.some(atom => isNamed(atom, "null")) ? "null" : "undefined"
        const text = sourceText(side)
        report(side, `${text ? `"${text}"` : "this value"} ${nullish.length === all.length ? "is" : "may be"} ${which} here (${formatType(type)}) — "+" would put "${which}" into the text: check it first or use ${text ?? "it"} ?? ""`)
        return
    }
}
