import * as t from "@babel/types"
import { ANY, named, substituteType, unionOf } from "../../external/typeSyntax.js"
import { FUNCTION, NUMBER, NUMERIC, STRING, accepts, atoms, describe, isArrayLike, isNamed, isNullish, single, sourceText, structFor, widen } from "../core.js"
import { bindTypeParams, contextualParam, elementType, infer, signatureFor } from "../infer.js"
import { checkValue } from "./values.js"
import { parameterExpects } from "./control.js"

function parameterAt(signature, index, env) {
    const parameters = signature.parameters
    const last = parameters[parameters.length - 1]
    const own = parameters[index]
    if (own && !own.rest) return own
    if (!last?.rest || index < parameters.length - 1) return null
    return last.type ? { name: last.name, type: elementType(last.type, env) ?? null } : null
}

function checkSpreadCall(signature, node, name, path_, env, report, types) {
    const expectedAt = (index, argument) => {
        const parameter = parameterAt(signature, index, env)
        if (!parameter?.type) return null
        const type = types.size ? substituteType(parameter.type, types) : parameter.type
        return { name: parameter.name, type: argument ? parameterExpects(parameter, type, argument, path_, env) : type }
    }
    let position = 0
    for (const argument of node.arguments) {
        if (!t.isSpreadElement(argument)) {
            const expected = expectedAt(position++, argument)
            if (expected) checkValue(expected.type, argument, path_, env, report, `argument "${expected.name}" of "${name}"`)
            continue
        }
        const type = infer(argument.argument, path_, env)
        const atom = type && single(type, env)
        if (atom?.kind === "tuple") {
            for (const item of atom.items) {
                const expected = expectedAt(position++)
                if (expected && !accepts(expected.type, item, env)) {
                    report(argument, `argument "${expected.name}" of "${name}" expects ${describe(expected.type)}, got ${describe(item)} from "...${sourceText(argument.argument) ?? "..."}"`)
                    return
                }
            }
            continue
        }
        const element = type && elementType(type, env)
        if (!element) return
        const limit = signature.rest ? signature.parameters.length : Math.max(signature.parameters.length, position + 1)
        for (let index = position; index < limit; index++) {
            const expected = expectedAt(index)
            if (expected && !accepts(expected.type, element, env)) {
                report(argument, `argument "${expected.name}" of "${name}" expects ${describe(expected.type)}, got ${describe(element)} from "...${sourceText(argument.argument) ?? "..."}"`)
                return
            }
        }
        return
    }
}

export function checkCall(signature, node, name, path_, env, report, bound = null) {
    if (!signature || !signature.typed) return
    if (node.arguments.some(argument => t.isSpreadElement(argument))) {
        checkSpreadCall(signature, node, name, path_, env, report, bindTypeParams(signature, node, path_, env, bound))
        return
    }

    const required = signature.parameters.filter(parameter => parameter.required).length

    if (node.arguments.length < required) {
        report(node, `"${name}" expects ${required} argument${required === 1 ? "" : "s"}, got ${node.arguments.length}`)
        return
    }
    if (!signature.rest && node.arguments.length > signature.parameters.length) {
        report(node,
            `"${name}" takes ${signature.parameters.length} argument${signature.parameters.length === 1 ? "" : "s"}, got ${node.arguments.length}`)
        return
    }

    const types = bindTypeParams(signature, node, path_, env, bound)
    for (const [param, raw] of signature.constraints ?? []) {
        const given = types.get(param)
        const constraint = types.size ? substituteType(raw, types) : raw
        if (!given || given.kind === "any" || accepts(constraint, given, env)) continue
        report(node, `type parameter "${param}" of "${name}" must fit ${describe(constraint)}, got ${describe(given)}`)
        return
    }
    node.arguments.forEach((argument, index) => {
        const parameter = parameterAt(signature, index, env)
        if (!parameter?.type) return
        const expected = parameterExpects(parameter, types.size ? substituteType(parameter.type, types) : parameter.type, argument, path_, env)
        checkValue(expected, argument, path_, env, report, `argument "${parameter.name}" of "${name}"`)
    })
}

const INDEX = NUMBER
const PATTERN = unionOf([STRING, named("RegExp")])
const parameter = (name, type, required = true) => ({ name, type, required })
const builtinSignature = (parameters, rest = false) => ({ parameters, rest, typed: true, returns: null, async: false, typeParams: [] })
const SEARCH = [parameter("searchString", STRING), parameter("position", INDEX, false)]
const STRING_SIGNATURES = {
    indexOf: SEARCH, lastIndexOf: SEARCH, includes: SEARCH, startsWith: SEARCH, endsWith: SEARCH,
    charAt: [parameter("index", INDEX, false)], charCodeAt: [parameter("index", INDEX, false)],
    codePointAt: [parameter("index", INDEX)], at: [parameter("index", INDEX)],
    repeat: [parameter("count", INDEX)],
    padStart: [parameter("maxLength", INDEX), parameter("fillString", STRING, false)],
    padEnd: [parameter("maxLength", INDEX), parameter("fillString", STRING, false)],
    slice: [parameter("start", INDEX, false), parameter("end", INDEX, false)],
    substring: [parameter("start", INDEX), parameter("end", INDEX, false)],
    split: [parameter("separator", PATTERN, false), parameter("limit", INDEX, false)],
    replace: [parameter("pattern", PATTERN), parameter("replacement", unionOf([STRING, FUNCTION]))],
    replaceAll: [parameter("pattern", PATTERN), parameter("replacement", unionOf([STRING, FUNCTION]))],
    trim: [], trimStart: [], trimEnd: [], toUpperCase: [], toLowerCase: []
}

function arraySignature(method, element) {
    const known = element && !isNamed(element, "null") && element.kind !== "any"
    const item = known ? widen(element) : null
    switch (method) {
        case "includes":
        case "indexOf":
        case "lastIndexOf":
            return [parameter("searchElement", item), parameter("fromIndex", INDEX, false)]
        case "join": return [parameter("separator", STRING, false)]
        case "at": return [parameter("index", INDEX)]
        case "slice": return [parameter("start", INDEX, false), parameter("end", INDEX, false)]
        case "fill": return [parameter("value", item), parameter("start", INDEX, false), parameter("end", INDEX, false)]
    }
    return null
}

export function checkBuiltinCall(node, path_, env, report) {
    const callee = node.callee
    const receiver = infer(callee.object, path_, env)
    if (!receiver) return
    const present = atoms(receiver, env).filter(atom => !isNullish(atom))
    if (present.length !== 1) return
    const [atom] = present
    const method = callee.property.name

    if (isNamed(atom, "string") || (atom.kind === "literal" && typeof atom.value === "string")) {
        if (Object.hasOwn(STRING_SIGNATURES, method)) checkCall(builtinSignature(STRING_SIGNATURES[method]), node, `string.${method}`, path_, env, report)
        return
    }
    if (atom.kind === "generic" && (atom.name === "Map" || atom.name === "Set") && atom.args.length > 0) {
        const [key = ANY, value = ANY] = atom.args
        const signatures = atom.name === "Map"
            ? { set: [parameter("key", key), parameter("value", value)], get: [parameter("key", key)], has: [parameter("key", key)], delete: [parameter("key", key)] }
            : { add: [parameter("value", key)], has: [parameter("value", key)], delete: [parameter("value", key)] }
        if (Object.hasOwn(signatures, method)) checkCall(builtinSignature(signatures[method]), node, `${describe(atom)}.${method}`, path_, env, report)
        return
    }
    if (!isArrayLike(atom) || atom.kind === "tuple") return

    const element = elementType(atom, env)
    const inferredShape = element && atoms(element, env).some(part => part.kind === "shape" && part.open)
    if ((method === "push" || method === "unshift") && element && !inferredShape && !isNamed(element, "null") && element.kind !== "any") {
        node.arguments.forEach(argument => {
            if (!t.isSpreadElement(argument)) checkValue(element, argument, path_, env, report, `argument of "${describe(atom)}.${method}"`)
        })
        return
    }
    const parameters = arraySignature(method, element)
    if (parameters) checkCall(builtinSignature(parameters), node, `${describe(widen(atom))}.${method}`, path_, env, report)
}

export function unwrapHandledPromise(node) {
    if (t.isCallExpression(node) && t.isMemberExpression(node.callee) &&
        t.isIdentifier(node.callee.property, { name: "catch" }) &&
        t.isIdentifier(node.arguments[0], { name: "__handle_async_error__" })) {
        return node.callee.object
    }
    return node
}

export function calleeName(call) {
    const callee = call.callee
    if (t.isIdentifier(callee)) return callee.name
    if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) return callee.property.name
    return "function"
}

export function calleeSignature(call, path_, env) {
    if (!t.isCallExpression(call)) return null
    const callee = call.callee
    if (t.isIdentifier(callee)) return signatureFor(callee.name, path_, env)
    if (t.isMemberExpression(callee) && !callee.computed && t.isIdentifier(callee.property)) {
        return structFor(infer(callee.object, path_, env), env)?.methods.get(callee.property.name) ?? null
    }
    return null
}

const IGNORES_PROMISES = new Set(["forEach", "filter", "some", "every", "find", "findIndex", "findLast", "findLastIndex"])

export function checkAsyncCallback(node, path_, env, report) {
    const callee = node.callee
    if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.property)) return

    const method = callee.property.name
    if (!IGNORES_PROMISES.has(method)) return

    const callback = node.arguments[0]
    const isAsync = t.isFunction(callback)
        ? callback.async
        : t.isIdentifier(callback) && signatureFor(callback.name, path_, env)?.async
    if (!isAsync) return

    report(callback, method === "forEach"
        ? `forEach doesn't wait for async callbacks: use for...of with await, or await Promise.all(items.map(...))`
        : `${method} doesn't wait for async callbacks: it gets a promise, which is always truthy`)
}

const NOT_CALLABLE = new Set(["int", "float", "number", "string", "bool", "null", "undefined", "array", "object"])

export function checkCallable(node, path_, env, report) {
    const callee = node.callee
    if (!t.isIdentifier(callee) && !t.isMemberExpression(callee)) return
    const type = infer(callee, path_, env)
    if (!type) return
    const all = atoms(type, env)
    const notCallable = atom => atom.kind === "literal" || atom.kind === "array" || atom.kind === "tuple" || atom.kind === "shape" ||
        (atom.kind === "named" && NOT_CALLABLE.has(atom.name))
    if (all.length === 0 || !all.every(notCallable) || all.every(isNullish)) return
    const subject = sourceText(callee)
    report(callee, `${subject ? `"${subject}"` : "this value"} is ${describe(type)}, not a function`)
}

export function checkCallbackParams(path_, env, report) {
    path_.node.params.forEach((param, index) => {
        if (!t.isIdentifier(param)) return
        const binding = path_.scope.getBinding(param.name)
        const declared = binding && env.bindings.get(binding)
        if (!declared) return
        const given = contextualParam(binding, env)
        if (!given || accepts(declared, given, env)) return
        report(param, `parameter "${param.name}" is ${describe(declared)}, but it gets ${describe(given)} here`)
    })
}

export function checkParamDefaults(path_, env, report) {
    const body = path_.node.body
    if (t.isCallExpression(body) && t.isIdentifier(body.callee, { name: "__component__" })) return
    for (const param of path_.node.params) {
        if (!t.isAssignmentPattern(param) || !t.isIdentifier(param.left)) continue
        const binding = path_.scope.getBinding(param.left.name)
        const declared = binding && env.bindings.get(binding)
        if (declared) checkValue(declared, param.right, path_, env, report, `the default of "${param.left.name}"`, "must be")
    }
}

const CALLBACK_CALLS = new Set(["map", "filter", "find", "findIndex", "findLast", "findLastIndex", "some", "every", "forEach", "flatMap", "reduce", "reduceRight", "sort", "then", "catch", "finally"])
const TIMERS = new Set(["setTimeout", "setInterval", "queueMicrotask", "requestAnimationFrame"])

export function usesOwnThis(fn) {
    let found = null
    const walk = node => {
        if (found || !node || typeof node !== "object") return
        if (Array.isArray(node)) return node.forEach(walk)
        if (node !== fn && (t.isFunctionExpression(node) || t.isFunctionDeclaration(node) || t.isClassBody(node) || t.isObjectMethod(node) || t.isClassMethod(node))) return
        if (t.isThisExpression(node)) {
            found = node
            return
        }
        for (const key in node) {
            if (key === "loc" || key === "extra" || key.startsWith("_")) continue
            const value = node[key]
            if (value && typeof value === "object") walk(value)
        }
    }
    walk(fn.body)
    return found
}

export function checkCallbackThis(path_, report) {
    if (!path_.isFunctionExpression()) return
    const call = path_.parentPath
    if (!call?.isCallExpression() || path_.listKey !== "arguments") return
    const callee = call.node.callee
    const name = t.isIdentifier(callee) ? callee.name : t.isMemberExpression(callee) && !callee.computed && t.isIdentifier(callee.property) ? callee.property.name : null
    if (!name || !(CALLBACK_CALLS.has(name) && t.isMemberExpression(callee)) && !TIMERS.has(name)) return
    if (call.node.arguments.length > 1 && CALLBACK_CALLS.has(name) && name !== "reduce" && name !== "reduceRight") return
    const usage = usesOwnThis(path_.node)
    if (usage) report(usage, `"this" is undefined inside a function passed to "${name}" — use an arrow function to keep the outer "this"`)
}

export function checkTimerArgument(node, path_, env, report) {
    if (!t.isIdentifier(node.callee) || !TIMERS.has(node.callee.name) || path_.scope.getBinding(node.callee.name)) return
    const first = node.arguments[0]
    if (!first) return
    const type = infer(first, path_, env)
    if (type && atoms(type, env).every(atom => isNamed(atom, "string") || (atom.kind === "literal" && typeof atom.value === "string"))) {
        report(first, `"${node.callee.name}" needs a function, got ${describe(type)} — pass () => { ... }`)
    }
}

export function checkForEachReturn(path_, report) {
    const value = path_.node.argument
    if (!t.isBooleanLiteral(value) && !t.isNumericLiteral(value) && !t.isStringLiteral(value)) return
    const fn = path_.getFunctionParent()
    const call = fn?.parentPath
    if (!call?.isCallExpression() || fn.listKey !== "arguments" || fn.key !== 0) return
    const callee = call.node.callee
    if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.property, { name: "forEach" })) return
    if (t.isArrowFunctionExpression(fn.node) && fn.node.expression) return
    report(path_.node, `"forEach" ignores what its callback returns, so this return value goes nowhere — use some(), find() or a for…of loop`)
}

export function checkSortComparator(node, path_, env, report) {
    const callee = node.callee
    if (node.arguments.length || !t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.property) ||
        !["sort", "toSorted"].includes(callee.property.name)) return
    const element = elementType(infer(callee.object, path_, env), env)
    if (!element || !atoms(element, env).every(atom => NUMERIC.has(atom.name) || (atom.kind === "literal" && typeof atom.value === "number"))) return
    report(node, `"${callee.property.name}()" without a comparator sorts numbers as text (10 comes before 9) — pass (a, b) => a - b`)
}
