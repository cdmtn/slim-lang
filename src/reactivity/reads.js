import * as t from "@babel/types"

export let importedReactive = new Map()
export let importedReaders = new Set()

export function useImported(reactive = new Map(), readers = new Set()) {
    const previous = [importedReactive, importedReaders]
    importedReactive = reactive
    importedReaders = readers
    return previous
}

export function reactiveKind(path) {
    const binding = path.scope.getBinding(path.node.name)
    if (!binding) return importedReactive.get(path.node.name) ?? null
    const node = binding.identifier
    if (node._slimReactive) return node._slimReactive
    if (node._slimProps) return "props"
    if (node._slimPropAlias !== undefined) return "alias"
    return null
}

const IN_PLACE_CALLBACKS = new Set([
    "map", "flatMap", "filter", "find", "findIndex", "findLast", "findLastIndex", "some", "every",
    "reduce", "reduceRight", "forEach", "sort", "toSorted"
])

function runsInPlace(fn) {
    const parent = fn.parentPath
    if (!parent.isCallExpression() && !parent.isOptionalCallExpression()) return false
    if (fn.key === "callee") return true
    const { callee } = parent.node
    const isMethod = t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
    return fn.listKey === "arguments" && isMethod && !callee.computed && IN_PLACE_CALLBACKS.has(callee.property.name)
}

function localFunction(callee) {
    if (!callee.isIdentifier()) return null
    const binding = callee.scope.getBinding(callee.node.name)
    if (!binding) return null
    if (binding.path.isFunctionDeclaration()) return binding.path
    if (binding.path.isVariableDeclarator() && binding.path.get("init").isFunction()) return binding.path.get("init")
    return null
}

export function readsReactive(path, seen = new Set()) {
    if (path.isIdentifier()) return reactiveKind(path) !== null
    if (path.isFunction() && !seen.has(path.node)) return false
    let found = false
    const stop = inner => {
        found = true
        inner.stop()
    }
    const callsReactive = call => {
        const callee = call.get("callee")
        if (callee.isIdentifier() && importedReaders.has(callee.node.name) && !callee.scope.getBinding(callee.node.name)) return true
        const called = localFunction(callee)
        if (!called || seen.has(called.node)) return false
        seen.add(called.node)
        return readsReactive(called, seen)
    }
    if (path.isCallExpression() && callsReactive(path)) return true
    path.traverse({
        Function(inner) {
            if (!runsInPlace(inner)) inner.skip()
        },
        CallExpression(inner) {
            if (callsReactive(inner)) stop(inner)
        },
        Identifier(inner) {
            if (!inner.isReferencedIdentifier()) return
            if (reactiveKind(inner) !== null) stop(inner)
        }
    })
    return found
}
