import * as t from "@babel/types"

export const SKIP_KEYS = new Set([
    "loc", "start", "end", "extra", "range", "leadingComments", "trailingComments", "innerComments",
    "typeAnnotation", "returnType", "typeParameters", "typeArguments", "superTypeParameters"
])

export const PREFIX_CALLS = {
    sizeof: "__sizeof__",
    kindof: "__kindof__",
    empty: "__is_empty__",
    copyof: "__copyof__",
    lock: "__lock_object__"
}

export const NOT_STRUCTS = new Set(["any", "object"])
export const STRUCTURAL_PATTERNS = new Set(["ObjectExpression", "ArrayExpression", "CallExpression"])
export const FUNCTION_TYPES = new Set([
    "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"
])

export function returnsOf(node, found = []) {
    if (!isNode(node) || /Function|ClassMethod|ObjectMethod/.test(node.type)) return found
    if (node.type === "ReturnStatement" && node.argument) found.push(node)
    for (const [key, value] of Object.entries(node)) {
        if (SKIP_KEYS.has(key)) continue
        if (Array.isArray(value)) value.forEach(child => returnsOf(child, found))
        else if (isNode(value)) returnsOf(value, found)
    }
    return found
}

export function suspends(node, type) {
    if (Array.isArray(node)) return node.some(child => suspends(child, type))
    if (!isNode(node) || FUNCTION_TYPES.has(node.type) || node.type === "ClassProperty" || node.type === "ClassPrivateProperty") return false
    if (node.type === type) return true
    return Object.entries(node).some(([key, value]) => !SKIP_KEYS.has(key) && suspends(value, type))
}

const OWN_ARGUMENTS = new Set([
    "FunctionDeclaration", "FunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod", "ClassProperty", "ClassPrivateProperty"
])

export function replaceArguments(node) {
    let found = false
    const visit = value => {
        if (Array.isArray(value)) return value.forEach(visit)
        if (!isNode(value) || OWN_ARGUMENTS.has(value.type)) return
        for (const [key, child] of Object.entries(value)) {
            if (SKIP_KEYS.has(key)) continue
            const named = (value.type === "MemberExpression" || value.type === "OptionalMemberExpression" || value.type === "ObjectProperty") &&
                (key === "property" || key === "key") && !value.computed
            if (isNode(child) && child.type === "Identifier" && child.name === "arguments" && !named) {
                child.name = "__match_arguments"
                found = true
            } else {
                visit(child)
            }
        }
    }
    visit(node.body)
    return found
}

export function typeParamNodes(node) {
    return Array.isArray(node.typeParameters) ? node.typeParameters : node.typeParameters?.params ?? []
}

export function typeParamNames(node) {
    return typeParamNodes(node).map(param => typeof param.name === "string" ? param.name : param.name?.name).filter(Boolean)
}

export function numericValue(node) {
    if (node.type === "NumericLiteral" && Number.isInteger(node.value)) return node.value
    if (node.type === "UnaryExpression" && node.operator === "-" && node.argument.type === "NumericLiteral" && Number.isInteger(node.argument.value)) {
        return -node.argument.value
    }
    return null
}

export const isNode = value =>!!value && typeof value === "object" && typeof value.type === "string"

export function withLoc(node, from) {
    if (from && typeof from.start === "number") {
        node.start = from.start
        node.end = from.end
        node.loc = from.loc
    }
    return node
}

export function forgetLoc(node) {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) return node.forEach(forgetLoc)
    delete node.start
    delete node.end
    delete node.loc
    for (const [key, value] of Object.entries(node)) {
        if (key !== "extra" && value && typeof value === "object") forgetLoc(value)
    }
}

export const id = name => t.identifier(name)
export const str = value => t.stringLiteral(value)
export const call = (name, args) => t.callExpression(id(name), args)

export function escapeMarkupText(text) {
    return text.replace(/[\\`]/g, "\\$&")
}

export function keyName(key) {
    if (!key) return null
    if (key.type === "Identifier") return key.name
    if (key.type === "StringLiteral") return key.value
    if (key.type === "PrivateName") return `#${key.id.name}`
    return null
}

const isHookName = name => /^use[A-Z]/.test(name)

export function hookBodies(declaration) {
    if (declaration?.type === "FunctionDeclaration") return isHookName(declaration.id?.name ?? "") ? [declaration.body] : []
    if (declaration?.type !== "VariableDeclaration") return []
    return declaration.declarations
        .filter(item => item.id.type === "Identifier" && isHookName(item.id.name) && t.isFunction(item.init) && t.isBlockStatement(item.init.body))
        .map(item => item.init.body)
}
