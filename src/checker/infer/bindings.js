import * as t from "@babel/types"
import { readType, unionOf } from "../../external/typeSyntax.js"
import { FUNCTION, UNDEFINED, accepts, atoms, classFor, isNamed, isNullish, isOpen, single, structFor, widen } from "../core.js"
import { infer } from "../infer.js"
import { elementType, functionTypeOf, typedVariableLabel } from "./signatures.js"
import { valueType } from "./methods.js"
import { structDefinitionType } from "./members.js"
import { contextualParam } from "./expected.js"

function unwritten(binding) {
    return binding.referencePaths.every(reference => {
        const parent = reference.parentPath
        if (parent.isMemberExpression() && parent.node.object === reference.node) {
            const outer = parent.parentPath
            if (outer.isAssignmentExpression() && outer.node.left === parent.node) return false
            if (outer.isUpdateExpression() || outer.isUnaryExpression({ operator: "delete" })) return false
            return true
        }
        if (parent.isCallExpression() && parent.node.callee !== reference.node) {
            const callee = parent.node.callee
            return !(t.isMemberExpression(callee) && t.isIdentifier(callee.object, { name: "Object" }))
        }
        return true
    })
}

function literalShape(init, declarator, binding, env) {
    if (!t.isObjectExpression(init) || init.properties.length === 0 || !unwritten(binding)) return null
    const fields = []
    for (const property of init.properties) {
        if (t.isObjectMethod(property) && !property.computed && t.isIdentifier(property.key) && property.kind === "method") {
            fields.push({ name: property.key.name, type: FUNCTION, optional: false })
            continue
        }
        if (!t.isObjectProperty(property) || property.computed) return null
        const name = t.isIdentifier(property.key) ? property.key.name : t.isStringLiteral(property.key) ? property.key.value : null
        if (name === null) return null
        fields.push({ name, type: valueType(property.value, declarator, env), optional: false })
    }
    return { kind: "shape", fields, exact: true }
}

function assignedUnion(init, declarator, binding, env) {
    const found = [infer(init, declarator, env)]
    const own = declarator.getFunctionParent()?.node ?? null
    for (const violation of binding.constantViolations) {
        const node = violation.node
        if (!t.isAssignmentExpression(node, { operator: "=" }) || !t.isIdentifier(node.left)) return null
        if ((violation.getFunctionParent()?.node ?? null) !== own) return null
        found.push(infer(node.right, violation, env))
    }
    if (found.some(type => !type || atoms(type, env).some(atom => atom.kind === "named" && atom.name === "any"))) return null
    return widen(unionOf(found))
}

function declaredInitType(binding, env) {
    if (env.initTypes.has(binding)) {
        if (env.pending.has(binding)) env.taint++
        return env.initTypes.get(binding)
    }
    env.initTypes.set(binding, null)
    env.pending.add(binding)

    let type = null
    const declarator = binding.path
    if (declarator.isVariableDeclarator() && t.isIdentifier(declarator.node.id)) {
        const { init } = declarator.node
        if (init && binding.constantViolations.length === 0) {
            type = (binding.kind === "const" && literalShape(init, declarator, binding, env)) || infer(init, declarator, env)
            if (type && binding.kind !== "const") type = widen(type)
        } else if (init) {
            type = assignedUnion(init, declarator, binding, env)
        } else if (!init) {
            const loop = declarator.parentPath.parentPath
            if (loop?.isForOfStatement() && declarator.parentPath.key === "left") {
                type = elementType(infer(loop.node.right, loop, env), env)
            }
        }
    } else if (declarator.isVariableDeclarator() && (binding.kind === "const" || binding.constantViolations.length === 0)) {
        const { id, init } = declarator.node
        const loop = declarator.parentPath.parentPath
        let source = null
        if (init && t.isCallExpression(init) && t.isIdentifier(init.callee, { name: "__typed_pattern__" }) && t.isStringLiteral(init.arguments[1])) {
            source = readType(init.arguments[1].value)
        } else if (init) source = infer(init, declarator, env)
        else if (loop?.isForOfStatement() && declarator.parentPath.key === "left") source = elementType(infer(loop.node.right, loop, env), env)
        type = source ? patternType(id, source, binding.identifier, env) : null
    }

    env.initTypes.set(binding, type)
    env.pending.delete(binding)
    return type
}

function patternType(pattern, source, target, env) {
    if (pattern === target) return source
    if (t.isAssignmentPattern(pattern)) {
        const inner = patternType(pattern.left, source, target, env)
        if (!inner) return null
        const present = atoms(inner, env).filter(atom => !isNamed(atom, "undefined"))
        return present.length === atoms(inner, env).length ? inner : null
    }
    if (t.isArrayPattern(pattern)) {
        const atom = single(source, env)
        for (const [index, element] of pattern.elements.entries()) {
            if (!element || !containsBinding(element, target)) continue
            if (t.isRestElement(element)) return null
            if (atom?.kind === "tuple") return atom.items[index] ? patternType(element, atom.items[index], target, env) : null
            const item = atom && elementType(atom, env)
            return item ? patternType(element, item, target, env) : null
        }
        return null
    }
    if (t.isObjectPattern(pattern)) {
        for (const property of pattern.properties) {
            if (!containsBinding(property, target)) continue
            if (t.isRestElement(property) || property.computed) return null
            const key = t.isIdentifier(property.key) ? property.key.name : t.isStringLiteral(property.key) ? property.key.value : null
            const definition = key && (structFor(source, env) ?? classFor(source, env))
            const field = definition?.fields.get(key)
            if (!field) return null
            return patternType(property.value, field.optional ? unionOf([field.type, UNDEFINED]) : field.type, target, env)
        }
    }
    return null
}

function containsBinding(node, target) {
    if (node === target) return true
    if (!node || typeof node !== "object") return false
    if (t.isObjectProperty(node)) return containsBinding(node.value, target)
    if (t.isAssignmentPattern(node)) return containsBinding(node.left, target)
    if (t.isRestElement(node)) return containsBinding(node.argument, target)
    if (t.isArrayPattern(node)) return node.elements.some(element => containsBinding(element, target))
    if (t.isObjectPattern(node)) return node.properties.some(property => containsBinding(property, target))
    return false
}

function refinedDeclared(binding, declared, env) {
    if (binding.constantViolations.length > 0) return declared
    if (env.refinedTypes.has(binding)) {
        if (env.pending.has(env.refinedTypes)) env.taint++
        return env.refinedTypes.get(binding)
    }
    env.refinedTypes.set(binding, declared)

    const declarator = binding.path
    let result = declared
    if (declarator.isVariableDeclarator() && t.isCallExpression(declarator.node.init) && typedVariableLabel(declarator.node.init)) {
        const pendingBefore = env.pending.has(env.refinedTypes)
        env.pending.add(env.refinedTypes)
        try {
            const actual = infer(declarator.node.init.arguments[0], declarator, env)
            if (actual && atoms(declared, env).length > 1) {
                const fitting = atoms(declared, env).filter(atom => accepts(atom, actual, env))
                if (fitting.length > 0) result = unionOf(fitting)
            }
        } finally {
            if (!pendingBefore) env.pending.delete(env.refinedTypes)
        }
    }

    env.refinedTypes.set(binding, result)
    return result
}

export function identifierType(node, path_, env) {
    const binding = path_.scope.getBinding(node.name)
    if (!binding) {
        if (env.declaredValues.has(node.name)) return env.declaredValues.get(node.name)
        if (env.importedValues.has(node.name)) return env.importedValues.get(node.name)
        return env.importedLocals.has(node.name) && !env.ambientNames.has(node.name) ? structDefinitionType(node.name, env) : null
    }
    if (env.bindings.has(binding)) return refinedDeclared(binding, env.bindings.get(binding), env)
    if (binding.kind === "param") return contextualParam(binding, env)
    if (binding.kind === "const" || binding.kind === "let" || binding.kind === "var") return declaredInitType(binding, env)
    if (binding.kind === "hoisted" && binding.path.isFunctionDeclaration()) return functionTypeOf(binding.path.node, env)
    return null
}

export function thisOwner(path_, env) {
    let fn = path_.getFunctionParent()
    while (fn && fn.isArrowFunctionExpression()) fn = fn.parentPath.getFunctionParent()
    return fn ? env.methodOwners.get(fn.node) ?? null : null
}

export function falsyParts(type, env) {
    return atoms(type, env).filter(atom => {
        if (atom.kind === "literal") return !atom.value
        if (atom.kind !== "named") return false
        return ["null", "undefined", "bool", "int", "float", "number", "string", "any"].includes(atom.name) || isOpen(atom, env)
    })
}

export function truthyParts(type, env) {
    return atoms(type, env).filter(atom => !isNullish(atom) && !(atom.kind === "literal" && !atom.value))
}
