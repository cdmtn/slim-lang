import _traverse from "@babel/traverse"
import * as t from "@babel/types"

const traverse = _traverse.default ?? _traverse

const hostGlobals = new Map()

export function rememberGlobals(file, declared) {
    hostGlobals.set(file, declared.map(([name]) => name))
}

export function globalsOf(file) {
    return file ? hostGlobals.get(file) ?? [] : []
}

function isTarget(path_) {
    const { parent, key } = path_
    if (t.isAssignmentExpression(parent) && key === "left") return true
    if (t.isUpdateExpression(parent)) return true
    return false
}

export function rewriteGlobals(ast, names) {
    if (names.size === 0) return
    traverse(ast, {
        Program(path_) {
            path_.scope.crawl()
        },
        Identifier(path_) {
            const { name } = path_.node
            if (!names.has(name)) return
            if (!path_.isReferencedIdentifier() && !isTarget(path_)) return
            if (t.isExportSpecifier(path_.parent)) return
            if (path_.scope.getBinding(name)) return
            path_.replaceWith(t.memberExpression(t.identifier("globalThis"), t.identifier(name)))
            path_.skip()
        }
    })
}
