import * as t from "@babel/types"
import { FUNCTION_TYPES, PREFIX_CALLS, SKIP_KEYS, call, escapeMarkupText, id, isNode, withLoc } from "./helpers.js"

export const expressionLowering = {
    NewExpression(node) {
        const args = node.typeParameters?.params ?? node.typeArguments?.params
        if (args?.length) node._slimTypeArgs = args.map(arg => this.label(arg, { keepTypeParams: true }))
        return node
    },

    CallExpression(node) {
        return this.NewExpression(node)
    },

    SlimUnaryExpression(node) {
        return withLoc(call(PREFIX_CALLS[node.operator], [node.argument]), node)
    },

    SlimPipeExpression(node) {
        const { left, right } = node
        const result = right.type === "CallExpression" && !right.extra?.parenthesized
            ? t.callExpression(right.callee, [left, ...right.arguments])
            : t.callExpression(right, [left])
        return withLoc(result, node)
    },

    SlimBinaryExpression(node) {
        return withLoc(call("__intdiv__", [node.left, node.right]), node)
    },

    SlimTryExpression(node) {
        const frame = this.functions.at(-1)
        if (!frame) this.fail(node, `"?" can only be used inside a function`)
        frame.tries = true
        return withLoc(call("__try__", [node.argument]), node)
    },

    wrapTries(node) {
        if (node.body.type !== "BlockStatement") {
            node.body = t.blockStatement([t.returnStatement(node.body)])
            node.expression = false
        }
        const rethrow = clause => {
            if (!clause.param) clause.param = id("__slim_error__")
            if (clause.param.type !== "Identifier") {
                const original = clause.param
                clause.param = id("__slim_error__")
                clause.body.body.unshift(t.variableDeclaration("const", [t.variableDeclarator(original, id("__slim_error__"))]))
            }
            clause.body.body.unshift(t.expressionStatement(call("__try_rethrow__", [id(clause.param.name)])))
        }
        const visit = value => {
            if (Array.isArray(value)) return value.forEach(visit)
            if (!isNode(value) || FUNCTION_TYPES.has(value.type)) return
            if (value.type === "CatchClause") rethrow(value)
            for (const [key, child] of Object.entries(value)) if (!SKIP_KEYS.has(key)) visit(child)
        }
        visit(node.body.body)
        const handler = t.catchClause(id("__slim_try__"), t.blockStatement([t.returnStatement(call("__try_return__", [id("__slim_try__")]))]))
        node.body.body = [t.tryStatement(t.blockStatement(node.body.body), handler)]
    },

    SlimMarkup(node) {
        const texts = [...node.quasis]
        for (let index = 0; index < texts.length - 1; index++) {
            const quoted = /\son[A-Z][\w-]*\s*=\s*(["'])\s*$/.exec(texts[index])
            const closing = quoted && /^\s*(["'])/.exec(texts[index + 1])
            if (!closing || closing[1] !== quoted[1]) continue
            texts[index] = texts[index].slice(0, texts[index].lastIndexOf(quoted[1]))
            texts[index + 1] = texts[index + 1].slice(closing[0].length)
        }
        node.quasis = texts
        const quasis = node.quasis.map((text, index) => {
            return t.templateElement({ raw: escapeMarkupText(text), cooked: text }, index === node.quasis.length - 1)
        })
        const markup = t.taggedTemplateExpression(id("__html__"), t.templateLiteral(quasis, node.expressions))
        markup._slimMarkup = true
        markup._slimQuasis = node.quasis
        return withLoc(markup, node)
    }
}
