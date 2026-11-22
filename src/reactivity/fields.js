import * as t from "@babel/types"
import { SKIP_KEYS, call, id, isMarkup, isNode, thunk } from "./ast.js"

const isMember = node => t.isMemberExpression(node) || t.isOptionalMemberExpression(node)
const isCall = node => t.isCallExpression(node) || t.isOptionalCallExpression(node)
const opaque = node => !isNode(node) || t.isFunction(node) || isMarkup(node) || !!node._slimRoot

function some(node, test) {
    if (opaque(node)) return false
    if (test(node)) return true
    for (const [key, value] of Object.entries(node)) {
        if (SKIP_KEYS.has(key)) continue
        if (Array.isArray(value) ? value.some(child => some(child, test)) : some(value, test)) return true
    }
    return false
}

const costly = node => isCall(node) || t.isNewExpression(node) || t.isTaggedTemplateExpression(node)
const writes = node => t.isAssignmentExpression(node) || t.isUpdateExpression(node) || t.isUnaryExpression(node, { operator: "delete" })

function chainKey(node) {
    if (t.isIdentifier(node)) return node.name
    if (!isMember(node)) return null
    const object = chainKey(node.object)
    if (object === null) return null
    const dot = node.optional ? "?." : "."
    if (!node.computed && t.isIdentifier(node.property)) return `${object}${dot}${node.property.name}`
    if (t.isStringLiteral(node.property) || t.isNumericLiteral(node.property)) return `${object}${dot}[${JSON.stringify(node.property.value)}]`
    return null
}

function rootName(node) {
    let current = node
    while (isMember(current)) current = current.object
    return t.isIdentifier(current) ? current.name : null
}

export function hoistFields(expression, ctx, state) {
    const items = ctx.rowItems
    if (!items?.length || !some(expression, costly) || some(expression, writes)) return expression
    const names = new Set(items)
    const fields = state.fields ??= new Map()
    const field = node => {
        const key = chainKey(node)
        let name = fields.get(key)
        if (!name) {
            name = `__f${++state.count}__`
            fields.set(key, name)
            state.declarations.push(t.variableDeclaration("const", [t.variableDeclarator(id(name), call("__field__", [thunk(t.cloneNode(node, true))]))]))
        }
        return t.memberExpression(id(name), id("v"))
    }
    const walk = (node, callee) => {
        if (opaque(node)) return node
        if (isMember(node)) {
            if (!callee && chainKey(node) !== null && names.has(rootName(node))) return field(node)
            node.object = walk(node.object, false)
            if (node.computed) node.property = walk(node.property, false)
            return node
        }
        for (const [key, value] of Object.entries(node)) {
            if (SKIP_KEYS.has(key)) continue
            if (Array.isArray(value)) node[key] = value.map(child => walk(child, false))
            else if (isNode(value)) node[key] = walk(value, isCall(node) && key === "callee")
        }
        return node
    }
    return walk(expression, false)
}

export function takeKeep(root, value) {
    const index = root.attrs.findIndex(attr => attr.name === "keep")
    if (index === -1) return null
    const [attr] = root.attrs.splice(index, 1)
    if (attr.parts) return value(attr)
    if (attr.value === true) return t.booleanLiteral(true)
    const limit = Number(attr.value)
    return Number.isFinite(limit) ? t.numericLiteral(limit) : t.booleanLiteral(true)
}
