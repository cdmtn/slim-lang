import _traverse from "@babel/traverse"
import * as t from "@babel/types"
import path from "node:path"
import {
    ANY, named, literal, arrayOf, tupleOf, genericOf, enumMember, unionOf, functionOf,
    readType, formatType, substituteType
} from "./external/typeSyntax.js"
import { closest, didYouMean, isKnownGlobal } from "./suggest.js"
import { parseMarkup, holeMark } from "./syntax/markup.js"

const traverse = _traverse.default ?? _traverse

function computeLineStarts(text) {
    const starts = [0]
    for (let i = 0; i < text.length; i++) {
        if (text[i] === "\n") starts.push(i + 1)
    }
    return starts
}

function offsetToLineCol(offset, lineStarts) {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (lineStarts[mid] <= offset) lo = mid
        else hi = mid - 1
    }
    return { line: lo, column: offset - lineStarts[lo] }
}

const INT = named("int")
const FLOAT = named("float")
const NUMBER = named("number")
const STRING = named("string")
const BOOL = named("bool")
const NULL = named("null")
const UNDEFINED = named("undefined")
const OBJECT = named("object")
const ARRAY = named("array")
const FUNCTION = named("function")

const NUMERIC = new Set(["int", "float", "number"])
const KNOWN = new Set([
    "int", "float", "number", "string", "bool", "null", "undefined",
    "object", "array", "function", "any", "element", "bigint", "symbol"
])
const BUILTIN_CLASSES = new Set(["Map", "Set", "Date", "Promise", "RegExp", "Error"])

const isNamed = (type, name) => type?.kind === "named" && type.name === name
const isNumeric = type => type?.kind === "named" && NUMERIC.has(type.name)
const isNullish = type => isNamed(type, "null") || isNamed(type, "undefined")

function literalBase(type) {
    if (typeof type.value === "string") return STRING
    if (typeof type.value === "boolean") return BOOL
    return Number.isInteger(type.value) ? INT : FLOAT
}

function widen(type) {
    if (!type) return type
    switch (type.kind) {
        case "literal": return literalBase(type)
        case "union": return unionOf(type.types.map(widen))
        case "array": return arrayOf(widen(type.element))
        case "tuple": return tupleOf(type.items.map(widen))
    }
    return type
}

function describe(type) {
    const text = formatType(type)
    return (type.kind === "union" || type.kind === "intersection") && !text.endsWith("?") ? `(${text})` : text
}

function propertyKey(property) {
    if (t.isStringLiteral(property.key)) return property.key.value
    if (t.isIdentifier(property.key) && !property.computed) return property.key.name
    return null
}


export function createEnvironment() {
    return {
        structs: new Map(),
        enums: new Map(),
        customTypes: new Set(),
        aliases: new Map(),
        functions: new Map(),
        bindings: new Map(),
        classes: new Set(),
        methodOwners: new Map(),
        returns: new Map(),
        functionsByName: new Map(),
        importedFunctions: new Map(),
        importedLocals: new Set(),
        openGlobals: false,
        functionPaths: new Map(),
        initTypes: new Map(),
        refinedTypes: new Map(),
        inferredReturns: new Map(),
        inferring: new Set(),
        facts: []
    }
}

const moduleTypes = new Map()

function encode(value) {
    if (value instanceof Map) return { $map: [...value].map(([key, item]) => [key, encode(item)]) }
    if (value instanceof Set) return { $set: [...value] }
    if (Array.isArray(value)) return value.map(encode)
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "node").map(([key, item]) => [key, encode(item)]))
}

function decode(value) {
    if (Array.isArray(value)) return value.map(decode)
    if (!value || typeof value !== "object") return value
    if (value.$map) return new Map(value.$map.map(([key, item]) => [key, decode(item)]))
    if (value.$set) return new Set(value.$set)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]))
}

export function exportModuleTypes(sourceFile) {
    const record = moduleTypes.get(path.resolve(sourceFile))
    return record ? JSON.stringify(encode(record)) : null
}

export function importModuleTypes(sourceFile, saved) {
    if (saved) moduleTypes.set(path.resolve(sourceFile), decode(JSON.parse(saved)))
}

function atoms(type, env, seen = new Set()) {
    if (type.kind === "named" && env.aliases.has(type.name) && !seen.has(type.name)) {
        return atoms(env.aliases.get(type.name), env, new Set(seen).add(type.name))
    }
    if (type.kind === "union") return type.types.flatMap(part => atoms(part, env, seen))
    return [type]
}

function single(type, env) {
    const all = atoms(type, env)
    return all.length === 1 ? all[0] : null
}

function resolveStruct(name, env, seen = new Set()) {
    const definition = env.structs.get(name)
    if (!definition) return null
    if (definition.resolved) return definition

    if (!definition.parent) {
        return { ...definition, ancestors: new Set(), resolved: true }
    }
    if (seen.has(name)) return null

    seen.add(name)
    const parent = resolveStruct(definition.parent, env, seen)
    if (!parent) return null

    const fields = new Map(parent.fields)
    for (const [field, info] of definition.fields) fields.set(field, info)

    return {
        fields,
        defaults: new Set([...parent.defaults, ...definition.defaults]),
        methods: new Map([...parent.methods, ...definition.methods]),
        typeParams: definition.typeParams,
        ancestors: new Set([definition.parent, ...parent.ancestors]),
        parent: null,
        resolved: true
    }
}

function structFor(type, env) {
    const atom = type && single(type, env)
    if (!atom || (atom.kind !== "named" && atom.kind !== "generic")) return null

    const definition = resolveStruct(atom.name, env)
    if (!definition) return null
    if (atom.kind !== "generic" || !definition.typeParams?.length) return { ...definition, label: formatType(atom) }

    const bound = new Map(definition.typeParams.map((param, index) => [param, atom.args[index] ?? ANY]))
    const fields = new Map()
    for (const [name, field] of definition.fields) fields.set(name, { ...field, type: substituteType(field.type, bound) })
    return { ...definition, fields, label: formatType(atom), bound }
}

function inherits(name, ancestor, env) {
    if (name === ancestor) return true
    return resolveStruct(name, env)?.ancestors.has(ancestor) ?? false
}


function isOpen(type, env) {
    switch (type.kind) {
        case "any":
        case "intersection":
            return true
        case "named":
            if (env.customTypes.has(type.name)) return true
            return !(KNOWN.has(type.name) || BUILTIN_CLASSES.has(type.name) || env.structs.has(type.name) || env.enums.has(type.name))
        case "generic":
            return env.customTypes.has(type.name) || !(env.structs.has(type.name) || BUILTIN_CLASSES.has(type.name))
        case "enumMember":
            return !env.enums.has(type.name)
    }
    return false
}

const isArrayLike = type => type.kind === "array" || type.kind === "tuple" || isNamed(type, "array")

const isFunctionLike = type => type.kind === "function" || isNamed(type, "function")

function acceptsFunction(target, source, env) {
    if (!isFunctionLike(target)) return isOpen(target, env)
    if (!isFunctionLike(source)) return isOpen(source, env)
    if (target.kind !== "function" || source.kind !== "function") return true

    const paramsFit = source.params.every((param, index) => {
        const given = target.params[index]
        return !given || accepts(param.type, given.type, env)
    })
    const returnsFit = isNamed(target.returns, "undefined") || accepts(target.returns, source.returns, env)
    return paramsFit && returnsFit
}

function acceptsAtom(target, source, env) {
    if (source.kind === "literal") {
        if (target.kind === "literal") return target.value === source.value
        return acceptsAtom(target, literalBase(source), env)
    }
    if (isFunctionLike(target) || isFunctionLike(source)) return acceptsFunction(target, source, env)

    if (target.kind === "literal") {
        const base = literalBase(target)
        return isNamed(source, base.name) || (isNumeric(base) && isNumeric(source)) || isOpen(source, env)
    }

    if (target.kind === "array") {
        if (source.kind === "array") return isNamed(source.element, "null") || accepts(target.element, source.element, env)
        if (source.kind === "tuple") return source.items.every(item => accepts(target.element, item, env))
        return isNamed(source, "array") || isOpen(source, env)
    }
    if (target.kind === "tuple") {
        if (source.kind === "tuple") {
            return source.items.length === target.items.length &&
                target.items.every((item, index) => accepts(item, source.items[index], env))
        }
        return source.kind === "array" || isNamed(source, "array") || isOpen(source, env)
    }
    if (isNamed(target, "array")) return isArrayLike(source) || isOpen(source, env)
    if (isArrayLike(source)) return isNamed(target, "object") || isOpen(target, env)

    if (isOpen(target, env) || isOpen(source, env)) return true

    if (isNumeric(target) && isNumeric(source)) return target.name !== "int" || source.name === "int"

    if (target.kind === "generic") {
        const sameArgs = () => target.args.every((arg, index) => !source.args?.[index] || accepts(arg, source.args[index], env))
        if (env.structs.has(target.name)) {
            if (isNamed(source, "object")) return true
            if (source.kind === "generic" && source.name === target.name) return sameArgs()
            return (source.kind === "named" || source.kind === "generic") && inherits(source.name, target.name, env)
        }
        if (source.kind === "generic") return source.name === target.name && sameArgs()
        return source.kind === "named" && source.name === target.name
    }
    if (source.kind === "generic") {
        if (target.kind === "named" && target.name === source.name) return true
        return isNamed(target, "object") && env.structs.has(source.name)
    }

    if (target.kind === "enumMember") {
        if (source.kind === "enumMember") return source.name === target.name && source.member === target.member
        return source.name === target.name || env.enums.get(target.name).valueTypes.has(source.name)
    }
    if (env.enums.has(target.name)) {
        if (source.kind === "enumMember") return source.name === target.name
        return source.name === target.name || env.enums.get(target.name).valueTypes.has(source.name)
    }
    if (source.kind === "enumMember") return false

    if (target.name === source.name) return true
    if (BUILTIN_CLASSES.has(target.name) || BUILTIN_CLASSES.has(source.name)) return false
    if (target.name === "object") return env.structs.has(source.name)
    if (env.structs.has(target.name)) return source.name === "object" || inherits(source.name, target.name, env)
    return false
}

export function accepts(target, source, env) {
    if (!target || !source) return true

    const targets = atoms(target, env)
    if (targets.some(atom => atom.kind === "any" || atom.kind === "intersection")) return true

    return atoms(source, env).every(atom =>
        atom.kind === "any" || atom.kind === "intersection" || targets.some(other => acceptsAtom(other, atom, env)))
}


const bindingIds = new WeakMap()
let nextBindingId = 0

function refKey(node, path_) {
    if (t.isIdentifier(node)) {
        const binding = path_.scope.getBinding(node.name)
        if (!binding) return null
        if (!bindingIds.has(binding)) bindingIds.set(binding, `#${nextBindingId++}`)
        return bindingIds.get(binding)
    }
    if (t.isThisExpression(node)) return "this"
    if ((t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) && !node.computed && t.isIdentifier(node.property)) {
        const base = refKey(node.object, path_)
        return base && `${base}.${node.property.name}`
    }
    return null
}

function keep(type, env, predicate) {
    const kept = atoms(type, env).filter(predicate)
    return kept.length === 0 ? type : unionOf(kept)
}

function typeofName(atom, env) {
    switch (atom.kind) {
        case "literal": return typeof atom.value === "boolean" ? "boolean" : typeof atom.value
        case "array":
        case "tuple":
        case "generic":
            return "object"
        case "function":
            return "function"
        case "named":
            if (NUMERIC.has(atom.name)) return "number"
            if (atom.name === "bool") return "boolean"
            if (atom.name === "null") return "object"
            if (["string", "undefined", "function", "bigint", "symbol"].includes(atom.name)) return atom.name
            if (["object", "array", "element"].includes(atom.name) || BUILTIN_CLASSES.has(atom.name) || env.structs.has(atom.name)) return "object"
    }
    return null
}

function kindName(atom, env) {
    if (atom.kind === "literal") return literalBase(atom).name
    if (atom.kind === "named") {
        if (["int", "float", "string", "bool", "null", "undefined", "element"].includes(atom.name)) return atom.name
        if (env.structs.has(atom.name)) return "struct"
        if (BUILTIN_CLASSES.has(atom.name)) return atom.name.toLowerCase()
    }
    if (atom.kind === "generic" && BUILTIN_CLASSES.has(atom.name)) return atom.name.toLowerCase()
    if (atom.kind === "enumMember") return "enum"
    if (atom.kind === "function") return "function"
    return null
}

const isNullLiteral = node => t.isNullLiteral(node) || t.isIdentifier(node, { name: "undefined" })
const isLiteralNode = node => t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)

function equalityFacts(test, positive, path_, env) {
    const { left, right } = test
    const loose = test.operator.length === 2

    const typeofSide = [[left, right], [right, left]].find(([a, b]) => t.isUnaryExpression(a, { operator: "typeof" }) && t.isStringLiteral(b))
    if (typeofSide) {
        const [{ argument }, { value }] = typeofSide
        const key = refKey(argument, path_)
        return key ? [{ key, refine: type => keep(type, env, atom => { const name = typeofName(atom, env); return name === null || (name === value) === positive }) }] : []
    }

    const kindSide = [[left, right], [right, left]].find(([a, b]) =>
        t.isCallExpression(a) && t.isIdentifier(a.callee, { name: "type" }) && a.arguments.length === 1 && t.isStringLiteral(b))
    if (kindSide) {
        const [{ arguments: [argument] }, { value }] = kindSide
        const key = refKey(argument, path_)
        return key ? [{ key, refine: type => keep(type, env, atom => { const name = kindName(atom, env); return name === null || (name === value) === positive }) }] : []
    }

    const [ref, other] = refKey(left, path_) ? [left, right] : [right, left]
    const key = refKey(ref, path_)
    if (!key) return []

    if (isNullLiteral(other)) {
        const names = loose ? ["null", "undefined"] : [t.isNullLiteral(other) ? "null" : "undefined"]
        const matches = atom => atom.kind === "named" && names.includes(atom.name)
        return [{ key, refine: type => keep(type, env, atom => matches(atom) === positive) }]
    }

    if (isLiteralNode(other)) {
        const value = other.value
        const refine = positive
            ? type => keep(type, env, atom => atom.kind === "literal" ? atom.value === value : isOpen(atom, env) || acceptsAtom(atom, literal(value), env))
            : type => keep(type, env, atom => !(atom.kind === "literal" && atom.value === value))
        return [{ key, refine }]
    }

    if (t.isMemberExpression(other) && !other.computed && t.isIdentifier(other.object) && t.isIdentifier(other.property) &&
        env.enums.get(other.object.name)?.members.has(other.property.name)) {
        const member = enumMember(other.object.name, other.property.name)
        const same = atom => atom.kind === "enumMember" && atom.name === member.name && atom.member === member.member
        return [{ key, refine: type => keep(type, env, atom => positive ? same(atom) || atom.kind !== "enumMember" : !same(atom)) }]
    }
    return []
}

function staticCheck(test, path_) {
    if (!t.isCallExpression(test) || test.arguments.length !== 1) return null
    const callee = test.callee
    if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.object) || !t.isIdentifier(callee.property)) return null
    if (path_.scope.getBinding(callee.object.name)) return null
    return `${callee.object.name}.${callee.property.name}`
}

function factsFrom(test, truthy, path_, env) {
    const at = typeof test.end === "number" ? test.end : Infinity
    return testFacts(test, truthy, path_, env).map(fact => ({ ...fact, at }))
}

function testFacts(test, truthy, path_, env) {
    if (t.isUnaryExpression(test, { operator: "!" })) return factsFrom(test.argument, !truthy, path_, env)

    if (t.isLogicalExpression(test)) {
        if (test.operator === "&&" && truthy) return [...factsFrom(test.left, true, path_, env), ...factsFrom(test.right, true, path_, env)]
        if (test.operator === "||" && !truthy) return [...factsFrom(test.left, false, path_, env), ...factsFrom(test.right, false, path_, env)]
        return []
    }

    const key = refKey(test, path_)
    if (key) return truthy ? [{ key, refine: type => keep(type, env, atom => !isNullish(atom)) }] : []

    if (t.isBinaryExpression(test) && ["==", "===", "!=", "!=="].includes(test.operator)) {
        return equalityFacts(test, test.operator.startsWith("=") === truthy, path_, env)
    }

    if (t.isBinaryExpression(test, { operator: "instanceof" }) && t.isIdentifier(test.right)) {
        const key = refKey(test.left, path_)
        const name = test.right.name
        const matches = atom => (atom.kind === "named" || atom.kind === "generic") && atom.name === name
        if (!key) return []
        return [{ key, refine: truthy
            ? type => atoms(type, env).some(matches) ? keep(type, env, matches) : named(name)
            : type => keep(type, env, atom => !matches(atom)) }]
    }

    const check = staticCheck(test, path_)
    if (check === "Array.isArray") {
        const key = refKey(test.arguments[0], path_)
        return key ? [{ key, refine: type => keep(type, env, atom => isArrayLike(atom) === truthy) }] : []
    }
    if (check === "Number.isInteger" && truthy) {
        const key = refKey(test.arguments[0], path_)
        const toInt = atom => isNamed(atom, "number") ? INT : atom
        return key ? [{ key, refine: type => unionOf(atoms(keep(type, env, atom => !isNamed(atom, "float")), env).map(toInt)) }] : []
    }
    return []
}

function exits(statement) {
    if (!statement) return false
    if (t.isReturnStatement(statement) || t.isThrowStatement(statement) ||
        t.isContinueStatement(statement) || t.isBreakStatement(statement)) return true
    if (t.isBlockStatement(statement)) return statement.body.some(exits)
    if (t.isIfStatement(statement)) return exits(statement.consequent) && exits(statement.alternate)
    return false
}

function ancestorFacts(path_, env) {
    const facts = []
    let child = path_
    let parent = path_.parentPath

    while (parent) {
        const node = parent.node

        if ((parent.isIfStatement() || parent.isConditionalExpression()) && child.key !== "test") {
            facts.push(...factsFrom(node.test, child.key === "consequent", parent, env))
        } else if (parent.isLogicalExpression() && child.key === "right" && node.operator !== "??") {
            facts.push(...factsFrom(node.left, node.operator === "&&", parent, env))
        } else if ((parent.isWhileStatement() || parent.isForStatement()) && child.key === "body" && node.test) {
            facts.push(...factsFrom(node.test, true, parent, env))
        }

        if (child.listKey === "body" && typeof child.key === "number") {
            const siblings = child.container
            for (let i = 0; i < child.key; i++) {
                const statement = siblings[i]
                if (!t.isIfStatement(statement)) continue
                if (exits(statement.consequent) && !exits(statement.alternate)) {
                    facts.push(...factsFrom(statement.test, false, parent, env))
                } else if (statement.alternate && exits(statement.alternate)) {
                    facts.push(...factsFrom(statement.test, true, parent, env))
                }
            }
        }

        child = parent
        parent = parent.parentPath
    }
    return facts
}

function withFacts(env, facts, run) {
    env.facts.push(...facts)
    try {
        return run()
    } finally {
        env.facts.length -= facts.length
    }
}

function narrowed(node, path_, env, type) {
    if (!type) return type

    const key = refKey(node, path_)
    if (!key) return type
    const violations = t.isIdentifier(node) ? path_.scope.getBinding(node.name)?.constantViolations ?? [] : []
    const stillHolds = fact => violations.every(violation =>
        typeof violation.node.start === "number" && typeof node.start === "number" &&
        !(violation.node.start > fact.at && violation.node.start < node.start))

    const facts = [...env.facts, ...ancestorFacts(path_, env)].filter(fact => fact.key === key && stillHolds(fact))
    return facts.reduce((current, fact) => fact.refine(current), type)
}


function signatureFor(name, path_, env) {
    const binding = path_.scope.getBinding(name)
    if (binding) return env.functions.get(binding) ?? signatureOfType(env.bindings.get(binding), env)
    return env.importedFunctions.get(name) ?? null
}

function signatureOfType(type, env) {
    const atom = type && single(type, env)
    if (atom?.kind !== "function") return null
    return {
        parameters: atom.params.map((param, index) => ({ name: param.name ?? `#${index + 1}`, type: param.type, required: true })),
        rest: false,
        returns: atom.returns,
        async: false,
        typed: true,
        node: null,
        typeParams: []
    }
}

function functionTypeOf(fn, env) {
    const fnPath = env.functionPaths.get(fn)
    if (!fnPath) return FUNCTION

    const signature = collectParameters(fn)
    const params = signature.parameters.map(param => {
        const binding = param.name && fnPath.scope.getBinding(param.name)
        const type = param.type ?? (binding && binding.kind === "param" ? contextualParam(binding, env) : null)
        return { name: param.name, type: type ?? ANY }
    })
    return functionOf(params, returnType(signature, env) ?? ANY)
}

function typedVariableLabel(node) {
    if (!t.isCallExpression(node)) return null
    if (!t.isIdentifier(node.callee, { name: "__typed_variable__" })) return null
    return t.isStringLiteral(node.arguments[1]) ? node.arguments[1].value : null
}

function structLiteralName(node, env) {
    if (!t.isCallExpression(node)) return null
    const callee = node.callee
    if (!t.isMemberExpression(callee) || callee.computed) return null
    if (!t.isIdentifier(callee.property, { name: "new" })) return null
    if (!t.isIdentifier(callee.object) || !env.structs.has(callee.object.name)) return null
    return callee.object.name
}

function elementType(type, env) {
    const all = type ? atoms(type, env).filter(atom => !isNullish(atom)) : []
    const elements = []
    for (const atom of all) {
        if (atom.kind === "array" && !isNamed(atom.element, "null")) elements.push(atom.element)
        else if (atom.kind === "tuple") elements.push(...atom.items)
        else if (atom.kind === "generic" && (atom.name === "Set" || atom.name === "Array")) elements.push(atom.args[0] ?? ANY)
        else if (isNamed(atom, "string")) elements.push(STRING)
        else return null
    }
    return elements.length ? unionOf(elements) : null
}

function returnType(signature, env, call = null, path_ = null, bound = null) {
    if (!signature) return null
    let returns = signature.returns ?? signature.inferred ?? inferReturn(signature.node, env)
    if (!returns) return null
    if (call && (signature.typeParams?.length || bound?.size)) {
        returns = substituteType(returns, bindTypeParams(signature, call, path_, env, bound))
    }
    return signature.async ? genericOf("Promise", [returns]) : returns
}

const mentions = (type, names) => typeNames(type).some(name => names.includes(name))

function unify(pattern, actual, params, bound, env) {
    if (!pattern || !actual) return
    if (pattern.kind === "named" && params.includes(pattern.name)) {
        if (!bound.has(pattern.name)) bound.set(pattern.name, widen(actual))
        return
    }
    if (!mentions(pattern, params)) return

    const present = atoms(actual, env).filter(atom => !isNullish(atom))
    const atom = present.length === 1 ? present[0] : null

    switch (pattern.kind) {
        case "array":
            unify(pattern.element, elementType(actual, env), params, bound, env)
            break
        case "tuple":
            if (atom?.kind === "tuple") pattern.items.forEach((item, index) => unify(item, atom.items[index], params, bound, env))
            break
        case "generic":
            if (atom?.kind === "generic" && atom.name === pattern.name) {
                pattern.args.forEach((arg, index) => unify(arg, atom.args[index], params, bound, env))
            }
            break
        case "function":
            if (atom?.kind === "function") {
                pattern.params.forEach((param, index) => atom.params[index] && unify(param.type, atom.params[index].type, params, bound, env))
                unify(pattern.returns, atom.returns, params, bound, env)
            }
            break
        case "union": {
            const generic = pattern.types.filter(part => mentions(part, params))
            if (generic.length === 1) unify(generic[0], present.length ? unionOf(present) : actual, params, bound, env)
        }
    }
}

function bindTypeParams(signature, call, path_, env, bound = null, skipCallbacks = false) {
    const result = new Map(bound ?? [])
    const params = signature.typeParams ?? []
    if (params.length === 0 || !path_) return result

    const order = call.arguments.map((argument, index) => index).sort((a, b) =>
        t.isFunction(call.arguments[a]) - t.isFunction(call.arguments[b]))
    for (const index of order) {
        const argument = call.arguments[index]
        const parameter = signature.parameters[index]
        if (!parameter?.type || t.isSpreadElement(argument) || !mentions(parameter.type, params)) continue
        if (skipCallbacks && t.isFunction(argument)) continue
        unify(parameter.type, infer(argument, path_, env), params, result, env)
    }
    for (const name of params) if (!result.has(name)) result.set(name, ANY)
    return result
}

function inferReturn(fn, env, skip = null) {
    if (!fn || fn.generator) return null
    if (!skip && env.inferredReturns.has(fn)) return env.inferredReturns.get(fn)
    const fnPath = env.functionPaths.get(fn)
    if (!fnPath) return null

    if (!skip) env.inferredReturns.set(fn, null)

    let result = null
    if (!t.isBlockStatement(fn.body)) {
        result = widen(infer(fn.body, fnPath.get("body"), env))
    } else {
        const found = []
        let unknown = false
        fnPath.traverse({
            Function(inner) { inner.skip() },
            ReturnStatement(statement) {
                if (statement.node === skip) return
                if (!statement.node.argument) { found.push(UNDEFINED); return }
                const type = infer(statement.node.argument, statement, env)
                if (type) found.push(widen(type))
                else unknown = true
            }
        })

        const last = fn.body.body.at(-1)
        if (found.length === 0) result = fn.async || !unknown ? UNDEFINED : null
        else if (!unknown && (exits(last) || skip)) result = unionOf(found)
    }

    if (!skip) env.inferredReturns.set(fn, result)
    return result
}

function callbackReturn(callback, path_, env) {
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
const CALLBACK_ELEMENT = new Set([
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
            return arrayOf(elementType(result, env) ?? result)
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
    }
    if (SAME_ARRAY.has(method)) return element ? arrayOf(element) : ARRAY
    return null
}

function methodType(receiver, method, call, path_, env) {
    if (method === "toString" || method === "toFixed" || method === "toLocaleString") return STRING

    const results = []
    for (const atom of atoms(receiver, env)) {
        if (isNullish(atom)) continue
        let result = null

        const struct = structFor(atom, env)
        if (struct?.methods.has(method)) result = returnType(struct.methods.get(method), env, call, path_, struct.bound)
        else if (isArrayLike(atom)) result = arrayMethodType(atom, method, call, path_, env)
        else if (isNamed(atom, "string") || (atom.kind === "literal" && typeof atom.value === "string")) {
            result = method === "split" ? arrayOf(STRING) : method === "at" ? unionOf([STRING, UNDEFINED]) : STRING_RESULT.get(method) ?? null
        } else if (atom.kind === "generic" && atom.name === "Map") {
            if (method === "get") result = unionOf([atom.args[1] ?? ANY, UNDEFINED])
            else if (method === "has" || method === "delete") result = BOOL
            else if (method === "set") result = atom
        } else if (atom.kind === "generic" && atom.name === "Set") {
            if (method === "has" || method === "delete") result = BOOL
            else if (method === "add") result = atom
        }

        if (!result) return null
        results.push(result)
    }
    return results.length ? unionOf(results) : null
}

const GLOBAL_CALLS = { String: STRING, Number: NUMBER, Boolean: BOOL, parseInt: INT, parseFloat: FLOAT }
const RUNTIME_CALLS = { __sizeof__: INT, type: STRING, __is_empty__: BOOL, __intdiv__: INT }
const INTEGER_MATH = new Set(["floor", "ceil", "round", "trunc", "sign"])

function staticCallType(object, method, call, path_, env) {
    if (path_.scope.getBinding(object)) return null
    if (object === "Math") {
        if (INTEGER_MATH.has(method)) return INT
        if (method === "max" || method === "min" || method === "abs") {
            const args = call.arguments.map(argument => widen(infer(argument, path_, env)))
            return args.length && args.every(arg => isNamed(arg, "int")) ? INT : FLOAT
        }
        return FLOAT
    }
    if (object === "JSON" && method === "stringify") return STRING
    if (object === "Object" && method === "keys") return arrayOf(STRING)
    if (object === "Array" && method === "isArray") return BOOL
    if (object === "Number" && method.startsWith("is")) return BOOL
    if (object === "Date" && method === "now") return INT
    return null
}

function formType(argument, env) {
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
        env.structs.set(key, {
            fields, defaults: new Set(), parent: null, typeParams: [],
            methods: new Map([["submit", null], ["reset", null], ["touched", null]])
        })
    }
    return named(key)
}

function callType(node, path_, env) {
    const callee = node.callee

    if (t.isFunction(callee)) {
        const match = matchExpression(node)
        if (match) return inferReturn(callee, env, missingCases(match, path_, env)?.missing.length === 0 ? match.fallback : null)
        return returnType({ async: callee.async, node: callee }, env)
    }

    if (t.isIdentifier(callee)) {
        const label = typedVariableLabel(node)
        if (label) return readType(label)

        const name = callee.name
        if (!path_.scope.getBinding(name)) {
            if (name === "createForm") return formType(node.arguments[0], env)
            if (name in RUNTIME_CALLS) return RUNTIME_CALLS[name]
            if (name in GLOBAL_CALLS) return GLOBAL_CALLS[name]
        }
        if (name === "__copyof__" || name === "__lock_object__" || name === "__as_struct__") return infer(node.arguments[0], path_, env)
        return returnType(signatureFor(name, path_, env), env, node, path_)
    }

    if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.property)) return null
    const method = callee.property.name
    const owner = callee.object

    if (t.isIdentifier(owner)) {
        if (env.enums.has(owner.name) && method === "from") return named(owner.name)
        if (env.structs.has(owner.name) && method === "verify") return named(owner.name)
        const result = staticCallType(owner.name, method, node, path_, env)
        if (result) return result
    }

    const receiver = infer(owner, path_, env)
    return receiver ? methodType(receiver, method, node, path_, env) : null
}

function memberType(node, path_, env) {
    const object = infer(node.object, path_, env)

    if (node.computed) {
        if (!object) return null
        const atom = single(object, env)
        if (atom?.kind === "tuple" && t.isNumericLiteral(node.property)) return atom.items[node.property.value] ?? UNDEFINED
        if (atom && (isArrayLike(atom) || isNamed(atom, "string"))) return elementType(atom, env)
        return null
    }
    if (!t.isIdentifier(node.property)) return null

    const name = node.property.name
    if (t.isIdentifier(node.object) && !path_.scope.getBinding(node.object.name)?.constantViolations.length) {
        const definition = env.enums.get(node.object.name)
        if (definition?.members.has(name)) return enumMember(node.object.name, name)
    }
    if (!object) return null

    const results = []
    for (const atom of atoms(object, env)) {
        if (isNullish(atom)) {
            if (node.optional) results.push(UNDEFINED)
            continue
        }
        const struct = structFor(atom, env)
        const field = struct?.fields.get(name)
        if (field) results.push(field.optional ? unionOf([field.type, UNDEFINED]) : field.type)
        else if (struct?.methods.has(name)) results.push(FUNCTION)
        else if (name === "length" && (isArrayLike(atom) || isNamed(atom, "string") || (atom.kind === "literal" && typeof atom.value === "string"))) results.push(INT)
        else if (name === "size" && (atom.kind === "generic" || atom.kind === "named") && (atom.name === "Map" || atom.name === "Set")) results.push(INT)
        else return null
    }
    return results.length ? unionOf(results) : null
}

function expectedCallback(call, index, env) {
    const node = call.node
    const callee = node.callee
    let signature = null
    let bound = null

    if (t.isIdentifier(callee, { name: "__typed_variable__" }) && index === 0 && t.isStringLiteral(node.arguments[1])) {
        const atom = single(readType(node.arguments[1].value), env)
        return atom?.kind === "function" ? atom : null
    }
    if (t.isIdentifier(callee)) {
        signature = signatureFor(callee.name, call, env)
    } else if (t.isMemberExpression(callee) && !callee.computed && t.isIdentifier(callee.property)) {
        const receiver = infer(callee.object, call, env)
        const struct = receiver && structFor(receiver, env)
        signature = struct?.methods.get(callee.property.name) ?? null
        bound = struct?.bound ?? null
    }

    const parameter = signature?.parameters[index]
    if (!parameter?.type) return null
    const types = bindTypeParams(signature, node, call, env, bound, true)
    const atom = single(substituteType(parameter.type, types), env)
    return atom?.kind === "function" ? atom : null
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

function contextualParam(binding, env) {
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
    if (!call?.isCallExpression() || fn.listKey !== "arguments") return null

    const expected = expectedCallback(call, fn.key, env)
    if (expected) return expected.params[param.key]?.type ?? null

    if (fn.key !== 0) return null
    const callee = call.node.callee
    if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.property)) return null

    const receiver = infer(callee.object, call, env)
    if (!receiver) return null

    const method = callee.property.name
    const index = param.key
    const atom = single(receiver, env)

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

function declaredInitType(binding, env) {
    if (env.initTypes.has(binding)) return env.initTypes.get(binding)
    env.initTypes.set(binding, null)

    let type = null
    const declarator = binding.path
    if (declarator.isVariableDeclarator() && t.isIdentifier(declarator.node.id)) {
        const { init } = declarator.node
        if (init && binding.constantViolations.length === 0) {
            type = infer(init, declarator, env)
            if (type && binding.kind !== "const") type = widen(type)
        } else if (!init) {
            const loop = declarator.parentPath.parentPath
            if (loop?.isForOfStatement() && declarator.parentPath.key === "left") {
                type = elementType(infer(loop.node.right, loop, env), env)
            }
        }
    }

    env.initTypes.set(binding, type)
    return type
}

function refinedDeclared(binding, declared, env) {
    if (binding.constantViolations.length > 0) return declared
    if (env.refinedTypes.has(binding)) return env.refinedTypes.get(binding)
    env.refinedTypes.set(binding, declared)

    const declarator = binding.path
    let result = declared
    if (declarator.isVariableDeclarator() && t.isCallExpression(declarator.node.init) && typedVariableLabel(declarator.node.init)) {
        const actual = infer(declarator.node.init.arguments[0], declarator, env)
        if (actual && atoms(declared, env).length > 1) {
            const fitting = atoms(declared, env).filter(atom => accepts(atom, actual, env))
            if (fitting.length > 0) result = unionOf(fitting)
        }
    }

    env.refinedTypes.set(binding, result)
    return result
}

function identifierType(node, path_, env) {
    const binding = path_.scope.getBinding(node.name)
    if (!binding) return null
    if (env.bindings.has(binding)) return refinedDeclared(binding, env.bindings.get(binding), env)
    if (binding.kind === "param") return contextualParam(binding, env)
    if (binding.kind === "const" || binding.kind === "let" || binding.kind === "var") return declaredInitType(binding, env)
    if (binding.kind === "hoisted" && binding.path.isFunctionDeclaration()) return functionTypeOf(binding.path.node, env)
    return null
}

function thisOwner(path_, env) {
    let fn = path_.getFunctionParent()
    while (fn && fn.isArrowFunctionExpression()) fn = fn.parentPath.getFunctionParent()
    return fn ? env.methodOwners.get(fn.node) ?? null : null
}

function falsyParts(type, env) {
    return atoms(type, env).filter(atom => {
        if (atom.kind === "literal") return !atom.value
        if (atom.kind !== "named") return false
        return ["null", "undefined", "bool", "int", "float", "number", "string", "any"].includes(atom.name) || isOpen(atom, env)
    })
}

function truthyParts(type, env) {
    return atoms(type, env).filter(atom => !isNullish(atom) && !(atom.kind === "literal" && !atom.value))
}

function inferNode(node, path_, env) {
    if (t.isNumericLiteral(node) && Number.isInteger(node.value) && /[.eE]/.test(node.extra?.raw ?? "")) return FLOAT
    if (t.isNumericLiteral(node) || t.isStringLiteral(node) || t.isBooleanLiteral(node)) return literal(node.value)
    if (t.isTemplateLiteral(node)) return STRING
    if (t.isNullLiteral(node)) return NULL
    if (t.isIdentifier(node, { name: "undefined" }) && !path_.scope.getBinding("undefined")) return UNDEFINED
    if (t.isObjectExpression(node)) return OBJECT
    if (t.isFunction(node)) return functionTypeOf(node, env)

    if (t.isArrayExpression(node)) {
        if (node.elements.length === 0) return arrayOf(NULL)

        const kinds = []
        for (const item of node.elements) {
            if (!item) return ARRAY
            const kind = t.isSpreadElement(item)
                ? elementType(infer(item.argument, path_, env), env)
                : widen(infer(item, path_, env))
            if (!kind) return ARRAY
            kinds.push(kind)
        }
        return arrayOf(unionOf(kinds))
    }

    const structInstance = structLiteralName(node, env)
    if (structInstance) return named(structInstance)

    if (t.isNewExpression(node) && t.isIdentifier(node.callee)) {
        const name = node.callee.name
        return env.classes.has(name) || BUILTIN_CLASSES.has(name) ? named(name) : null
    }

    if (t.isIdentifier(node)) return narrowed(node, path_, env, identifierType(node, path_, env))

    if (t.isThisExpression(node)) {
        const owner = thisOwner(path_, env)
        return owner ? named(owner) : null
    }

    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
        return narrowed(node, path_, env, memberType(node, path_, env))
    }

    if (t.isUnaryExpression(node)) {
        switch (node.operator) {
            case "!": return BOOL
            case "typeof": return STRING
            case "void": return UNDEFINED
            case "~": return INT
            case "-": {
                const operand = widen(infer(node.argument, path_, env))
                return isNumeric(operand) ? operand : NUMBER
            }
            case "+": {
                const operand = widen(infer(node.argument, path_, env))
                return isNumeric(operand) ? operand : NUMBER
            }
        }
        return null
    }

    if (t.isBinaryExpression(node)) {
        const operator = node.operator
        if (["==", "!=", "===", "!==", "<", ">", "<=", ">=", "instanceof", "in"].includes(operator)) return BOOL
        if (["&", "|", "^", "<<", ">>", ">>>"].includes(operator)) return INT

        const left = widen(infer(node.left, path_, env))
        const right = widen(infer(node.right, path_, env))
        const bothNumeric = isNumeric(left) && isNumeric(right)
        const integer = isNamed(left, "int") && isNamed(right, "int")

        if (operator === "+") {
            if (isNamed(left, "string") || isNamed(right, "string")) return STRING
            return bothNumeric ? (integer ? INT : FLOAT) : null
        }
        if (["-", "*", "%", "**"].includes(operator)) return bothNumeric ? (integer ? INT : FLOAT) : null
        if (operator === "/") return bothNumeric ? FLOAT : null
        return null
    }

    if (t.isLogicalExpression(node)) {
        const left = infer(node.left, path_, env)
        if (!left) return null

        if (node.operator === "??") {
            const right = infer(node.right, path_, env)
            const present = atoms(left, env).filter(atom => !isNullish(atom))
            return right ? unionOf([...present, right]) : null
        }

        const andAlso = node.operator === "&&"
        const right = withFacts(env, factsFrom(node.left, andAlso, path_, env), () => infer(node.right, path_, env))
        if (!right) return null
        const kept = andAlso ? falsyParts(left, env) : truthyParts(left, env)
        return unionOf([...kept, right])
    }

    if (t.isConditionalExpression(node)) {
        const consequent = withFacts(env, factsFrom(node.test, true, path_, env), () => infer(node.consequent, path_, env))
        const alternate = withFacts(env, factsFrom(node.test, false, path_, env), () => infer(node.alternate, path_, env))
        return consequent && alternate ? unionOf([consequent, alternate]) : null
    }

    if (t.isAwaitExpression(node)) {
        const awaited = infer(node.argument, path_, env)
        const atom = awaited && single(awaited, env)
        return atom?.kind === "generic" && atom.name === "Promise" ? atom.args[0] ?? null : awaited
    }

    if (t.isSequenceExpression(node)) return infer(node.expressions.at(-1), path_, env)
    if (t.isAssignmentExpression(node, { operator: "=" })) return infer(node.right, path_, env)
    if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) return callType(node, path_, env)

    return null
}

export function infer(node, path_, env) {
    if (!node || env.inferring.has(node)) return null
    env.inferring.add(node)
    try {
        return inferNode(node, path_, env)
    } finally {
        env.inferring.delete(node)
    }
}


function declaredReturn(fn) {
    if (!t.isBlockStatement(fn.body)) return null

    for (const statement of fn.body.body) {
        if (!t.isExpressionStatement(statement)) continue
        const call = statement.expression
        if (!t.isCallExpression(call)) continue
        if (!t.isIdentifier(call.callee, { name: "__declare_return__" })) continue
        if (t.isStringLiteral(call.arguments[0])) return readType(call.arguments[0].value)
    }
    return null
}

function collectParameters(fn) {
    const declared = new Map()

    if (t.isBlockStatement(fn.body)) {
        for (const statement of fn.body.body) {
            if (!t.isExpressionStatement(statement)) continue
            const call = statement.expression
            if (!t.isCallExpression(call)) continue
            if (!t.isIdentifier(call.callee, { name: "__typed_parameter__" })) continue

            const [value, label, , optional] = call.arguments
            if (!t.isIdentifier(value) || !t.isStringLiteral(label)) continue
            declared.set(value.name, {
                type: readType(label.value),
                optional: t.isBooleanLiteral(optional) ? optional.value : false
            })
        }
    }

    const generic = fn._slimSignature
    const genericType = index => generic?.params[index] ? readType(generic.params[index]) : null

    let rest = false
    const parameters = fn.params.map((param, index) => {
        if (t.isRestElement(param)) { rest = true; return { name: null, type: null, required: false } }
        if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
            return { name: param.left.name, type: genericType(index) ?? declared.get(param.left.name)?.type ?? null, required: false }
        }
        if (t.isIdentifier(param)) {
            const info = declared.get(param.name)
            return { name: param.name, type: genericType(index) ?? info?.type ?? null, required: !info?.optional && !generic?.optional[index] }
        }
        return { name: null, type: null, required: false }
    })

    const returns = generic?.returns ? readType(generic.returns) : declaredReturn(fn)
    const typed = declared.size > 0 || !!returns || parameters.some(parameter => parameter.type)
    return { parameters, rest, returns, async: !!fn.async, typed, node: fn, typeParams: generic?.typeParams ?? [] }
}

function functionName(path_) {
    if (t.isFunctionDeclaration(path_.node) && path_.node.id) return path_.node.id.name
    if (path_.parentPath?.isVariableDeclarator() && t.isIdentifier(path_.parent.id)) {
        return path_.parent.id.name
    }
    if (path_.parentPath?.isObjectProperty()) {
        const key = path_.parent.key
        if (t.isStringLiteral(key)) return key.value
        if (t.isIdentifier(key)) return key.name
    }
    if ((t.isClassMethod(path_.node) || t.isObjectMethod(path_.node)) && t.isIdentifier(path_.node.key)) {
        return path_.node.key.name
    }
    return "function"
}

function collectStruct(init, env) {
    const [nameArg, schema] = init.arguments
    const fields = new Map()
    for (const property of schema.properties) {
        if (!t.isObjectProperty(property) || !t.isStringLiteral(property.value)) continue
        const key = propertyKey(property)
        if (key === null) continue
        const optional = key.startsWith("*")
        fields.set(optional ? key.slice(1).trim() : key, { type: readType(property.value.value), optional, readonly: false })
    }

    if (t.isArrayExpression(init.arguments[7])) {
        for (const element of init.arguments[7].elements) {
            if (t.isStringLiteral(element) && fields.has(element.value)) fields.get(element.value).readonly = true
        }
    }

    const typeParams = t.isArrayExpression(init.arguments[6])
        ? init.arguments[6].elements.filter(element => t.isStringLiteral(element)).map(element => element.value)
        : []

    const defaults = new Set()
    if (t.isObjectExpression(init.arguments[3])) {
        for (const property of init.arguments[3].properties) {
            if (!t.isObjectProperty(property)) continue
            const key = propertyKey(property)
            if (key !== null) defaults.add(key)
        }
    }

    const methods = new Map()
    if (t.isObjectExpression(init.arguments[5])) {
        for (const property of init.arguments[5].properties) {
            if (!t.isObjectProperty(property)) continue
            const key = propertyKey(property)
            if (key === null) continue
            const isFunction = t.isFunction(property.value)
            methods.set(key, isFunction ? collectParameters(property.value) : null)
            if (isFunction) env.methodOwners.set(property.value, nameArg.value)
        }
    }

    const parent = t.isStringLiteral(init.arguments[4]) ? init.arguments[4].value : null
    env.structs.set(nameArg.value, { fields, defaults, methods, parent, typeParams })
}

function componentSignature(name, props, env) {
    let type
    let required = false
    if (props.type) {
        type = readType(props.type)
        required = true
    } else {
        const key = `${name} props`
        const fields = new Map(props.fields.map(field =>
            [field.name, { type: field.type ? readType(field.type) : ANY, optional: field.optional, readonly: true }]))
        env.structs.set(key, { fields, defaults: new Set(), methods: new Map(), parent: null, typeParams: [], component: name })
        type = named(key)
        required = props.fields.some(field => !field.optional)
    }
    return {
        parameters: [{ name: "props", type, required }],
        rest: false, returns: null, async: false, typed: true, node: null, typeParams: []
    }
}

function collectEnum(init, env) {
    const [nameArg, schema] = init.arguments
    const members = new Set()
    const valueTypes = new Set()
    for (const property of schema.properties) {
        if (!t.isObjectProperty(property)) continue
        const key = propertyKey(property)
        if (key !== null) members.add(key)
        if (t.isStringLiteral(property.value)) valueTypes.add("string")
        else if (t.isNumericLiteral(property.value)) {
            valueTypes.add(Number.isInteger(property.value.value) ? "int" : "float")
        } else valueTypes.add("any")
    }
    env.enums.set(nameArg.value, { members, valueTypes })
}

function collect(ast, env) {
    traverse(ast, {
        ClassDeclaration(path_) {
            if (path_.node.id) env.classes.add(path_.node.id.name)
        },

        VariableDeclarator(path_) {
            const { id, init } = path_.node
            if (!t.isIdentifier(id)) return

            const binding = path_.scope.getBinding(id.name)
            if (path_.node._slimType && binding) {
                env.bindings.set(binding, readType(path_.node._slimType))
                return
            }

            if (init?._slimComponentProps && binding) {
                const signature = componentSignature(id.name, init._slimComponentProps, env)
                env.functions.set(binding, signature)
                if (binding.scope.path.isProgram()) env.functionsByName.set(id.name, signature)
                return
            }

            if (t.isCallExpression(init) && t.isIdentifier(init.callee)) {
                const name = init.callee.name
                const [nameArg, schema] = init.arguments

                if (name === "__def_struct__" && t.isStringLiteral(nameArg) && t.isObjectExpression(schema)) {
                    collectStruct(init, env)
                    return
                }
                if (name === "__def_enum__" && t.isStringLiteral(nameArg) && t.isObjectExpression(schema)) {
                    collectEnum(init, env)
                    return
                }
                if (name === "__type_def__" && t.isStringLiteral(nameArg)) {
                    if (t.isStringLiteral(schema)) env.aliases.set(nameArg.value, readType(schema.value))
                    else env.customTypes.add(nameArg.value)
                    return
                }

                const label = typedVariableLabel(init)
                if (label && binding) env.bindings.set(binding, readType(label))
            }

            if ((t.isArrowFunctionExpression(init) || t.isFunctionExpression(init)) && binding) {
                const signature = collectParameters(init)
                env.functions.set(binding, signature)
                if (binding.scope.path.isProgram()) env.functionsByName.set(id.name, signature)
            }
        },

        FunctionDeclaration(path_) {
            if (!path_.node.id) return
            const name = path_.node.id.name
            const binding = path_.scope.getBinding(name)
            if (!binding) return

            const signature = collectParameters(path_.node)
            env.functions.set(binding, signature)
            if (binding.scope.path.isProgram()) env.functionsByName.set(name, signature)
        },

        Function(path_) {
            env.functionPaths.set(path_.node, path_)

            const { parameters, returns } = collectParameters(path_.node)
            for (const parameter of parameters) {
                if (!parameter.name || !parameter.type) continue
                const binding = path_.scope.getBinding(parameter.name)
                if (binding) env.bindings.set(binding, parameter.type)
            }

            if (returns) {
                env.returns.set(path_.node, { type: returns, name: functionName(path_) })
            }
        }
    })
}


function checkStructLiteral(target, node, path_, env, report, requireAll = true) {
    const definition = structFor(target, env)
    if (!definition) return
    const name = definition.component ?? definition.label
    const noun = definition.component ? "prop" : "field"
    const subject = key => definition.component ? `prop "${key}" of "${name}"` : `"${name}.${key}"`

    const seen = new Set()
    for (const property of node.properties) {
        if (!t.isObjectProperty(property) && !t.isObjectMethod(property)) return
        const key = propertyKey(property)
        if (key === null) return

        seen.add(key)
        const field = definition.fields.get(key)
        if (!field) {
            report(property, `"${name}" has no ${noun} "${key}"${didYouMean(key, definition.fields.keys())}`)
            continue
        }
        if (t.isObjectMethod(property)) continue

        const expected = field.optional ? unionOf([field.type, UNDEFINED]) : field.type
        checkValue(expected, property.value, path_, env, report, subject(key))
    }

    if (!requireAll) return

    for (const [field, info] of definition.fields) {
        if (info.optional || seen.has(field) || definition.defaults.has(field)) continue
        report(node, `"${name}" is missing ${noun} "${field}" of type ${describe(info.type)}`)
    }
}

function matchExpression(node) {
    if (!t.isCallExpression(node) || node.arguments.length !== 1) return null

    const callee = node.callee
    if (!t.isArrowFunctionExpression(callee) || callee.params.length !== 1) return null
    if (!t.isIdentifier(callee.params[0], { name: "__match" })) return null
    if (!t.isBlockStatement(callee.body)) return null

    const covered = []
    const types = []
    let wildcard = false
    let guarded = false
    let fallback = null

    for (const statement of callee.body.body) {
        if (t.isBlockStatement(statement)) { guarded = true; continue }

        if (t.isIfStatement(statement)) {
            const test = statement.test
            if (t.isCallExpression(test) && t.isIdentifier(test.callee, { name: "__match_eq__" })) {
                covered.push(test.arguments[1])
            } else if (t.isCallExpression(test) && t.isIdentifier(test.callee, { name: "__match_type__" }) && t.isStringLiteral(test.arguments[1])) {
                const body = statement.consequent.body ?? []
                if (!t.isIfStatement(body.at(-1))) types.push(readType(test.arguments[1].value))
            } else guarded = true
            continue
        }

        if (t.isReturnStatement(statement)) {
            wildcard = !t.isIdentifier(statement.argument, { name: "undefined" })
            if (!wildcard) fallback = statement
        }
    }

    return { covered, types, wildcard, guarded, fallback, scrutinee: node.arguments[0] }
}

function missingCases(match, path_, env) {
    if (match.guarded) return null

    const type = infer(match.scrutinee, path_, env)
    const all = type ? atoms(type, env) : []
    if (all.length === 0) return null

    if (match.types.length > 0) {
        if (match.covered.length > 0) return null
        const missing = all.filter(atom => !match.types.some(covered => accepts(covered, atom, env)))
        return { subject: describe(type), missing: missing.map(formatType) }
    }

    const enumName = all.length === 1 && (all[0].kind === "enumMember" || env.enums.has(all[0].name)) ? all[0].name : null
    if (enumName && env.enums.has(enumName)) {
        const covered = new Set()
        for (const arm of match.covered) {
            if (!t.isMemberExpression(arm) || arm.computed) return null
            if (!t.isIdentifier(arm.object, { name: enumName })) return null
            if (!t.isIdentifier(arm.property)) return null
            covered.add(arm.property.name)
        }
        const missing = [...env.enums.get(enumName).members].filter(member => !covered.has(member))
        return { subject: `"${enumName}"`, missing: missing.map(member => `${enumName}.${member}`) }
    }

    if (all.length > 1 && all.every(atom => atom.kind === "literal")) {
        if (!match.covered.every(isLiteralNode)) return null
        const covered = new Set(match.covered.map(arm => arm.value))
        const missing = all.filter(atom => !covered.has(atom.value)).map(formatType)
        return { subject: describe(type), missing }
    }
    return null
}

function checkExhaustive(node, match, path_, env, report) {
    if (match.wildcard) return

    const result = missingCases(match, path_, env)
    if (!result || result.missing.length === 0) return

    const { subject, missing } = result
    report(node, `match on ${subject} does not handle ${missing.join(", ")}` +
        ` — add the missing case${missing.length === 1 ? "" : "s"} or a "_" fallback`)
}

function hasLiterals(type, env) {
    return atoms(type, env).some(atom => atom.kind === "literal")
}

function arrayLiteralAsTuple(target, node, path_, env) {
    if (!t.isArrayExpression(node) || !atoms(target, env).some(atom => atom.kind === "tuple")) return null
    const items = []
    for (const element of node.elements) {
        if (!element || t.isSpreadElement(element)) return null
        const type = infer(element, path_, env)
        if (!type) return null
        items.push(type)
    }
    return tupleOf(items)
}

function checkValue(target, node, path_, env, report, describeTarget, phrase = "expects") {
    if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: "__as_struct__" })) node = node.arguments[0]

    if (t.isObjectExpression(node) && structFor(target, env)) {
        checkStructLiteral(target, node, path_, env, report)
        return
    }

    const list = single(target, env)
    if (t.isArrayExpression(node) && list?.kind === "array" && structFor(list.element, env)) {
        node.elements.forEach((element, index) => {
            if (element && !t.isSpreadElement(element)) checkValue(list.element, element, path_, env, report, `${describeTarget}[${index}]`, phrase)
        })
        return
    }

    const actual = arrayLiteralAsTuple(target, node, path_, env) ?? infer(node, path_, env)
    if (accepts(target, actual, env)) return

    const shown = hasLiterals(target, env) ? actual : widen(actual)
    const present = atoms(actual, env).filter(atom => !isNullish(atom))
    const hint = present.length && present.length < atoms(actual, env).length && accepts(target, unionOf(present), env)
        ? ` — check it for ${atoms(actual, env).some(atom => isNamed(atom, "null")) ? "null" : "undefined"} first`
        : ""
    report(node, `${describeTarget} ${phrase} ${describe(target)}, got ${describe(shown)}${hint}`)
}

function checkCall(signature, node, name, path_, env, report, bound = null) {
    if (!signature || !signature.typed) return
    if (node.arguments.some(argument => t.isSpreadElement(argument))) return

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
    node.arguments.forEach((argument, index) => {
        const parameter = signature.parameters[index]
        if (!parameter?.type) return
        const expected = types.size ? substituteType(parameter.type, types) : parameter.type
        checkValue(expected, argument, path_, env, report, `argument "${parameter.name}" of "${name}"`)
    })
}

function unwrapHandledPromise(node) {
    if (t.isCallExpression(node) && t.isMemberExpression(node.callee) &&
        t.isIdentifier(node.callee.property, { name: "catch" }) &&
        t.isIdentifier(node.arguments[0], { name: "__handle_async_error__" })) {
        return node.callee.object
    }
    return node
}

function calleeName(call) {
    const callee = call.callee
    if (t.isIdentifier(callee)) return callee.name
    if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) return callee.property.name
    return "function"
}

function calleeSignature(call, path_, env) {
    if (!t.isCallExpression(call)) return null
    const callee = call.callee
    if (t.isIdentifier(callee)) return signatureFor(callee.name, path_, env)
    if (t.isMemberExpression(callee) && !callee.computed && t.isIdentifier(callee.property)) {
        return structFor(infer(callee.object, path_, env), env)?.methods.get(callee.property.name) ?? null
    }
    return null
}

const IGNORES_PROMISES = new Set(["forEach", "filter", "some", "every", "find", "findIndex", "findLast", "findLastIndex"])

function checkAsyncCallback(node, path_, env, report) {
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

const memberNames = definition => [...definition.fields.keys(), ...definition.methods.keys()]

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
    Error: prototypeNames(new Error(), ["stack", "cause"])
}

function builtinMembers(atom) {
    if (isArrayLike(atom)) return BUILTIN_MEMBERS.array
    const name = atom.kind === "literal" ? literalBase(atom).name : atom.kind === "named" || atom.kind === "generic" ? atom.name : null
    if (NUMERIC.has(name)) return BUILTIN_MEMBERS.number
    return Object.hasOwn(BUILTIN_MEMBERS, name) ? BUILTIN_MEMBERS[name] : null
}

function checkBuiltinMember(node, type, env, report) {
    const present = atoms(type, env).filter(atom => !isNullish(atom))
    const sets = present.map(builtinMembers)
    if (present.length === 0 || sets.some(set => !set)) return false

    const member = node.property.name
    if (sets.every(set => set.has(member))) return true

    const missing = sets.find(set => !set.has(member))
    report(node.property, `${describe(widen(unionOf(present)))} has no property "${member}"${didYouMean(member, missing)}`)
    return true
}

const ENUM_API = new Set(["from", "has", "keys", "values", "scheme", "name", "type"])

function checkEnumMember(node, path_, env, report) {
    if (!t.isIdentifier(node.object)) return false
    const definition = env.enums.get(node.object.name)
    const binding = path_.scope.getBinding(node.object.name)
    if (!definition || (binding && !isDefinedBy(binding, "__def_enum__"))) return false

    const member = node.property.name
    if (!definition.members.has(member) && !ENUM_API.has(member)) {
        report(node.property, `"${node.object.name}" has no member "${member}"${didYouMean(member, definition.members)}`)
    }
    return true
}

function isDefinedBy(binding, runtimeCall) {
    const init = binding.path.isVariableDeclarator() ? binding.path.node.init : null
    return t.isCallExpression(init) && t.isIdentifier(init.callee, { name: runtimeCall })
}

function visibleNames(path_, env) {
    const names = new Set([...env.importedLocals, ...env.structs.keys(), ...env.enums.keys()])
    for (let scope = path_.scope; scope; scope = scope.parent) {
        for (const name of Object.keys(scope.bindings)) names.add(name)
    }
    return names
}

function checkUndefinedName(path_, env, report) {
    if (env.openGlobals || !path_.isReferencedIdentifier()) return
    const { name } = path_.node
    if (name.startsWith("__") || path_.scope.getBinding(name) || env.importedLocals.has(name)) return
    if (env.structs.has(name) || env.enums.has(name) || env.aliases.has(name) || env.customTypes.has(name)) return
    if (isKnownGlobal(name) || t.isUnaryExpression(path_.parent, { operator: "typeof" })) return

    const suggestion = didYouMean(name, visibleNames(path_, env))
    if (suggestion) report(path_.node, `"${name}" is not defined${suggestion}`)
}

function typeNames(type, found = []) {
    switch (type.kind) {
        case "named":
        case "enumMember":
            found.push(type.name)
            break
        case "generic":
            found.push(type.name)
            type.args.forEach(arg => typeNames(arg, found))
            break
        case "array":
            typeNames(type.element, found)
            break
        case "function":
            type.params.forEach(param => typeNames(param.type, found))
            typeNames(type.returns, found)
            break
        case "tuple":
        case "union":
        case "intersection":
            (type.items ?? type.types).forEach(part => typeNames(part, found))
    }
    return found
}

function checkTypeNames(type, node, path_, env, report, typeParams = []) {
    if (env.openGlobals) return
    const known = name => KNOWN.has(name) || BUILTIN_CLASSES.has(name) || typeParams.includes(name) ||
        env.structs.has(name) || env.enums.has(name) || env.aliases.has(name) || env.customTypes.has(name) ||
        env.importedLocals.has(name) || !!path_.scope.getBinding(name) || isKnownGlobal(name)
    const candidates = () => [
        ...KNOWN, ...BUILTIN_CLASSES, ...typeParams, ...env.structs.keys(), ...env.enums.keys(),
        ...env.aliases.keys(), ...env.customTypes, ...env.importedLocals
    ]

    for (const name of new Set(typeNames(type))) {
        if (known(name)) continue
        const suggestion = didYouMean(name, candidates())
        if (suggestion) report(node, `unknown type "${name}"${suggestion}`)
    }
}

function checkDeclaredTypes(path_, env, report) {
    const call = path_.node
    if (!t.isIdentifier(call.callee)) return
    const fn = path_.getFunctionParent()
    const [first, second] = call.arguments

    if (call.callee.name === "__typed_parameter__" && t.isIdentifier(first) && t.isStringLiteral(second)) {
        const param = fn?.node.params.find(p => (t.isAssignmentPattern(p) ? p.left : p)?.name === first.name)
        checkTypeNames(readType(second.value), param ?? fn?.node ?? call, path_, env, report)
    } else if (call.callee.name === "__declare_return__" && t.isStringLiteral(first)) {
        checkTypeNames(readType(first.value), fn?.node ?? call, path_, env, report)
    } else if (call.callee.name === "__def_struct__" && t.isObjectExpression(second)) {
        const typeParams = t.isArrayExpression(call.arguments[6])
            ? call.arguments[6].elements.filter(element => t.isStringLiteral(element)).map(element => element.value)
            : []
        for (const property of second.properties) {
            if (t.isObjectProperty(property) && t.isStringLiteral(property.value)) {
                checkTypeNames(readType(property.value.value), call, path_, env, report, typeParams)
            }
        }
    }
}


const DOM_EVENTS = new Set([
    "click", "dblclick", "mousedown", "mouseup", "mousemove", "mouseenter", "mouseleave", "mouseover", "mouseout",
    "contextmenu", "wheel", "keydown", "keyup", "keypress", "input", "change", "submit", "reset", "focus", "blur",
    "focusin", "focusout", "pointerdown", "pointerup", "pointermove", "pointerenter", "pointerleave", "pointercancel",
    "pointerover", "pointerout", "touchstart", "touchend", "touchmove", "touchcancel", "drag", "dragstart", "dragend",
    "dragenter", "dragleave", "dragover", "drop", "scroll", "scrollend", "resize", "load", "error", "abort", "select",
    "copy", "cut", "paste", "animationstart", "animationend", "animationiteration", "transitionstart",
    "transitionend", "transitionrun", "transitioncancel", "play", "pause", "ended", "timeupdate", "volumechange",
    "loadeddata", "loadedmetadata", "canplay", "canplaythrough", "seeking", "seeked", "waiting", "playing",
    "progress", "stalled", "suspend", "emptied", "ratechange", "durationchange", "invalid", "toggle", "beforeinput",
    "compositionstart", "compositionend", "compositionupdate", "gotpointercapture", "lostpointercapture",
    "selectionchange", "slotchange", "close", "cancel", "beforetoggle"
])

const HTML_ATTRIBUTES = new Set([
    "accept", "accept-charset", "accesskey", "action", "align", "allow", "alt", "async", "autocapitalize",
    "autocomplete", "autofocus", "autoplay", "background", "capture", "charset", "checked", "cite", "class", "color",
    "cols", "colspan", "content", "contenteditable", "controls", "coords", "crossorigin", "data", "datetime",
    "decoding", "default", "defer", "dir", "dirname", "disabled", "download", "draggable", "enctype",
    "enterkeyhint", "for", "form", "formaction", "formenctype", "formmethod", "formnovalidate", "formtarget",
    "headers", "height", "hidden", "high", "href", "hreflang", "http-equiv", "id", "inert", "inputmode",
    "integrity", "is", "ismap", "itemprop", "kind", "label", "lang", "list", "loading", "loop", "low", "max",
    "maxlength", "media", "method", "min", "minlength", "multiple", "muted", "name", "nonce", "novalidate", "open",
    "optimum", "pattern", "ping", "placeholder", "playsinline", "popover", "popovertarget", "poster", "preload",
    "readonly", "referrerpolicy", "rel", "required", "reversed", "role", "rows", "rowspan", "sandbox", "scope",
    "selected", "shape", "size", "sizes", "slot", "span", "spellcheck", "src", "srcdoc", "srclang", "srcset",
    "start", "step", "style", "tabindex", "target", "title", "translate", "type", "usemap", "value", "width", "wrap",
    "xmlns", "key", "enter", "leave", "move"
])

function markupOffsets(node, code) {
    const quasis = node._slimQuasis
    const expressions = node.quasi.expressions
    if (typeof node.start !== "number" || !code) return null
    const segments = []
    let joined = 0
    for (let i = 0; i < quasis.length; i++) {
        let start = node.start
        if (i > 0) {
            const end = expressions[i - 1]?.end
            if (typeof end !== "number") return null
            start = code.indexOf("}", end) + 1
        }
        segments.push([joined, start])
        joined += quasis[i].length + (i < quasis.length - 1 ? holeMark(i).length : 0)
    }
    return offset => {
        let found = segments[0]
        for (const segment of segments) if (segment[0] <= offset) found = segment
        return found[1] + offset - found[0]
    }
}

const camel = name => name[0].toUpperCase() + name.slice(1)

function checkComponentTag(element, at, path_, env, report) {
    const name = element.tag.split(".").pop()
    if (element.tag.includes(".")) return
    const signature = signatureFor(name, path_, env)
    const definition = signature?.parameters[0]?.type && structFor(signature.parameters[0].type, env)
    if (!definition?.component && !definition) return
    const shown = definition.component ?? definition.label
    const given = new Set()
    for (const attr of element.attrs) {
        if (attr.spread !== undefined) return
        if (attr.at === undefined || attr.name === "key") continue
        given.add(attr.name)
        if (!definition.fields.has(attr.name)) {
            report({ start: at(attr.at) }, `"${shown}" has no prop "${attr.name}"${didYouMean(attr.name, definition.fields.keys())}`)
        }
    }
    if (element.children.some(child => !(child.type === "text" && child.value.trim() === ""))) given.add("children")
    for (const [field, info] of definition.fields) {
        if (info.optional || given.has(field) || definition.defaults.has(field)) continue
        report({ start: at(element.at ?? 0) }, `"${shown}" is missing prop "${field}" of type ${describe(info.type)}`)
    }
}

function checkMarkup(node, path_, env, report) {
    const at = markupOffsets(node, env.code)
    if (!at) return
    let tree
    try {
        tree = parseMarkup(node._slimQuasis, message => { throw new Error(message) })
    } catch {
        return
    }

    const visit = (element, svg) => {
        if (element.type !== "element") return
        if (/^[A-Z]/.test(element.tag)) {
            checkComponentTag(element, at, path_, env, report)
            for (const child of element.children) visit(child, svg)
            return
        }
        const inSvg = svg || element.tag === "svg"
        const custom = element.tag.includes("-")
        for (const attr of element.attrs) {
            if (attr.at === undefined) continue
            if (attr.event !== undefined) {
                if (DOM_EVENTS.has(attr.event)) continue
                const match = closest(attr.event, DOM_EVENTS)
                if (match) report({ start: at(attr.at) }, `unknown event "${attr.name}" — did you mean "on${camel(match)}"?`)
                continue
            }
            const name = attr.name.toLowerCase()
            if (inSvg || custom || HTML_ATTRIBUTES.has(name) || /[-:]/.test(name) || name.startsWith("on")) continue
            const match = closest(name, HTML_ATTRIBUTES)
            if (match) report({ start: at(attr.at) }, `unknown attribute "${attr.name}" on <${element.tag}> — did you mean "${match}"?`)
        }
        for (const child of element.children) visit(child, inSvg && element.tag !== "foreignObject")
    }
    for (const root of tree) visit(root, false)
}

function verify(ast, env, report) {
    traverse(ast, {
        TaggedTemplateExpression(path_) {
            if (path_.node._slimMarkup && path_.node._slimQuasis) checkMarkup(path_.node, path_, env, report)
        },

        VariableDeclarator(path_) {
            const { id, init } = path_.node
            if (!t.isIdentifier(id) || !t.isCallExpression(init)) return

            const label = typedVariableLabel(init)
            if (!label) return

            checkTypeNames(readType(label), id, path_, env, report)
            checkValue(readType(label), init.arguments[0], path_, env, report, `"${id.name}"`)
        },

        AssignmentExpression(path_) {
            const { node } = path_
            if (node.operator !== "=") return

            const target = node.left
            if (t.isMemberExpression(target) && !target.computed && t.isIdentifier(target.property)) {
                const definition = structFor(infer(target.object, path_, env), env)
                if (!definition) return

                const owner = definition.label
                const name = target.property.name
                const field = definition.fields.get(name)
                if (!field) {
                    if (!definition.methods.has(name) && !definition.open) report(target.property, `"${owner}" has no field "${name}"${didYouMean(name, memberNames(definition))}`)
                    return
                }
                if (field.readonly) {
                    report(target, `"${owner}.${name}" is readonly`)
                    return
                }

                const expected = field.optional ? unionOf([field.type, UNDEFINED]) : field.type
                checkValue(expected, node.right, path_, env, report, `"${owner}.${name}"`)
                return
            }

            if (!t.isIdentifier(node.left)) return

            const binding = path_.scope.getBinding(node.left.name)
            const declared = binding ? env.bindings.get(binding) : null
            if (!declared) return

            checkValue(declared, node.right, path_, env, report, `"${node.left.name}"`)
        },

        ExpressionStatement(path_) {
            if (!path_.getFunctionParent()?.node.async) return

            const call = unwrapHandledPromise(path_.node.expression)
            if (!calleeSignature(call, path_, env)?.async) return

            const name = calleeName(call)
            report(call, `"${name}" is async and nothing awaits it: add await, or write "void ${name}(...)" to run it in the background`)
        },

        CallExpression(path_) {
            const { node } = path_

            checkDeclaredTypes(path_, env, report)
            const match = matchExpression(node)
            if (match) checkExhaustive(node, match, path_, env, report)

            checkAsyncCallback(node, path_, env, report)

            const constructed = structLiteralName(node, env)
            if (constructed && t.isObjectExpression(node.arguments[0])) {
                checkStructLiteral(named(constructed), node.arguments[0], path_, env, report, false)
                return
            }

            if (t.isIdentifier(node.callee)) {
                checkCall(signatureFor(node.callee.name, path_, env), node, node.callee.name, path_, env, report)
                return
            }

            const callee = node.callee
            if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.property)) return

            const definition = structFor(infer(callee.object, path_, env), env)
            const method = definition?.methods.get(callee.property.name)
            if (method) checkCall(method, node, `${definition.label}.${callee.property.name}`, path_, env, report, definition.bound)
        },

        ReturnStatement(path_) {
            const fn = path_.getFunctionParent()
            const declared = fn ? env.returns.get(fn.node) : null
            if (!declared) return

            const value = path_.node.argument
            if (!value) {
                if (!accepts(declared.type, UNDEFINED, env)) {
                    report(path_.node, `"${declared.name}" must return ${describe(declared.type)}, got undefined`)
                }
                return
            }

            checkValue(declared.type, value, path_, env, report, `"${declared.name}"`, "must return")
        },

        MemberExpression(path_) {
            const { node } = path_
            if (node.computed || !t.isIdentifier(node.property)) return
            if (t.isAssignmentExpression(path_.parent) && path_.parent.left === node) return

            if (checkEnumMember(node, path_, env, report)) return

            const objectType = infer(node.object, path_, env)
            if (!objectType || checkBuiltinMember(node, objectType, env, report)) return

            const present = atoms(objectType, env).filter(atom => !isNullish(atom))
            const definition = present.length === 1 ? structFor(present[0], env) : null
            if (!definition) return

            const field = node.property.name
            if (definition.fields.has(field) || definition.methods.has(field) || definition.open) return

            report(node.property, `"${definition.label}" has no field "${field}"${didYouMean(field, memberNames(definition))}`)
        },

        Identifier(path_) {
            checkUndefinedName(path_, env, report)
        }
    })
}


function exportedNames(ast) {
    const names = new Map()

    traverse(ast, {
        ExportNamedDeclaration(path_) {
            const declaration = path_.node.declaration

            if (t.isVariableDeclaration(declaration)) {
                for (const declarator of declaration.declarations) {
                    if (t.isIdentifier(declarator.id)) names.set(declarator.id.name, declarator.id.name)
                }
            } else if ((t.isFunctionDeclaration(declaration) || t.isClassDeclaration(declaration)) && declaration.id) {
                names.set(declaration.id.name, declaration.id.name)
            }

            for (const specifier of path_.node.specifiers ?? []) {
                if (!t.isExportSpecifier(specifier)) continue
                const exported = t.isIdentifier(specifier.exported)
                    ? specifier.exported.name
                    : specifier.exported.value
                names.set(exported, specifier.local.name)
            }
        }
    })

    return names
}

function settle(signature, env) {
    if (!signature || signature.returns || "inferred" in signature) return signature
    return { ...signature, inferred: inferReturn(signature.node, env) }
}

function buildModuleTypes(ast, env) {
    const record = {
        structs: new Map(),
        enums: new Map(),
        customTypes: new Set(),
        functions: new Map(),
        aliases: new Map(),
        ambient: { structs: new Map(), enums: new Map(), customTypes: new Set(), aliases: new Map() }
    }

    for (const name of env.structs.keys()) {
        const resolved = resolveStruct(name, env)
        if (!resolved) continue
        const methods = new Map([...resolved.methods].map(([method, signature]) => [method, settle(signature, env)]))
        record.ambient.structs.set(name, { ...resolved, methods })
    }
    for (const [name, definition] of env.enums) record.ambient.enums.set(name, definition)
    for (const name of env.customTypes) record.ambient.customTypes.add(name)
    for (const [name, type] of env.aliases) record.ambient.aliases.set(name, type)

    for (const [exported, local] of exportedNames(ast)) {
        const struct = record.ambient.structs.get(local)
        if (struct) record.structs.set(exported, struct)
        if (env.enums.has(local)) record.enums.set(exported, env.enums.get(local))
        if (env.customTypes.has(local)) record.customTypes.add(exported)
        if (env.aliases.has(local)) record.aliases.set(exported, env.aliases.get(local))
        if (env.functionsByName.has(local)) record.functions.set(exported, settle(env.functionsByName.get(local), env))
    }

    return record
}

function seedImports(env, imports, wildcards) {
    const merge = (record, name, local) => {
        if (record.structs.has(name)) env.structs.set(local, record.structs.get(name))
        if (record.enums.has(name)) env.enums.set(local, record.enums.get(name))
        if (record.customTypes.has(name)) env.customTypes.add(local)
        if (record.aliases.has(name)) env.aliases.set(local, record.aliases.get(name))
        if (record.functions.has(name)) env.importedFunctions.set(local, record.functions.get(name))
    }

    const sources = new Set([...wildcards, ...imports.map(entry => entry.source)])

    for (const source of sources) {
        const record = moduleTypes.get(source)
        if (!record) continue

        for (const [name, definition] of record.ambient.structs) {
            if (!env.structs.has(name)) env.structs.set(name, definition)
        }
        for (const [name, definition] of record.ambient.enums) {
            if (!env.enums.has(name)) env.enums.set(name, definition)
        }
        for (const name of record.ambient.customTypes) env.customTypes.add(name)
        for (const [name, type] of record.ambient.aliases) {
            if (!env.aliases.has(name)) env.aliases.set(name, type)
        }
    }

    for (const source of wildcards) {
        const record = moduleTypes.get(source)
        if (!record) continue
        for (const name of record.structs.keys()) merge(record, name, name)
        for (const name of record.enums.keys()) merge(record, name, name)
        for (const name of record.customTypes) merge(record, name, name)
        for (const name of record.aliases.keys()) merge(record, name, name)
        for (const name of record.functions.keys()) merge(record, name, name)
    }

    for (const { local, imported, source } of imports) {
        const record = moduleTypes.get(source)
        if (record) merge(record, imported, local)
    }
}

export function checkTypes(ast, { originalCode, sourceFile, imports = [], wildcards = [], locals = [], openGlobals = false }) {
    const env = createEnvironment()
    env.code = originalCode
    env.importedLocals = new Set(locals)
    env.openGlobals = openGlobals
    const diagnostics = []
    const originalLines = computeLineStarts(originalCode)
    const sourceLines = originalCode.split("\n")
    const reported = new Set()

    const report = (node, message) => {
        const offset = typeof node.start === "number" ? node.start : 0
        const key = `${offset}:${message}`
        if (reported.has(key)) return
        reported.add(key)

        const location = offsetToLineCol(offset, originalLines)
        diagnostics.push({
            message,
            sourceFile,
            line: location.line + 1,
            column: location.column + 1,
            sourceLine: (sourceLines[location.line] ?? "").replace(/\r$/, "")
        })
    }

    seedImports(env, imports, wildcards)
    collect(ast, env)
    verify(ast, env, report)
    moduleTypes.set(path.resolve(sourceFile), buildModuleTypes(ast, env))

    diagnostics.sort((a, b) => a.line - b.line || a.column - b.column)
    return diagnostics
}

export function formatDiagnostics(diagnostics) {
    return diagnostics.map(({ message, sourceFile, line, column, sourceLine }) => {
        const text = sourceLine.trim()
        const indent = sourceLine.length - sourceLine.trimStart().length
        const pointer = " ".repeat(Math.max(0, column - 1 - indent)) + "^"

        return [
            `TypeError: ${message}`,
            `    at ${sourceFile}:${line}:${column}`,
            "",
            `  ${text}`,
            `  ${pointer}`
        ].join("\n")
    }).join("\n\n")
}
