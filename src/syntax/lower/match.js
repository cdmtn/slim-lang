import * as t from "@babel/types"
import { STRUCTURAL_PATTERNS, call, id, keyName, replaceArguments, str, suspends, withLoc } from "./helpers.js"

export const matchLowering = {
    SlimMatchExpression(node) {
        const statements = []
        let fallback = t.returnStatement(id("undefined"))

        for (const arm of node.arms) {
            if (arm.typeAnnotation) {
                const label = this.label(arm.typeAnnotation)
                const declarator = t.variableDeclarator(withLoc(id(arm.binding.name), arm.binding), id("__match"))
                declarator._slimType = label
                const result = t.returnStatement(arm.result)
                const body = [t.variableDeclaration("const", [declarator]), arm.guard ? t.ifStatement(arm.guard, result) : result]
                statements.push(t.ifStatement(call("__match_type__", [id("__match"), str(label)]), t.blockStatement(body)))
            } else if (arm.pattern && STRUCTURAL_PATTERNS.has(arm.pattern.type)) {
                const tests = []
                const body = []
                this.matchPattern(arm.pattern, id("__match"), tests, body)
                const result = t.returnStatement(arm.result)
                body.push(arm.guard ? t.ifStatement(arm.guard, result) : result)
                const test = tests.reduce((all, part) => all ? t.logicalExpression("&&", all, part) : part, null)
                statements.push(test ? t.ifStatement(test, t.blockStatement(body)) : t.blockStatement(body))
            } else if (arm.guard) {
                const body = []
                if (arm.binding) body.push(t.variableDeclaration("const", [t.variableDeclarator(id(arm.binding.name), id("__match"))]))
                body.push(t.ifStatement(arm.guard, t.returnStatement(arm.result)))
                statements.push(t.blockStatement(body))
            } else if (arm.wildcard) {
                fallback = t.returnStatement(arm.result)
            } else {
                statements.push(t.ifStatement(call("__match_eq__", [id("__match"), arm.pattern]), t.returnStatement(arm.result)))
            }
        }

        const body = t.blockStatement([...statements, fallback])
        const awaits = suspends(body, "AwaitExpression")
        if (suspends(body, "YieldExpression")) {
            const params = [id("__match")]
            const args = [t.thisExpression(), node.discriminant]
            if (replaceArguments(body)) {
                params.push(id("__match_arguments"))
                args.push(id("arguments"))
            }
            const fn = t.functionExpression(null, params, body, true, awaits)
            const run = t.callExpression(t.memberExpression(fn, id("call")), args)
            return withLoc(t.yieldExpression(run, true), node)
        }
        const fn = t.arrowFunctionExpression([id("__match")], body, awaits)
        const run = withLoc(t.callExpression(fn, [node.discriminant]), node)
        return awaits ? withLoc(t.awaitExpression(run), node) : run
    },

    matchPattern(pattern, subject, tests, bindings) {
        const bind = (name, value) => bindings.push(t.variableDeclaration("const", [t.variableDeclarator(withLoc(id(name.name), name), value)]))

        switch (pattern.type) {
            case "Identifier":
                if (pattern.name === "undefined") tests.push(call("__match_eq__", [subject, pattern]))
                else if (pattern.name !== "_") bind(pattern, subject)
                return
            case "StringLiteral":
            case "NumericLiteral":
            case "BooleanLiteral":
            case "NullLiteral":
            case "MemberExpression":
                tests.push(call("__match_eq__", [subject, pattern]))
                return
            case "UnaryExpression":
                if (pattern.operator === "-" && pattern.argument.type === "NumericLiteral") {
                    tests.push(call("__match_eq__", [subject, pattern]))
                    return
                }
                break
            case "TemplateLiteral":
                if (pattern.expressions.length === 0) {
                    tests.push(call("__match_eq__", [subject, pattern]))
                    return
                }
                break
            case "ObjectExpression": {
                tests.push(t.logicalExpression("&&",
                    t.binaryExpression("===", t.unaryExpression("typeof", subject), str("object")),
                    t.binaryExpression("!==", t.cloneNode(subject), t.nullLiteral())))
                const keys = []
                for (const property of pattern.properties) {
                    if (property.type === "SpreadElement") {
                        if (property !== pattern.properties.at(-1) || property.argument.type !== "Identifier") {
                            this.fail(property, `"...rest" has to be a name at the end of the pattern`)
                        }
                        bind(property.argument, call("__match_rest__", [t.cloneNode(subject), t.arrayExpression(keys.map(str))]))
                        continue
                    }
                    const key = property.type === "ObjectProperty" && !property.computed ? keyName(property.key) : null
                    if (key === null) this.fail(property, "a pattern field needs a plain name: { name } or { name: pattern }")
                    keys.push(key)
                    const accessor = t.isValidIdentifier(key) ? withLoc(id(key), property.key) : str(key)
                    const value = withLoc(t.memberExpression(t.cloneNode(subject), accessor, !t.isValidIdentifier(key)), property)
                    this.matchPattern(property.value, value, tests, bindings)
                }
                return
            }
            case "ArrayExpression": {
                const elements = pattern.elements
                const rest = elements.at(-1)?.type === "SpreadElement"
                const fixed = rest ? elements.length - 1 : elements.length
                tests.push(t.logicalExpression("&&",
                    t.callExpression(t.memberExpression(id("Array"), id("isArray")), [subject]),
                    t.binaryExpression(rest ? ">=" : "===", t.memberExpression(t.cloneNode(subject), id("length")), t.numericLiteral(fixed))))
                elements.forEach((element, index) => {
                    if (!element) return
                    if (element.type === "SpreadElement") {
                        if (index !== elements.length - 1 || element.argument.type !== "Identifier") {
                            this.fail(element, `"...rest" has to be a name at the end of the pattern`)
                        }
                        bind(element.argument, t.callExpression(t.memberExpression(t.cloneNode(subject), id("slice")), [t.numericLiteral(index)]))
                        return
                    }
                    this.matchPattern(element, t.memberExpression(t.cloneNode(subject), t.numericLiteral(index), true), tests, bindings)
                })
                return
            }
            case "CallExpression": {
                if (pattern.callee.type !== "MemberExpression" && pattern.callee.type !== "Identifier") break
                tests.push(call("__variant_is__", [subject, pattern.callee]))
                pattern.arguments.forEach((argument, index) => {
                    if (argument.type === "SpreadElement") this.fail(argument, "a variant pattern takes one pattern per field")
                    const value = withLoc(call("__variant_value__", [t.cloneNode(subject), t.cloneNode(pattern.callee), t.numericLiteral(index)]), argument)
                    this.matchPattern(argument, value, tests, bindings)
                })
                return
            }
        }
        this.fail(pattern, "this can't be a match pattern: use a literal, a name, an enum member, {...}, [...] or Enum.Variant(...)")
    }
}
