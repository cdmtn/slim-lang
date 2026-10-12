import _traverse from "@babel/traverse"
import * as t from "@babel/types"
import { RESULT_TRY } from "./operatorSyntax.js"

const traverse = _traverse.default ?? _traverse
const clone = node => t.cloneNode(node, true)
const located = (node, source) => t.inherits(node, source)
const member = (object, name) => t.memberExpression(clone(object), t.identifier(name))
const assign = (left, right) => t.expressionStatement(t.assignmentExpression("=", clone(left), right))

export function isResultTry(node) {
    return t.isCallExpression(node) && t.isMemberExpression(node.callee) &&
        !node.callee.computed && t.isIdentifier(node.callee.property, { name: RESULT_TRY })
}

export function resultReturnType(fn) {
    if (!t.isBlockStatement(fn.body)) return null
    for (const statement of fn.body.body) {
        const call = statement.expression
        if (t.isCallExpression(call) && t.isIdentifier(call.callee, { name: "__declare_return__" }) &&
            t.isStringLiteral(call.arguments[0])) return call.arguments[0].value
    }
    return null
}

function isMatchClosure(node) {
    return t.isArrowFunctionExpression(node) && node.params.length === 1 &&
        t.isIdentifier(node.params[0], { name: "__match" }) && t.isBlockStatement(node.body)
}

function returnContext(path) {
    let fn = path.getFunctionParent()
    while (fn && isMatchClosure(fn.node)) fn = fn.getFunctionParent()
    return fn
}

export function lowerPipes(ast, isAwait, fail) {
    traverse(ast, {
        BinaryExpression: {
            exit(path) {
                const { node } = path
                if (node.operator !== "|>") return
                let target = node.right
                const awaiting = t.isAwaitExpression(target) ||
                    (t.isUnaryExpression(target, { operator: "void" }) && isAwait(target))
                if (awaiting) {
                    const fn = path.getFunctionParent()
                    if (fn && !fn.node.async) fail(target, "Pipe |> await requires an async function")
                    target = target.argument
                }
                const propagation = []
                while (isResultTry(target)) {
                    propagation.push(target)
                    target = target.callee.object
                }
                let call
                if (t.isCallExpression(target) || t.isOptionalCallExpression(target)) {
                    call = clone(target)
                    call.arguments.unshift(node.left)
                } else if (t.isIdentifier(target) || t.isMemberExpression(target) ||
                    t.isOptionalMemberExpression(target) || t.isFunctionExpression(target) ||
                    t.isArrowFunctionExpression(target)) {
                    call = t.isOptionalMemberExpression(target)
                        ? t.optionalCallExpression(target, [node.left], false)
                        : t.callExpression(target, [node.left])
                } else fail(target, "Right side of |> must be a function, method, or call expression")
                if (awaiting) call = t.awaitExpression(call)
                for (const marker of propagation.reverse()) {
                    marker.callee.object = call
                    call = marker
                }
                path.replaceWith(located(call, node))
            }
        }
    })
}

export function validateResultOperators(ast, fail) {
    traverse(ast, {
        CallExpression(path) {
            if (!isResultTry(path.node)) return
            const fn = returnContext(path)
            const label = fn ? resultReturnType(fn.node) : null
            if (!fn || (!fn.node.async && !/^Result(?:\s*<|$)/.test(label ?? ""))) {
                fail(path.node.callee.property, "Postfix ? requires a function returning Result<T, E> or an async function")
            }
            for (let parent = path; parent && parent !== fn; parent = parent.parentPath) {
                if (parent.listKey === "params") fail(path.node.callee.property, "Postfix ? cannot return from a parameter default; use it in the function body")
            }
        }
    })
}

function hasTry(node) {
    if (!node || (t.isFunction(node) && !isMatchClosure(node))) return false
    if (isResultTry(node)) return true
    return (t.VISITOR_KEYS[node.type] ?? []).some(key => {
        const child = node[key]
        return Array.isArray(child) ? child.some(hasTry) : hasTry(child)
    })
}

// Turn expressions containing ? into ordered statements in their own function.
// Captures preserve evaluation order, receiver bindings, and short-circuiting.
// No exception or generator participates in Err propagation.
export function lowerResultOperators(ast, fail) {
    traverse(ast, {
        Function: {
            exit(path) {
                if (isMatchClosure(path.node)) return
                if (!hasTry(path.node.body)) return
                path.ensureBlock()
                const uid = name => path.scope.generateUidIdentifier(name)
                const capture = (value, before, name = "resultValue") => {
                    const id = uid(name)
                    before.push(located(t.variableDeclaration("const", [t.variableDeclarator(clone(id), value)]), value))
                    return id
                }
                const read = (node, before) => {
                    const result = expression(node)
                    before.push(...result.before)
                    return capture(result.value, before)
                }
                const reference = (node, before) => {
                    if (t.isIdentifier(node) || t.isSuper(node)) return clone(node)
                    if (!t.isMemberExpression(node)) fail(node, "Unsupported assignment target containing ?")
                    const object = t.isSuper(node.object) ? clone(node.object) : read(node.object, before)
                    const property = node.computed ? read(node.property, before) : clone(node.property)
                    return located(t.memberExpression(object, property, node.computed), node)
                }
                const apply = (fn, receiver, args) => t.callExpression(
                    t.memberExpression(t.identifier("Reflect"), t.identifier("apply")),
                    [fn, receiver, t.arrayExpression(args)])

                function optional(node) {
                    const steps = []
                    let base = node
                    while (t.isOptionalMemberExpression(base) || t.isOptionalCallExpression(base) || t.isMemberExpression(base)) {
                        steps.unshift(base)
                        base = t.isOptionalCallExpression(base) ? base.callee : base.object
                    }
                    const before = []
                    let value = read(base, before)
                    const output = uid("optionalValue")
                    before.push(t.variableDeclaration("let", [t.variableDeclarator(clone(output))]))
                    let body = before
                    let receiver = t.unaryExpression("void", t.numericLiteral(0))
                    for (const step of steps) {
                        if (step.optional) {
                            const block = t.blockStatement([])
                            body.push(t.ifStatement(t.binaryExpression("!=", clone(value), t.nullLiteral()), block))
                            body = block.body
                        }
                        if (t.isOptionalCallExpression(step)) {
                            const args = argumentsList(step.arguments, body)
                            value = capture(apply(clone(value), clone(receiver), args), body)
                            receiver = t.unaryExpression("void", t.numericLiteral(0))
                        } else {
                            receiver = value
                            const property = step.computed ? read(step.property, body) : clone(step.property)
                            value = capture(located(t.memberExpression(clone(value), property, step.computed), step), body)
                        }
                    }
                    body.push(assign(output, clone(value)))
                    return { before, value: output }
                }

                function argumentsList(args, before) {
                    return args.map(arg => {
                        if (!t.isSpreadElement(arg)) return read(arg, before)
                        // Materialize a spread at its original evaluation point.
                        const spread = spreadValue(arg, before)
                        return t.spreadElement(spread)
                    })
                }

                function spreadValue(node, before) {
                    const value = read(node.argument, before)
                    return capture(t.arrayExpression([t.spreadElement(value)]), before)
                }

                function expression(node) {
                    if (!hasTry(node)) return { before: [], value: node }
                    const before = []
                    if (isResultTry(node)) {
                        const inner = expression(node.callee.object)
                        before.push(...inner.before)
                        const value = capture(located(t.callExpression(t.identifier("__result_expect__"), [inner.value]), node), before, "result")
                        before.push(located(t.ifStatement(t.callExpression(member(value, "isErr"), []),
                            t.returnStatement(clone(value))), node.callee.property))
                        return { before, value: located(member(value, "value"), node) }
                    }
                    if (t.isOptionalMemberExpression(node) || t.isOptionalCallExpression(node)) return optional(node)
                    if (t.isLogicalExpression(node) || t.isConditionalExpression(node)) {
                        const test = read(t.isLogicalExpression(node) ? node.left : node.test, before)
                        const output = uid("branchValue")
                        before.push(t.variableDeclaration("let", [t.variableDeclarator(clone(output),
                            t.isLogicalExpression(node) ? clone(test) : null)]))
                        const branch = value => {
                            const result = expression(value)
                            return t.blockStatement([...result.before, assign(output, result.value)])
                        }
                        if (t.isConditionalExpression(node)) before.push(t.ifStatement(test, branch(node.consequent), branch(node.alternate)))
                        else {
                            const condition = node.operator === "&&" ? test : node.operator === "||"
                                ? t.unaryExpression("!", test) : t.binaryExpression("==", test, t.nullLiteral())
                            before.push(t.ifStatement(condition, branch(node.right)))
                        }
                        return { before, value: output }
                    }
                    if (t.isAssignmentExpression(node)) {
                        const left = reference(node.left, before)
                        if (["&&=", "||=", "??="].includes(node.operator)) {
                            const result = expression(t.logicalExpression(node.operator.slice(0, -1), clone(left),
                                t.assignmentExpression("=", clone(left), node.right)))
                            return { before: [...before, ...result.before], value: result.value }
                        }
                        const previous = node.operator === "=" ? null : capture(clone(left), before)
                        const right = read(node.right, before)
                        return { before, value: located(t.assignmentExpression("=", left, previous
                            ? t.binaryExpression(node.operator.slice(0, -1), previous, right) : right), node) }
                    }
                    if (t.isCallExpression(node) || t.isNewExpression(node) || t.isTaggedTemplateExpression(node)) {
                        const target = t.isTaggedTemplateExpression(node) ? node.tag : node.callee
                        if (isMatchClosure(target)) {
                            const input = read(node.arguments[0], before)
                            const output = uid("matchValue")
                            const label = uid("matchBody")
                            before.push(t.variableDeclaration("let", [t.variableDeclarator(clone(output))]))
                            // Rewrite the synthetic closure's returns before
                            // lowering ?. Its generated Err returns belong to
                            // the enclosing user function.
                            function rewriteReturns(statement) {
                                if (!statement || t.isFunction(statement)) return statement
                                if (t.isReturnStatement(statement)) return t.blockStatement([
                                    assign(output, statement.argument ?? t.unaryExpression("void", t.numericLiteral(0))),
                                    t.breakStatement(clone(label))])
                                for (const key of t.VISITOR_KEYS[statement.type] ?? []) {
                                    if (Array.isArray(statement[key])) statement[key] = statement[key].map(rewriteReturns)
                                    else if (statement[key]?.type) statement[key] = rewriteReturns(statement[key])
                                }
                                return statement
                            }
                            const body = rewriteReturns(clone(target.body))
                            body.body.unshift(t.variableDeclaration("const", [t.variableDeclarator(t.identifier("__match"), input)]))
                            before.push(t.labeledStatement(label, block(body)))
                            return { before, value: output }
                        }
                        if (t.isIdentifier(target) && target.name.startsWith("__typed_")) {
                            // Preserve compiler contracts for the later runtime
                            // instrumentation pass (including binding slots).
                            const result = expression(node.arguments[0])
                            node.arguments[0] = result.value
                            return { before: result.before, value: node }
                        }
                        let receiver = t.unaryExpression("void", t.numericLiteral(0))
                        let fn
                        if (t.isMemberExpression(target)) {
                            const ref = reference(target, before)
                            receiver = t.isSuper(ref.object) ? t.thisExpression() : clone(ref.object)
                            fn = capture(ref, before, "resultFunction")
                        } else if (t.isSuper(target) || t.isImport(target)) fn = clone(target)
                        else fn = read(target, before)
                        if (t.isTaggedTemplateExpression(node)) {
                            // A tag must receive the native template object and its receiver.
                            const tag = t.callExpression(t.memberExpression(fn, t.identifier("bind")), [receiver])
                            const quasi = clone(node.quasi)
                            quasi.expressions = quasi.expressions.map(value => read(value, before))
                            return { before, value: located(t.taggedTemplateExpression(tag, quasi), node) }
                        }
                        const args = argumentsList(node.arguments, before)
                        const value = t.isNewExpression(node) ? t.newExpression(fn, args)
                            : t.isSuper(target) || t.isImport(target) ? t.callExpression(fn, args)
                                : apply(fn, receiver, args)
                        if (t.isIdentifier(target, { name: "eval" })) fail(node, "Postfix ? in direct eval arguments is unsupported; evaluate the Result first")
                        return { before, value: located(value, node) }
                    }
                    if (t.isSequenceExpression(node)) {
                        node.expressions.forEach((item, i) => {
                            if (i < node.expressions.length - 1) {
                                const result = expression(item)
                                before.push(...result.before, t.expressionStatement(result.value))
                            }
                        })
                        const last = expression(node.expressions.at(-1))
                        return { before: [...before, ...last.before], value: last.value }
                    }
                    const value = clone(node)
                    if (t.isBinaryExpression(node)) {
                        value.left = read(node.left, before)
                        value.right = read(node.right, before)
                    } else if (t.isMemberExpression(node)) {
                        value.object = read(node.object, before)
                        if (node.computed) value.property = read(node.property, before)
                    } else if (t.isUnaryExpression(node) || t.isAwaitExpression(node) || t.isYieldExpression(node) || t.isSpreadElement(node)) {
                        // delete requires a reference, rather than its current value.
                        value.argument = node.operator === "delete" ? reference(node.argument, before) : read(node.argument, before)
                    } else if (t.isUpdateExpression(node)) value.argument = reference(node.argument, before)
                    else if (t.isArrayExpression(node)) value.elements = node.elements.map(item => item
                        ? t.isSpreadElement(item) ? t.spreadElement(spreadValue(item, before)) : read(item, before) : null)
                    else if (t.isObjectExpression(node)) value.properties = node.properties.map(property => {
                        if (t.isSpreadElement(property)) return t.spreadElement(capture(t.objectExpression([
                            t.spreadElement(read(property.argument, before))]), before))
                        const prop = clone(property)
                        if (prop.computed) prop.key = read(property.key, before)
                        if (t.isObjectProperty(prop)) { prop.value = read(property.value, before); prop.shorthand = false }
                        return prop
                    })
                    else if (t.isTemplateLiteral(node)) value.expressions = node.expressions.map(item => read(item, before))
                    else fail(node, `Postfix ? is unsupported in ${node.type}; evaluate the Result in a local variable first`)
                    return { before, value }
                }

                function block(statement) { return t.blockStatement(statements(statement)) }
                function list(body) { return body.flatMap(statements) }

                function continueAsBreak(body, label) {
                    // Continue statements targeting this loop must still run its
                    // lifted update/test. Nested loops own their continues.
                    function rewrite(node, nested = false) {
                        if (!node || t.isFunction(node)) return node
                        if (t.isContinueStatement(node) && !nested && !node.label) return located(t.breakStatement(clone(label)), node)
                        const inside = nested || t.isLoop(node)
                        for (const key of t.VISITOR_KEYS[node.type] ?? []) {
                            if (Array.isArray(node[key])) node[key] = node[key].map(child => rewrite(child, inside))
                            else if (node[key]?.type) node[key] = rewrite(node[key], inside)
                        }
                        return node
                    }
                    return rewrite(body)
                }

                function statements(node) {
                    if (!node || t.isFunction(node) || !hasTry(node)) return [node]
                    if (t.isBlockStatement(node)) { node.body = list(node.body); return [node] }
                    if (t.isVariableDeclaration(node)) return node.declarations.flatMap(declaration => {
                        if (hasTry(declaration.id)) fail(declaration.id, "Postfix ? in a destructuring default is unsupported; evaluate the Result first")
                        const result = expression(declaration.init)
                        declaration.init = result.value
                        return [...result.before, located(t.variableDeclaration(node.kind, [declaration]), node)]
                    })
                    if (t.isReturnStatement(node) || t.isThrowStatement(node) || t.isExpressionStatement(node)) {
                        const key = t.isExpressionStatement(node) ? "expression" : "argument"
                        const result = expression(node[key])
                        node[key] = result.value
                        return [...result.before, node]
                    }
                    if (t.isIfStatement(node)) {
                        const test = expression(node.test)
                        node.test = test.value
                        node.consequent = block(node.consequent)
                        if (node.alternate) node.alternate = block(node.alternate)
                        return [...test.before, node]
                    }
                    if (t.isWhileStatement(node)) {
                        const test = expression(node.test)
                        const body = statements(node.body)
                        node.test = test.before.length ? t.booleanLiteral(true) : test.value
                        node.body = t.blockStatement(test.before.length ? [...test.before,
                            t.ifStatement(t.unaryExpression("!", test.value), t.breakStatement()), ...body] : body)
                        return [node]
                    }
                    if (t.isDoWhileStatement(node)) {
                        const test = expression(node.test)
                        node.body = block(node.body)
                        if (!test.before.length) { node.test = test.value; return [node] }
                        const label = uid("loopBody")
                        return [located(t.whileStatement(t.booleanLiteral(true), t.blockStatement([
                            t.labeledStatement(clone(label), continueAsBreak(node.body, label)), ...test.before,
                            t.ifStatement(t.unaryExpression("!", test.value), t.breakStatement())])), node)]
                    }
                    if (t.isForStatement(node)) {
                        if (![node.init, node.test, node.update].some(hasTry)) {
                            node.body = block(node.body)
                            return [node]
                        }
                        if (!hasTry(node.init) && !hasTry(node.update)) {
                            const test = expression(node.test)
                            node.test = null
                            node.body = t.blockStatement([...test.before,
                                ...(test.value ? [t.ifStatement(t.unaryExpression("!", test.value), t.breakStatement())] : []),
                                block(node.body)])
                            return [node]
                        }
                        const init = t.isVariableDeclaration(node.init) ? statements(node.init) : (() => {
                            const value = expression(node.init)
                            return [...value.before, ...(value.value ? [t.expressionStatement(value.value)] : [])]
                        })()
                        const test = expression(node.test)
                        const update = expression(node.update)
                        const body = block(node.body)
                        const label = uid("loopBody")
                        node.init = null
                        node.test = null
                        node.update = update.before.length ? null : update.value
                        node.body = t.blockStatement([...test.before,
                            ...(test.value ? [t.ifStatement(t.unaryExpression("!", test.value), t.breakStatement())] : []),
                            update.before.length ? t.labeledStatement(clone(label), continueAsBreak(body, label)) : body,
                            ...update.before, ...(update.before.length ? [t.expressionStatement(update.value)] : [])])
                        return [t.blockStatement([...init, node])]
                    }
                    if (t.isForOfStatement(node) || t.isForInStatement(node)) {
                        const right = expression(node.right)
                        if (hasTry(node.left)) fail(node.left, "Postfix ? in a loop binding is unsupported; evaluate the Result first")
                        node.right = right.value
                        node.body = block(node.body)
                        return [...right.before, node]
                    }
                    if (t.isSwitchStatement(node)) {
                        const before = []
                        const value = read(node.discriminant, before)
                        const index = uid("caseIndex")
                        before.push(t.variableDeclaration("let", [t.variableDeclarator(clone(index), t.numericLiteral(-1))]))
                        let fallback = -1
                        node.cases.forEach((arm, i) => {
                            if (arm.test) {
                                const test = expression(arm.test)
                                before.push(t.ifStatement(t.binaryExpression("===", clone(index), t.numericLiteral(-1)),
                                    t.blockStatement([...test.before, t.ifStatement(t.binaryExpression("===", clone(value), test.value),
                                        t.blockStatement([assign(index, t.numericLiteral(i))]))])))
                            } else fallback = i
                            arm.test = t.numericLiteral(i)
                            arm.consequent = list(arm.consequent)
                        })
                        if (fallback >= 0) before.push(t.ifStatement(t.binaryExpression("===", clone(index), t.numericLiteral(-1)),
                            t.blockStatement([assign(index, t.numericLiteral(fallback))])))
                        node.discriminant = index
                        return [...before, node]
                    }
                    if (t.isTryStatement(node)) {
                        node.block = block(node.block)
                        if (node.handler) node.handler.body = block(node.handler.body)
                        if (node.finalizer) node.finalizer = block(node.finalizer)
                        return [node]
                    }
                    if (t.isLabeledStatement(node)) {
                        if (t.isLoop(node.body) && hasTry(node.body)) fail(node, "Postfix ? in a labeled loop is unsupported; use an unlabeled loop")
                        node.body = block(node.body)
                        return [node]
                    }
                    fail(node, `Postfix ? is unsupported in ${node.type}; evaluate the Result in a local variable first`)
                }
                path.node.body.body = list(path.node.body.body)
                path.scope.crawl()
            }
        }
    })
}
