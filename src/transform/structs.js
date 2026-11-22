import _traverse from "@babel/traverse"
import * as t from "@babel/types"
import { readType } from "../external/typeSyntax.js"
import { moduleTypes } from "../checker/modules.js"
import { isRuntimeCall } from "./typeSpecs.js"

const traverse = _traverse.default ?? _traverse

const PLAIN_NAMES = new Set([
    "int", "float", "number", "string", "bool", "null", "undefined", "object", "array", "function", "any",
    "unknown", "void", "never", "element", "bigint", "symbol",
    "Record", "Map", "Set", "Promise", "Array", "Date", "RegExp", "Error", "Function", "Object"
])

const NOT_STRUCT = new Set(["__def_trait__", "__type_def__", "__def_enum__", "__def_variants__"])

function scopeOf(structs, enums, aliases, customTypes, classes) {
    return { structs, enums, aliases, customTypes, classes }
}

function localScope(ast) {
    const structs = new Map()
    const others = new Set()
    traverse(ast, {
        CallExpression(path_) {
            const { callee, arguments: [name] } = path_.node
            if (!t.isIdentifier(callee) || !t.isStringLiteral(name)) return
            if (callee.name === "__def_struct__") structs.set(name.value, {})
            else if (NOT_STRUCT.has(callee.name)) others.add(name.value)
        },
        Class(path_) {
            if (path_.node.id) others.add(path_.node.id.name)
        }
    })
    return scopeOf(structs, new Map(), new Map(), others, new Map())
}

export function typeScopes({ env = null, ast, sources = [] }) {
    if (env) return [scopeOf(env.structs, env.enums, env.aliases, env.customTypes, env.classDefs)]
    const scopes = [localScope(ast)]
    for (const source of sources) {
        const ambient = source ? moduleTypes.get(source)?.ambient : null
        if (ambient) scopes.push(scopeOf(ambient.structs, ambient.enums, ambient.aliases, ambient.customTypes, ambient.classes ?? new Map()))
    }
    return scopes
}

function kindOf(name, scopes) {
    let known = PLAIN_NAMES.has(name)
    for (const scope of scopes) {
        const struct = scope.structs.get(name)
        if (struct && !struct.trait) return "struct"
        if (struct || scope.enums.has(name) || scope.aliases.has(name) || scope.customTypes.has(name) || scope.classes.has(name)) known = true
    }
    return known ? "other" : null
}

function holderNames(type, names) {
    if (type.kind === "union") {
        for (const part of type.types) holderNames(part, names)
    } else if (type.kind === "named" || type.kind === "generic") {
        names.push(type.name)
    }
    return names
}

export function holdsNoStruct(label, scopes) {
    const type = readType(label)
    return holderNames(type.kind === "array" ? type.element : type, []).every(name => kindOf(name, scopes) === "other")
}

export function dropPlainStructCasts(ast, scopes) {
    traverse(ast, {
        CallExpression(path_) {
            const { node } = path_
            if (!isRuntimeCall(node, "__as_struct__")) return
            const [value, label] = node.arguments
            if (!value || !t.isStringLiteral(label) || !holdsNoStruct(label.value, scopes)) return
            path_.replaceWith(value)
        }
    })
}
