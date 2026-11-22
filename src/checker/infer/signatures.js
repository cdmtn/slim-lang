import * as t from "@babel/types"
import { ANY, arrayOf, functionOf, genericOf, substituteType, tupleOf, unionOf } from "../../external/typeSyntax.js"
import { FUNCTION, STRING, atoms, isArrayLike, isNamed, isNullish, single, typeNames } from "../core.js"
import { collectParameters, infer } from "../infer.js"
import { bindTypeParams, inferReturn } from "./generics.js"
import { contextualParam } from "./expected.js"

export function signatureFor(name, path_, env) {
    const binding = path_.scope.getBinding(name)
    if (binding) return env.functions.get(binding) ?? signatureOfType(env.bindings.get(binding), env)
    return env.importedFunctions.get(name) ?? signatureOfType(env.importedValues.get(name) ?? env.declaredValues.get(name), env)
}

export function signatureOfType(type, env) {
    const atom = type && single(type, env)
    if (atom?.kind !== "function") return null
    return {
        parameters: atom.params.map((param, index) => param.rest
            ? { name: param.name ?? `#${index + 1}`, type: param.type, required: false, rest: true }
            : { name: param.name ?? `#${index + 1}`, type: param.type, required: !param.optional }),
        rest: atom.params.some(param => param.rest),
        returns: atom.returns,
        async: false,
        typed: true,
        node: null,
        typeParams: []
    }
}

export function functionTypeOf(fn, env) {
    const fnPath = env.functionPaths.get(fn)
    if (!fnPath) return FUNCTION

    const signature = collectParameters(fn)
    const params = signature.parameters.map(param => {
        const binding = param.name && fnPath.scope.getBinding(param.name)
        const type = param.type ?? (binding && binding.kind === "param" ? contextualParam(binding, env) : null)
        return param.rest ? { name: param.name, type: type ?? arrayOf(ANY), rest: true } : { name: param.name, type: type ?? ANY, optional: !param.required }
    })
    return functionOf(params, returnType(signature, env) ?? ANY)
}

export function typedVariableLabel(node) {
    if (!t.isCallExpression(node)) return null
    if (!t.isIdentifier(node.callee, { name: "__typed_variable__" })) return null
    return t.isStringLiteral(node.arguments[1]) ? node.arguments[1].value : null
}

const READ_ONLY_ARRAY = new Set(["length", "map", "filter", "find", "findIndex", "findLast", "findLastIndex", "some", "every", "forEach",
    "flatMap", "reduce", "reduceRight", "includes", "indexOf", "lastIndexOf", "join", "slice", "concat", "at", "entries", "keys", "values",
    "toSorted", "toReversed", "toSpliced", "with", "flat", "toString"])

function sameReference(left, right) {
    if (t.isIdentifier(left) && t.isIdentifier(right)) return left.name === right.name
    if (t.isThisExpression(left) && t.isThisExpression(right)) return true
    return t.isMemberExpression(left) && t.isMemberExpression(right) && !left.computed && !right.computed &&
        t.isIdentifier(left.property) && t.isIdentifier(right.property) && left.property.name === right.property.name && sameReference(left.object, right.object)
}

function lengthOffset(index, object) {
    const isLength = node => t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property, { name: "length" }) && sameReference(node.object, object)
    if (isLength(index)) return 0
    if (t.isBinaryExpression(index, { operator: "+" })) {
        if (isLength(index.left) && t.isNumericLiteral(index.right)) return index.right.value
        if (isLength(index.right) && t.isNumericLiteral(index.left)) return index.left.value
    }
    return null
}

function fixedArray(object, path_) {
    if (!t.isIdentifier(object)) return null
    const binding = path_.scope.getBinding(object.name)
    if (!binding || binding.kind !== "const" || binding.constantViolations.length || !binding.path.isVariableDeclarator()) return null
    let init = binding.path.node.init
    if (typedVariableLabel(init)) init = init.arguments[0]
    if (!t.isArrayExpression(init) || init.elements.some(element => !element || t.isSpreadElement(element))) return null
    for (const reference of binding.referencePaths) {
        const parent = reference.parentPath
        if (!parent?.isMemberExpression() || parent.node.object !== reference.node) return null
        if (parent.node.computed) {
            if (!t.isNumericLiteral(parent.node.property)) return null
            if (parent.parentPath.isAssignmentExpression() && parent.key === "left") return null
            if (parent.parentPath.isUpdateExpression() || parent.parentPath.isUnaryExpression({ operator: "delete" })) return null
        } else if (!t.isIdentifier(parent.node.property) || !READ_ONLY_ARRAY.has(parent.node.property.name)) return null
    }
    return init.elements.length
}

export function indexOutOfRange(node, path_, env) {
    if (!node.computed || node.optional) return null
    if (t.isAssignmentExpression(path_.parent) && path_.parent.left === node) return null
    if (t.isUnaryExpression(path_.parent, { operator: "delete" }) || t.isUpdateExpression(path_.parent)) return null
    const offset = lengthOffset(node.property, node.object)
    if (offset !== null && offset >= 0) return { reason: offset === 0 ? "the last index is length - 1" : "it is past the last index" }
    if (!t.isNumericLiteral(node.property) || !Number.isInteger(node.property.value)) return null
    const index = node.property.value
    const object = infer(node.object, path_, env)
    const atom = object && single(object, env)
    if (atom?.kind === "tuple" && index >= atom.items.length) return { length: atom.items.length }
    if (atom?.kind === "literal" && typeof atom.value === "string" && index >= atom.value.length) return { length: atom.value.length, text: true }
    const fixed = atom && isArrayLike(atom) ? fixedArray(node.object, path_) : null
    if (fixed !== null && index >= fixed) return { length: fixed }
    return null
}

export function structLiteralName(node, env) {
    if (!t.isCallExpression(node)) return null
    const callee = node.callee
    if (!t.isMemberExpression(callee) || callee.computed) return null
    if (!t.isIdentifier(callee.property, { name: "new" })) return null
    if (!t.isIdentifier(callee.object) || !env.structs.has(callee.object.name)) return null
    return callee.object.name
}

export function elementType(type, env) {
    const all = type ? atoms(type, env).filter(atom => !isNullish(atom)) : []
    const elements = []
    for (const atom of all) {
        if (atom.kind === "array" && !isNamed(atom.element, "null")) elements.push(atom.element)
        else if (atom.kind === "tuple") elements.push(...atom.items)
        else if (atom.kind === "generic" && (atom.name === "Set" || atom.name === "Array" || atom.name === "Iterator")) elements.push(atom.args[0] ?? ANY)
        else if (atom.kind === "generic" && atom.name === "Map") elements.push(tupleOf([atom.args[0] ?? ANY, atom.args[1] ?? ANY]))
        else if (isNamed(atom, "string")) elements.push(STRING)
        else return null
    }
    return elements.length ? unionOf(elements) : null
}

export function returnType(signature, env, call = null, path_ = null, bound = null) {
    if (!signature) return null
    let returns = signature.returns ?? signature.inferred ?? inferReturn(signature.node, env)
    if (!returns) return null
    if (call && (signature.typeParams?.length || bound?.size)) {
        returns = substituteType(returns, bindTypeParams(signature, call, path_, env, bound))
    }
    return signature.async ? genericOf("Promise", [asyncResult(returns, env)]) : returns
}

export function asyncResult(type, env) {
    const atom = type && single(type, env)
    return atom?.kind === "generic" && atom.name === "Promise" ? atom.args[0] ?? ANY : type
}

export const mentions = (type, names) => typeNames(type).some(name => names.includes(name))
