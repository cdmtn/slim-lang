import * as t from "@babel/types"
import { ANY, arrayOf, named, readType, substituteType } from "../../external/typeSyntax.js"
import { parseMarkup } from "../../syntax/markup.js"
import { BOOL, FLOAT, INT, STRING, UNDEFINED, atoms, propertyKey, classFor, functionParamType, isNullish, single, structFor, widen } from "../core.js"
import { infer } from "../infer.js"
import { asyncResult, elementType, signatureFor, signatureOfType } from "./signatures.js"
import { bindTypeParams } from "./generics.js"
import { CALLBACK_ELEMENT } from "./methods.js"

const LABELLED_CALLS = new Set(["__typed_variable__", "__as_struct__", "__typed_pattern__"])

function expectedArgument(call, index, env) {
    const node = call.node
    const callee = node.callee
    let signature = null
    let bound = null

    if (t.isIdentifier(callee) && LABELLED_CALLS.has(callee.name)) {
        return index === 0 && t.isStringLiteral(node.arguments[1]) ? readType(node.arguments[1].value) : null
    }
    if (t.isIdentifier(callee)) {
        signature = signatureFor(callee.name, call, env)
    } else if (t.isMemberExpression(callee) && !callee.computed && t.isIdentifier(callee.property)) {
        const receiver = infer(callee.object, call, env)
        const owner = receiver && (structFor(receiver, env) ?? classFor(receiver, env))
        const name = callee.property.name
        signature = owner?.methods.get(name) ?? (owner?.fields.get(name) ? signatureOfType(owner.fields.get(name).type, env) : null)
        bound = owner?.bound ?? null
    }

    const parameters = signature?.parameters ?? []
    const last = parameters[parameters.length - 1]
    const parameter = parameters[index]?.rest || (!parameters[index] && last?.rest) ? (last.type ? { type: elementType(last.type, env) } : null) : parameters[index]
    if (!parameter?.type) return null
    const types = bindTypeParams(signature, node, call, env, bound, true)
    return types.size ? substituteType(parameter.type, types) : parameter.type
}

function expectedCallback(call, index, env) {
    const type = expectedArgument(call, index, env)
    const atom = type && single(type, env)
    return atom?.kind === "function" ? atom : null
}

function propertyType(type, name, env) {
    const options = []
    for (const atom of atoms(type, env)) {
        if (isNullish(atom)) continue
        if (atom.kind === "generic" && atom.name === "Record") {
            options.push(atom.args[1] ?? ANY)
            continue
        }
        const field = (structFor(atom, env) ?? classFor(atom, env))?.fields.get(name)
        if (field) options.push(field.type)
    }
    return options.length === 1 ? options[0] : null
}

export function expectedType(path_, env, depth = 0) {
    const parent = path_.parentPath
    if (!parent || depth > 12) return null
    const node = parent.node
    if (parent.isCallExpression() && path_.listKey === "arguments") {
        if (t.isIdentifier(node.callee) && ["__lock_object__", "__copyof__"].includes(node.callee.name)) return expectedType(parent, env, depth + 1)
        return expectedArgument(parent, path_.key, env)
    }
    if (parent.isObjectProperty() && path_.key === "value") {
        const outer = expectedType(parent.parentPath, env, depth + 1)
        const name = propertyKey(node)
        return outer && name !== null ? propertyType(outer, name, env) : null
    }
    if (parent.isArrayExpression()) {
        const outer = expectedType(parent, env, depth + 1)
        return outer && elementType(outer, env)
    }
    if (parent.isReturnStatement()) {
        const fn = parent.getFunctionParent()
        const declared = fn && env.returns.get(fn.node)
        return declared ? (fn.node.async ? asyncResult(declared.type, env) : declared.type) : null
    }
    if (parent.isArrowFunctionExpression() && path_.key === "body") {
        const outer = expectedType(parent, env, depth + 1)
        const atom = outer && single(outer, env)
        return atom?.kind === "function" ? atom.returns : null
    }
    if ((parent.isConditionalExpression() && path_.key !== "test") || parent.isLogicalExpression() || parent.isSequenceExpression()) {
        return expectedType(parent, env, depth + 1)
    }
    if (parent.isVariableDeclarator() && path_.key === "init" && t.isIdentifier(node.id)) {
        const binding = parent.scope.getBinding(node.id.name)
        return binding ? env.bindings.get(binding) ?? null : null
    }
    if (parent.isAssignmentExpression({ operator: "=" }) && path_.key === "right") {
        if (t.isIdentifier(node.left)) {
            const binding = parent.scope.getBinding(node.left.name)
            return binding ? env.bindings.get(binding) ?? null : null
        }
        if (t.isMemberExpression(node.left) && !node.left.computed && t.isIdentifier(node.left.property)) {
            const object = infer(node.left.object, parent, env)
            return object ? propertyType(object, node.left.property.name, env) : null
        }
    }
    return null
}

const EVENT = "DOM Event"

const EVENT_TARGET = "DOM Event target"

function eventType(env) {
    if (!env.structs.has(EVENT)) {
        const field = type => ({ type, optional: false, readonly: true })
        env.structs.set(EVENT_TARGET, {
            fields: new Map([
                ["value", field(STRING)], ["checked", field(BOOL)], ["valueAsNumber", field(FLOAT)],
                ["id", field(STRING)], ["name", field(STRING)], ["tagName", field(STRING)]
            ]),
            defaults: new Set(), methods: new Map(), parent: null, typeParams: [], open: true
        })
        env.structs.set(EVENT, {
            fields: new Map([
                ["target", field(named(EVENT_TARGET))], ["currentTarget", field(named(EVENT_TARGET))],
                ["type", field(STRING)], ["key", field(STRING)], ["code", field(STRING)],
                ["clientX", field(FLOAT)], ["clientY", field(FLOAT)], ["button", field(INT)], ["deltaY", field(FLOAT)],
                ["shiftKey", field(BOOL)], ["ctrlKey", field(BOOL)], ["altKey", field(BOOL)], ["metaKey", field(BOOL)]
            ]),
            defaults: new Set(),
            methods: new Map([["preventDefault", null], ["stopPropagation", null]]),
            parent: null, typeParams: [], open: true
        })
    }
    return named(EVENT)
}

const eventHolesCache = new WeakMap()

function eventHoles(markup) {
    let holes = eventHolesCache.get(markup)
    if (holes) return holes
    holes = new Set()
    try {
        const visit = node => {
            if (node.type !== "element") return
            if (!/^[A-Z]/.test(node.tag)) for (const attr of node.attrs) if (attr.event !== undefined) holes.add(attr.hole)
            node.children.forEach(visit)
        }
        parseMarkup(markup._slimQuasis, message => { throw new Error(message) }).forEach(visit)
    } catch {
    }
    eventHolesCache.set(markup, holes)
    return holes
}

export function contextualParam(binding, env) {
    const param = binding.path
    const fn = param.parentPath
    if (!fn?.isFunction() || param.listKey !== "params" || !t.isIdentifier(param.node)) return null

    const template = fn.parentPath
    if (template?.isTemplateLiteral() && fn.listKey === "expressions" && param.key === 0) {
        const markup = template.parentPath?.node
        if (markup?._slimMarkup && markup._slimQuasis && eventHoles(markup).has(fn.key)) return eventType(env)
        return null
    }

    const call = fn.parentPath
    if (call?.isCallExpression() && fn.key === "callee" && param.node.name === "__match") {
        return infer(call.node.arguments[0], call, env)
    }
    if (fn.isObjectMethod() && !fn.node.computed) {
        const outer = expectedType(fn.parentPath, env)
        const name = propertyKey(fn.node)
        const atom = outer && name !== null ? single(propertyType(outer, name, env) ?? ANY, env) : null
        return atom?.kind === "function" ? functionParamType(atom, param.key, env) : null
    }
    if (!call?.isCallExpression() || fn.listKey !== "arguments") {
        const outer = expectedType(fn, env)
        const atom = outer && single(outer, env)
        return atom?.kind === "function" ? functionParamType(atom, param.key, env) : null
    }

    const expected = expectedCallback(call, fn.key, env)
    if (expected) return functionParamType(expected, param.key, env)

    const callee = call.node.callee
    if (fn.key === 1 && t.isMemberExpression(callee) && t.isIdentifier(callee.object, { name: "Array" }) && t.isIdentifier(callee.property, { name: "from" }) &&
        !call.scope.getBinding("Array")) {
        const source = call.node.arguments[0]
        const element = source && !t.isObjectExpression(source) ? elementType(infer(source, call, env), env) : UNDEFINED
        return [element, INT][param.key] ?? null
    }
    if (fn.key !== 0) return null
    if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.property)) return null

    const receiver = infer(callee.object, call, env)
    if (!receiver) return null

    const method = callee.property.name
    const index = param.key
    const atom = single(receiver, env)

    if (atom?.kind === "generic" && atom.name === "Promise" && method === "then") {
        return index === 0 ? atom.args[0] ?? null : null
    }
    if (atom?.kind === "generic" && (atom.name === "Map" || atom.name === "Set") && method === "forEach") {
        const [first = ANY, second = first] = atom.args
        return atom.name === "Map" ? [second, first][index] ?? null : [first, first][index] ?? null
    }

    const element = elementType(receiver, env)
    if (!element) return null

    if (CALLBACK_ELEMENT.has(method)) return [element, INT, arrayOf(element)][index] ?? null
    if (method === "sort" || method === "toSorted") return index < 2 ? element : null
    if (method === "reduce" || method === "reduceRight") {
        const initial = call.node.arguments[1]
        const accumulator = initial ? widen(infer(initial, call, env)) : element
        return [accumulator, element, INT][index] ?? null
    }
    return null
}
