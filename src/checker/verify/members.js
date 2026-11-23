import * as t from "@babel/types"
import { unionOf } from "../../external/typeSyntax.js"
import { didYouMean } from "../../suggest.js"
import { NUMERIC, atoms, describe, isArrayLike, isNullish, literalBase, sourceText, widen } from "../core.js"
import { usesOwnThis } from "./calls.js"

export const memberNames = definition => [...new Set([...definition.fields.keys(), ...definition.methods.keys(), ...(definition.members ?? [])])]
const OBJECT_MEMBERS = prototypeNames({}, ["constructor"])
export const hasMember = (definition, name) => definition.open || definition.fields.has(name) || definition.methods.has(name) ||
    !!definition.members?.has(name) || (!!definition.isClass && OBJECT_MEMBERS.has(name))

export function checkDetachedMethod(node, path_, definition, report) {
    if (!definition?.isClass) return
    const name = node.property.name
    const method = definition.methods.get(name)
    if (!method?.node || definition.fields.has(name) || definition.rebound?.has(name)) return
    const parent = path_.parent
    const key = path_.key
    const passed = (t.isVariableDeclarator(parent) && key === "init") || (t.isAssignmentExpression(parent) && key === "right") ||
        ((t.isCallExpression(parent) || t.isNewExpression(parent)) && path_.listKey === "arguments") || t.isReturnStatement(parent) ||
        (t.isObjectProperty(parent) && key === "value") || t.isArrayExpression(parent) || (t.isArrowFunctionExpression(parent) && key === "body")
    if (!passed) return
    const usage = usesOwnThis(method.node)
    if (!usage) return
    const text = sourceText(node)
    report(node.property, `"${text ?? name}" loses its "this" when taken off the object — call it in place, use ${text ? `${text}.bind(${sourceText(node.object) ?? "..."})` : ".bind(...)"} or wrap it: () => ${text ?? name}()`)
}

function prototypeNames(value, own = []) {
    const names = new Set(own)
    for (let proto = Object.getPrototypeOf(value); proto; proto = Object.getPrototypeOf(proto)) {
        for (const name of Object.getOwnPropertyNames(proto)) names.add(name)
    }
    return names
}

const BUILTIN_MEMBERS = {
    string: prototypeNames("", ["length"]),
    number: prototypeNames(0),
    bool: prototypeNames(true),
    array: prototypeNames([], ["length"]),
    Map: prototypeNames(new Map()),
    Set: prototypeNames(new Set()),
    Date: prototypeNames(new Date()),
    RegExp: prototypeNames(/x/, ["lastIndex"]),
    Promise: prototypeNames(Promise.resolve()),
    Error: prototypeNames(new Error(), ["stack", "cause"]),
    Response: prototypeNames(new Response())
}

function builtinMembers(atom) {
    if (isArrayLike(atom)) return BUILTIN_MEMBERS.array
    const name = atom.kind === "literal" ? literalBase(atom).name : atom.kind === "named" || atom.kind === "generic" ? atom.name : null
    if (NUMERIC.has(name)) return BUILTIN_MEMBERS.number
    return Object.hasOwn(BUILTIN_MEMBERS, name) ? BUILTIN_MEMBERS[name] : null
}

export function checkBuiltinMember(node, type, env, report) {
    const present = atoms(type, env).filter(atom => !isNullish(atom))
    const sets = present.map(builtinMembers)
    if (present.length === 0 || sets.some(set => !set)) return false

    const member = node.property.name
    if (sets.every(set => set.has(member))) return true

    const missing = sets.find(set => !set.has(member))
    report(node.property, `${describe(widen(unionOf(present)))} has no property "${member}"${didYouMean(member, missing)}`)
    return true
}
