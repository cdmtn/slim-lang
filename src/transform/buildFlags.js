import _traverse from "@babel/traverse"
import * as t from "@babel/types"

const traverse = _traverse.default ?? _traverse

export const BUILD_FLAGS = ["SLIM_RELEASE", "SLIM_DEV"]

function constant(node) {
    if (t.isBooleanLiteral(node)) return node.value
    if (t.isUnaryExpression(node, { operator: "!" }) && t.isBooleanLiteral(node.argument)) return !node.argument.value
    return null
}

function replaceStatement(path_, statement) {
    if (statement) path_.replaceWith(statement)
    else if (path_.inList) path_.remove()
    else path_.replaceWith(t.blockStatement([]))
}

export function applyBuildFlags(ast, release) {
    const values = { SLIM_RELEASE: release, SLIM_DEV: !release }
    let replaced = false
    traverse(ast, {
        ReferencedIdentifier(path_) {
            const { name } = path_.node
            if (!Object.hasOwn(values, name) || path_.scope.getBinding(name)) return
            path_.replaceWith(t.booleanLiteral(values[name]))
            replaced = true
        }
    })
    if (!replaced) return

    traverse(ast, {
        UnaryExpression: {
            exit(path_) {
                const value = constant(path_.node)
                if (value !== null && !t.isBooleanLiteral(path_.node)) path_.replaceWith(t.booleanLiteral(value))
            }
        },
        LogicalExpression: {
            exit(path_) {
                const { operator, left, right } = path_.node
                const value = constant(left)
                if (value === null || operator === "??") return
                const keepLeft = operator === "&&" ? !value : value
                path_.replaceWith(keepLeft ? t.booleanLiteral(value) : right)
            }
        },
        ConditionalExpression: {
            exit(path_) {
                const value = constant(path_.node.test)
                if (value !== null) path_.replaceWith(value ? path_.node.consequent : path_.node.alternate)
            }
        },
        IfStatement: {
            exit(path_) {
                const value = constant(path_.node.test)
                if (value !== null) replaceStatement(path_, value ? path_.node.consequent : path_.node.alternate)
            }
        }
    })
}
