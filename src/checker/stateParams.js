import * as t from "@babel/types"
import { sourceText } from "./core.js"

const MUTATING = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin", "set", "add", "delete", "clear"])

function changes(reference) {
    let chain = reference
    while (chain.parentPath?.isMemberExpression() && chain.parentPath.node.object === chain.node) chain = chain.parentPath
    const parent = chain.parentPath
    if (chain !== reference) {
        if (parent.isAssignmentExpression() && parent.node.left === chain.node) return true
        if (parent.isUpdateExpression() || parent.isUnaryExpression({ operator: "delete" })) return true
    }
    if (!chain.isMemberExpression() || chain.node.computed || !t.isIdentifier(chain.node.property)) return false
    return MUTATING.has(chain.node.property.name) && parent.isCallExpression() && parent.node.callee === chain.node
}

function changedParams(fnPath, cache) {
    if (cache.has(fnPath.node)) return cache.get(fnPath.node)
    const found = new Map()
    cache.set(fnPath.node, found)
    fnPath.node.params.forEach((param, index) => {
        if (!t.isIdentifier(param)) return
        const binding = fnPath.scope.getBinding(param.name)
        if (!binding || binding.kind !== "param" || binding.constantViolations.length) return
        if (binding.referencePaths.some(changes)) found.set(index, param.name)
    })
    return found
}

function calledFunction(callee, path_) {
    if (!t.isIdentifier(callee)) return null
    const binding = path_.scope.getBinding(callee.name)
    if (!binding || binding.constantViolations.length) return null
    if (binding.path.isFunctionDeclaration()) return binding.path
    if (binding.kind === "const" && binding.path.isVariableDeclarator()) {
        const init = binding.path.get("init")
        if (init.isArrowFunctionExpression() || init.isFunctionExpression()) return init
    }
    return null
}

function stateRoot(node, path_) {
    let root = node
    while (t.isMemberExpression(root) || t.isOptionalMemberExpression(root) || t.isTSNonNullExpression(root)) root = root.object ?? root.expression
    if (!t.isIdentifier(root)) return null
    const binding = path_.scope.getBinding(root.name)
    return binding?.path.isVariableDeclarator() && binding.path.parent.slimState ? root.name : null
}

export function stateParamVisitor(warn) {
    const cache = new WeakMap()
    return {
        CallExpression(path_) {
            const fn = calledFunction(path_.node.callee, path_)
            if (!fn) return
            const changed = changedParams(fn, cache)
            if (changed.size === 0) return
            path_.node.arguments.forEach((argument, index) => {
                const param = changed.get(index)
                const state = param && stateRoot(argument, path_)
                if (!state) return
                const text = sourceText(argument) ?? state
                warn(argument, `"${path_.node.callee.name}" changes its parameter "${param}", and "${text}" comes from state "${state}": the page won't see that change — change it through "${state}" here, or assign "${state}" a new value`)
            })
        }
    }
}
