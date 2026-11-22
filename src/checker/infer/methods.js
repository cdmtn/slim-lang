import * as t from "@babel/types"
import { ANY, arrayOf, genericOf, named, tupleOf, unionOf } from "../../external/typeSyntax.js"
import { ARRAY, BOOL, FLOAT, FUNCTION, INT, NULL, NUMBER, OBJECT, STRING, UNDEFINED, atoms, classFor, isArrayLike, receiverThis, isNamed, isNullish, isNumeric, resolveStruct, single, structFor, widen } from "../core.js"
import { factsFrom, refKey } from "../narrowing.js"
import { infer } from "../infer.js"
import { elementType, returnType, signatureFor } from "./signatures.js"
import { inferReturn } from "./generics.js"
import { enumMethod, tryTarget, variantMethodType } from "./variants.js"

export function objectLiteralType(node, path_, env, depth = 0) {
    if (node._slimCast || node.properties.length === 0 || depth > 8) return null
    const fields = new Map()
    for (const property of node.properties) {
        if (t.isSpreadElement(property)) {
            const spread = structFor(infer(property.argument, path_, env), env)
            if (!spread || spread.open) return null
            for (const [name, field] of spread.fields) fields.set(name, { name, type: field.type, optional: field.optional })
            continue
        }
        if (t.isObjectMethod(property) && !property.computed && t.isIdentifier(property.key) && property.kind === "method") {
            fields.set(property.key.name, { name: property.key.name, type: FUNCTION, optional: false })
            continue
        }
        if (!t.isObjectProperty(property) || property.computed) return null
        const name = t.isIdentifier(property.key) ? property.key.name : t.isStringLiteral(property.key) ? property.key.value : null
        if (name === null) return null
        fields.set(name, { name, type: valueType(property.value, path_, env, depth), optional: false })
    }
    return { kind: "shape", fields: [...fields.values()], exact: true, open: true }
}

export function valueType(node, path_, env, depth = 0) {
    if (t.isObjectExpression(node)) return objectLiteralType(node, path_, env, depth + 1) ?? OBJECT
    return widen(infer(node, path_, env)) ?? ANY
}

function filteredElement(element, callback, path_, env) {
    if (t.isIdentifier(callback, { name: "Boolean" }) && !path_.scope.getBinding("Boolean")) {
        const kept = atoms(element, env).filter(atom => !isNullish(atom) && !(atom.kind === "literal" && !atom.value))
        return kept.length ? unionOf(kept) : element
    }
    if (!t.isArrowFunctionExpression(callback) && !t.isFunctionExpression(callback)) return element
    const [param] = callback.params
    if (!t.isIdentifier(param)) return element
    let test = callback.body
    if (t.isBlockStatement(test)) {
        if (test.body.length !== 1 || !t.isReturnStatement(test.body[0]) || !test.body[0].argument) return element
        test = test.body[0].argument
    }
    const fnPath = env.functionPaths.get(callback)
    const key = fnPath && refKey(param, fnPath)
    if (!key) return element
    return factsFrom(test, true, fnPath, env).filter(fact => fact.key === key).reduce((current, fact) => fact.refine(current), element)
}

export function callbackReturn(callback, path_, env) {
    if (t.isFunction(callback)) return inferReturn(callback, env)
    if (t.isIdentifier(callback)) return returnType(signatureFor(callback.name, path_, env), env)
    return null
}

const STRING_METHODS = {
    string: ["toUpperCase", "toLowerCase", "toLocaleUpperCase", "toLocaleLowerCase", "trim", "trimStart", "trimEnd",
        "padStart", "padEnd", "repeat", "replace", "replaceAll", "slice", "substring", "substr", "charAt", "concat", "normalize"],
    bool: ["includes", "startsWith", "endsWith"],
    int: ["indexOf", "lastIndexOf", "search", "charCodeAt", "codePointAt", "localeCompare"]
}

const STRING_RESULT = new Map(Object.entries(STRING_METHODS).flatMap(([result, methods]) => methods.map(method => [method, named(result)])))

const SAME_ARRAY = new Set(["filter", "slice", "reverse", "sort", "toSorted", "toReversed", "fill", "splice", "toSpliced", "with", "copyWithin"])

export const CALLBACK_ELEMENT = new Set([
    "map", "filter", "find", "findIndex", "findLast", "findLastIndex", "some", "every", "forEach", "flatMap"
])

function arrayMethodType(receiver, method, call, path_, env) {
    const element = elementType(receiver, env)
    switch (method) {
        case "map": {
            const result = callbackReturn(call.arguments[0], path_, env)
            return result ? arrayOf(result) : ARRAY
        }
        case "flatMap": {
            const result = callbackReturn(call.arguments[0], path_, env)
            if (!result) return ARRAY
            const parts = []
            for (const atom of atoms(result, env)) {
                if (isNamed(atom, "array")) return ARRAY
                parts.push(isArrayLike(atom) ? elementType(atom, env) : atom)
            }
            return parts.every(Boolean) ? arrayOf(unionOf(parts)) : ARRAY
        }
        case "concat": {
            const parts = [element]
            for (const argument of call.arguments) {
                const type = infer(argument, path_, env)
                parts.push(type && isArrayLike(single(type, env) ?? ANY) ? elementType(type, env) : type)
            }
            return parts.every(Boolean) ? arrayOf(unionOf(parts)) : ARRAY
        }
        case "find":
        case "findLast":
        case "at":
        case "pop":
        case "shift":
            return element ? unionOf([element, UNDEFINED]) : null
        case "findIndex":
        case "findLastIndex":
        case "indexOf":
        case "lastIndexOf":
        case "push":
        case "unshift":
            return INT
        case "some":
        case "every":
        case "includes":
            return BOOL
        case "join":
            return STRING
        case "forEach":
            return UNDEFINED
        case "reduce":
        case "reduceRight":
            return call.arguments.length > 1 ? widen(infer(call.arguments[1], path_, env)) : element
        case "filter":
            return element ? arrayOf(filteredElement(element, call.arguments[0], path_, env)) : ARRAY
    }
    if (SAME_ARRAY.has(method)) return element ? arrayOf(element) : ARRAY
    return null
}

export function methodType(receiver, method, call, path_, env) {
    if (method === "toString" || method === "toFixed" || method === "toLocaleString") return STRING

    const results = []
    for (const atom of atoms(receiver, env)) {
        if (isNullish(atom)) continue
        let result = null

        const struct = structFor(atom, env) ?? classFor(atom, env)
        if (struct?.methods.get(method)) result = returnType(struct.methods.get(method), env, call, path_, new Map([...(struct.bound ?? []), ["this", receiverThis(atom)]]))
        else if (isArrayLike(atom)) result = arrayMethodType(atom, method, call, path_, env)
        else if (isNamed(atom, "string") || (atom.kind === "literal" && typeof atom.value === "string")) {
            result = method === "split" ? arrayOf(STRING) : method === "at" ? unionOf([STRING, UNDEFINED])
                : method === "match" ? unionOf([arrayOf(STRING), NULL]) : STRING_RESULT.get(method) ?? null
        } else if (isNamed(atom, "RegExp") && (method === "exec" || method === "test")) {
            result = method === "exec" ? unionOf([arrayOf(STRING), NULL]) : BOOL
        } else if (atom.kind === "generic" && atom.name === "Map") {
            const [key = ANY, value = ANY] = atom.args
            if (method === "get") result = unionOf([value, UNDEFINED])
            else if (method === "has" || method === "delete") result = BOOL
            else if (method === "set") result = atom
            else if (method === "keys") result = genericOf("Iterator", [key])
            else if (method === "values") result = genericOf("Iterator", [value])
            else if (method === "entries") result = genericOf("Iterator", [tupleOf([key, value])])
            else if (method === "clear" || method === "forEach") result = UNDEFINED
        } else if (atom.kind === "generic" && atom.name === "Set") {
            const element = atom.args[0] ?? ANY
            if (method === "has" || method === "delete") result = BOOL
            else if (method === "add") result = atom
            else if (method === "keys" || method === "values") result = genericOf("Iterator", [element])
            else if (method === "entries") result = genericOf("Iterator", [tupleOf([element, element])])
            else if (method === "clear" || method === "forEach") result = UNDEFINED
        } else if (isNamed(atom, "Date")) {
            result = DATE_INT.test(method) ? INT : DATE_STRING.has(method) ? STRING : null
        } else if (isNamed(atom, "Response") && Object.hasOwn(RESPONSE_METHODS, method)) {
            result = genericOf("Promise", [RESPONSE_METHODS[method]])
        } else if (atom.kind === "generic" && atom.name === "Promise") {
            result = promiseMethodType(atom, method, call, path_, env)
        } else if ((atom.kind === "generic" || atom.kind === "named") && atom.name === "Struct") {
            result = method === "verify" || method === "new" ? atom.args?.[0] ?? ANY : null
        } else if (isNamed(atom, "Response") && method === "clone") {
            result = atom
        } else if (tryTarget(atom, env) && env.enums.get(atom.name)?.builtin) {
            result = variantMethodType(atom, method, call, path_, env)
        } else if (enumMethod(atom, method, env)) {
            const { signature, bound } = enumMethod(atom, method, env)
            result = returnType(signature, env, call, path_, bound)
        }

        if (!result) return null
        results.push(result)
    }
    return results.length ? unionOf(results) : null
}

export const GLOBAL_CALLS = {
    String: STRING, Number: NUMBER, Boolean: BOOL, parseInt: INT, parseFloat: FLOAT,
    fetch: genericOf("Promise", [named("Response")]), encodeURIComponent: STRING, decodeURIComponent: STRING,
    encodeURI: STRING, decodeURI: STRING, btoa: STRING, atob: STRING, isNaN: BOOL, isFinite: BOOL
}

const DATE_INT = /^(get|set)(UTC)?(FullYear|Month|Date|Day|Hours|Minutes|Seconds|Milliseconds)$|^(getTime|setTime|getTimezoneOffset|valueOf)$/
const DATE_STRING = new Set(["toISOString", "toDateString", "toTimeString", "toLocaleDateString", "toLocaleTimeString", "toUTCString", "toJSON"])

const RESPONSE_METHODS = {
    text: STRING, json: ANY, blob: named("Blob"), arrayBuffer: named("ArrayBuffer"), formData: named("FormData")
}

export const BUILTIN_FIELDS = {
    Response: { status: INT, ok: BOOL, statusText: STRING, url: STRING, redirected: BOOL, type: STRING, headers: named("Headers"), bodyUsed: BOOL },
    Error: { message: STRING, name: STRING },
    RegExp: { source: STRING, flags: STRING, lastIndex: INT, global: BOOL, ignoreCase: BOOL, multiline: BOOL }
}

function awaitedType(type, env) {
    if (!type) return null
    const parts = atoms(type, env).map(atom => atom.kind === "generic" && atom.name === "Promise" ? atom.args[0] ?? ANY : atom)
    return unionOf(parts)
}

function promiseMethodType(atom, method, call, path_, env) {
    const value = atom.args[0] ?? ANY
    if (method === "finally") return atom
    if (method !== "then" && method !== "catch") return null
    const handler = call.arguments[0]
    const settled = handler ? callbackReturn(handler, path_, env) : value
    if (!settled) return null
    const parts = method === "catch" ? [value, awaitedType(settled, env)] : [awaitedType(settled, env)]
    if (method === "then" && call.arguments[1]) {
        const failed = callbackReturn(call.arguments[1], path_, env)
        if (!failed) return null
        parts.push(awaitedType(failed, env))
    }
    return genericOf("Promise", [unionOf(parts)])
}

function promiseCombinator(method, call, path_, env) {
    const argument = call.arguments[0]
    if (method === "resolve") return genericOf("Promise", [argument ? widen(infer(argument, path_, env)) ?? ANY : UNDEFINED])
    if (method === "reject") return genericOf("Promise", [named("never")])
    if (!argument) return null
    if (t.isArrayExpression(argument) && argument.elements.every(element => element && !t.isSpreadElement(element))) {
        const items = argument.elements.map(element => awaitedType(infer(element, path_, env), env))
        if (items.some(item => !item)) return null
        if (method === "all") return genericOf("Promise", [tupleOf(items.map(widen))])
        if (method === "race" || method === "any") return genericOf("Promise", [widen(unionOf(items))])
        return null
    }
    const element = awaitedType(elementType(infer(argument, path_, env), env), env)
    if (!element) return null
    if (method === "all") return genericOf("Promise", [arrayOf(element)])
    if (method === "race" || method === "any") return genericOf("Promise", [element])
    return null
}

function objectFieldTypes(argument, path_, env) {
    const type = infer(argument, path_, env)
    const definition = type && (structFor(type, env) ?? classFor(type, env))
    if (!definition || definition.open || definition.methods?.size || definition.members?.size > definition.fields.size) return null
    const types = [...definition.fields.values()].map(field => field.optional ? unionOf([field.type, UNDEFINED]) : field.type)
    return types.length ? unionOf(types) : null
}

export const RUNTIME_CALLS = { __sizeof__: INT, type: STRING, __is_empty__: BOOL, __intdiv__: INT }

const INTEGER_MATH = new Set(["floor", "ceil", "round", "trunc", "sign"])

export function staticCallType(object, method, call, path_, env) {
    if (path_.scope.getBinding(object)) return null
    if (object === "process" && method === "exit") return named("never")
    if (object === "Math") {
        if (INTEGER_MATH.has(method)) return INT
        if (method === "pow") {
            const [base, exponent] = call.arguments.map(argument => widen(infer(argument, path_, env)))
            if (!isNumeric(base) || !isNumeric(exponent)) return FLOAT
            const integer = isNamed(base, "int") && isNamed(exponent, "int")
            const literalExponent = t.isNumericLiteral(call.arguments[1]) && Number.isInteger(call.arguments[1].value)
            return integer && literalExponent ? INT : integer ? NUMBER : FLOAT
        }
        if (method === "max" || method === "min" || method === "abs") {
            const args = call.arguments.map(argument => widen(infer(argument, path_, env)))
            return args.length && args.every(arg => isNamed(arg, "int")) ? INT : FLOAT
        }
        return FLOAT
    }
    if (object === "JSON" && method === "stringify") return STRING
    if (object === "Object" && method === "keys") return arrayOf(STRING)
    if (object === "Object" && (method === "values" || method === "entries") && call.arguments[0]) {
        const value = objectFieldTypes(call.arguments[0], path_, env) ?? ANY
        return arrayOf(method === "values" ? value : tupleOf([STRING, value]))
    }
    if (object === "Promise") return promiseCombinator(method, call, path_, env)
    if (object === "Array" && (method === "from" || method === "of")) {
        if (method === "of") return call.arguments.length ? arrayOf(widen(unionOf(call.arguments.map(argument => infer(argument, path_, env) ?? ANY)))) : ARRAY
        if (call.arguments[1]) {
            const result = callbackReturn(call.arguments[1], path_, env)
            return result ? arrayOf(result) : ARRAY
        }
        const element = call.arguments[0] ? elementType(infer(call.arguments[0], path_, env), env) : null
        return element ? arrayOf(element) : ARRAY
    }
    if (object === "Array" && method === "isArray") return BOOL
    if (object === "Number" && method.startsWith("is")) return BOOL
    if (object === "Date" && method === "now") return INT
    return null
}

export function formType(argument, env) {
    if (!t.isIdentifier(argument) || !resolveStruct(argument.name, env)) return null
    const name = argument.name
    const key = `form of ${name}`
    if (!env.structs.has(key)) {
        const struct = resolveStruct(name, env)
        const own = type => ({ type, optional: false, readonly: true })
        const fields = new Map([...struct.fields].map(([field, info]) => [field, { type: info.type, optional: true, readonly: false }]))
        env.structs.set(`errors of ${name}`, {
            fields: new Map([...struct.fields.keys()].map(field => [field, own(unionOf([STRING, named("null")]))])),
            defaults: new Set(), methods: new Map(), parent: null, typeParams: []
        })
        fields.set("errors", own(named(`errors of ${name}`)))
        fields.set("valid", own(BOOL))
        fields.set("submitting", own(BOOL))
        fields.set("values", own(ANY))
        fields.set("checking", own(BOOL))
        fields.set("formError", own(unionOf([STRING, NULL])))
        const setErrors = {
            parameters: [{ name: "errors", type: unionOf([OBJECT, STRING, NULL]), required: false }],
            rest: false, returns: UNDEFINED, async: false, typed: true, node: null, typeParams: []
        }
        env.structs.set(key, {
            fields, defaults: new Set(), parent: null, typeParams: [],
            methods: new Map([["submit", null], ["reset", null], ["touched", null], ["setErrors", setErrors]])
        })
    }
    return named(key)
}

export function tryFailures(path_, env) {
    const fn = path_.getFunctionParent()
    const failures = []
    fn?.traverse({
        Function(inner) { inner.skip() },
        CallExpression(call) {
            if (!t.isIdentifier(call.node.callee, { name: "__try__" })) return
            const target = tryTarget(infer(call.node.arguments[0], call, env), env)
            if (!target) return
            const error = target.kind === "generic" ? target.args[1] ?? ANY : ANY
            failures.push(target.name === "Result" ? genericOf("Result", [ANY, error]) : genericOf("Option", [ANY]))
        }
    })
    return failures.length ? unionOf(failures) : named("never")
}
