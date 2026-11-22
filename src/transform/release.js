import _traverse from "@babel/traverse"
import * as t from "@babel/types"

const traverse = _traverse.default ?? _traverse

const UNWRAPPED_IN_RELEASE = new Set(["__typed_variable__", "__typed_pattern__"])
const REMOVED_IN_RELEASE = new Set(["__typed_parameter__", "__declare_return__"])

export function stripRuntimeChecks(ast) {
    traverse(ast, {
        ExpressionStatement(path_) {
            const call = path_.node.expression
            if (t.isCallExpression(call) && t.isIdentifier(call.callee) && REMOVED_IN_RELEASE.has(call.callee.name)) {
                path_.remove()
            }
        },
        CallExpression(path_) {
            const { callee, arguments: args } = path_.node
            if (t.isIdentifier(callee, { name: "__def_variants__" })) {
                while (args.length < 5) args.push(t.nullLiteral())
                args[5] = t.booleanLiteral(true)
                return
            }
            if (t.isIdentifier(callee) && UNWRAPPED_IN_RELEASE.has(callee.name) && args[0]) {
                path_.replaceWith(args[0])
            }
        }
    })
}
