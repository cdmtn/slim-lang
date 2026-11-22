import * as t from "@babel/types"
import { ANY, genericOf, readType, unionOf } from "../../external/typeSyntax.js"
import { BOOL, atoms, receiverThis, isNullish, widen } from "../core.js"
import { infer } from "../infer.js"
import { callbackReturn } from "./methods.js"

export function enumMethod(atom, method, env) {
    if (atom.kind !== "named" && atom.kind !== "generic" && atom.kind !== "enumMember") return null
    const definition = env.enums.get(atom.name)
    const signature = definition?.methods?.get(method) ?? enumTraitDefault(definition, method, env)
    if (!signature) return null
    const params = definition.typeParams ?? []
    const bound = new Map(params.map((param, index) => [param, atom.kind === "generic" ? atom.args[index] ?? ANY : ANY]))
    bound.set("this", receiverThis(atom))
    return { signature, bound, definition }
}

function enumTraitDefault(definition, method, env) {
    for (const label of definition?.traits ?? []) {
        const trait = env.structs.get(readType(label).name)
        if (trait?.trait && !trait.required.has(method) && trait.methods.has(method)) return trait.methods.get(method)
    }
    return null
}

export function variantSignature(definition, tag) {
    const fields = definition?.variants?.get(tag)
    if (!fields) return null
    return {
        parameters: fields.map(field => ({ name: field.name, type: field.type, required: true })),
        rest: false, returns: null, async: false, typed: true, node: null, typeParams: definition.typeParams ?? []
    }
}

export function variantOf(node, env) {
    if (!t.isMemberExpression(node) || node.computed || !t.isIdentifier(node.object) || !t.isIdentifier(node.property)) return null
    const definition = env.enums.get(node.object.name)
    if (!definition?.variants?.has(node.property.name)) return null
    return { name: node.object.name, tag: node.property.name, definition }
}

export function enumTypeArgs(definition, name, type, env) {
    const atom = type && atoms(type, env).find(part => (part.kind === "generic" || part.kind === "enumMember") && part.name === name && part.args)
    return new Map((definition.typeParams ?? []).map((param, index) => [param, atom?.args[index] ?? ANY]))
}

export function tryTarget(type, env) {
    const present = type ? atoms(type, env).filter(atom => !isNullish(atom)) : []
    const fits = atom => (atom.kind === "generic" || atom.kind === "named" || atom.kind === "enumMember") && (atom.name === "Result" || atom.name === "Option")
    if (present.length === 0 || !present.every(atom => fits(atom) && atom.name === present[0].name)) return null
    return present.find(atom => atom.kind === "generic") ?? present[0]
}

const VARIANT_METHODS = new Set(["isOk", "isErr", "isSome", "isNone"])

export function variantMethodType(atom, method, call, path_, env) {
    const value = atom.kind === "generic" ? atom.args[0] ?? ANY : ANY
    if (VARIANT_METHODS.has(method)) return BOOL
    if (method === "unwrap") return value
    if (method === "unwrapOr") {
        const fallback = call.arguments[0] ? infer(call.arguments[0], path_, env) : null
        return fallback ? unionOf([value, widen(fallback)]) : null
    }
    if (method === "map") {
        const result = callbackReturn(call.arguments[0], path_, env)
        return genericOf(atom.name, [result ?? ANY, ...(atom.kind === "generic" ? atom.args.slice(1) : [])])
    }
    return null
}
