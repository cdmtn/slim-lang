import * as t from "@babel/types"
import { atoms, describe, isNamed, sourceText } from "../core.js"
import { indexOutOfRange, infer } from "../infer.js"

export function checkIndexRange(node, path_, env, report) {
    const found = indexOutOfRange(node, path_, env)
    if (!found) return
    const subject = sourceText(node.object) ?? "this value"
    const offset = t.isBinaryExpression(node.property) ? ` + ${[node.property.left, node.property.right].find(side => t.isNumericLiteral(side)).value}` : ""
    const shown = sourceText(node) ?? `${subject}[${subject}.length${offset}]`
    if (found.reason) report(node.property, `"${shown}" is always undefined: ${found.reason} — use ${subject}[${subject}.length - 1] or ${subject}.at(-1)`)
    else report(node.property, `"${shown}" is always undefined: ${subject} has ${found.length} ${found.text ? "characters" : found.length === 1 ? "element" : "elements"}`)
}

function loopCounter(node) {
    const declaration = node.init
    if (!t.isVariableDeclaration(declaration) || declaration.declarations.length !== 1) return null
    const { id, init } = declaration.declarations[0]
    if (!t.isIdentifier(id) || !t.isNumericLiteral(init) || init.value < 0) return null
    const update = node.update
    const increments = (t.isUpdateExpression(update, { operator: "++" }) && t.isIdentifier(update.argument, { name: id.name })) ||
        (t.isAssignmentExpression(update, { operator: "+=" }) && t.isIdentifier(update.left, { name: id.name }) && t.isNumericLiteral(update.right) && update.right.value > 0)
    return increments ? id.name : null
}

export function checkLoopBound(path_, report) {
    const { node } = path_
    const counter = loopCounter(node)
    const test = node.test
    if (!counter || !t.isBinaryExpression(test, { operator: "<=" }) || !t.isIdentifier(test.left, { name: counter })) return
    const bound = test.right
    if (!t.isMemberExpression(bound) || bound.computed || !t.isIdentifier(bound.property, { name: "length" })) return
    const binding = path_.scope.getBinding(counter)
    if (!binding || binding.constantViolations.some(violation => violation.node !== node.update && violation.parentPath?.node !== node.update)) return
    const array = sourceText(bound.object)
    if (!array) return
    let reported = false
    path_.get("body").traverse({
        Function(inner) { inner.skip() },
        MemberExpression(member) {
            const target = member.node
            if (reported || !target.computed || !t.isIdentifier(target.property, { name: counter }) || sourceText(target.object) !== array) return
            if (member.parentPath.isAssignmentExpression() && member.key === "left") return
            reported = true
            report(test, `"${counter} <= ${array}.length" goes one step too far: on the last pass ${array}[${counter}] is undefined — use "${counter} < ${array}.length"`)
        }
    })
}

export function checkRegExp(pattern, flags, node, report) {
    try {
        new RegExp(pattern, flags)
    } catch (error) {
        report(node, `invalid regular expression: ${String(error.message).replace(/^Invalid (regular expression|flags)[^:]*: /, "")} — the whole file would fail to load`)
    }
}

export function checkConditionAssignment(test, report) {
    if (!t.isAssignmentExpression(test, { operator: "=" }) || test.extra?.parenthesized) return
    report(test, `this assigns instead of comparing — write == to compare, or wrap it in extra parentheses if the assignment is meant`)
}

const isPromise = atom => (atom.kind === "generic" || atom.kind === "named") && atom.name === "Promise"

const ALWAYS_TRUTHY = atom => atom.kind === "array" || atom.kind === "tuple" || atom.kind === "function" ||
    (atom.kind === "named" && ["array", "function"].includes(atom.name)) || isPromise(atom)

export function checkAlwaysTruthy(test, path_, env, report, promisesOnly = false) {
    if (!test || t.isLiteral(test) || t.isObjectExpression(test) || t.isArrayExpression(test) || t.isFunction(test)) return
    const type = infer(test, path_, env)
    if (!type) return
    const all = atoms(type, env)
    if (all.length === 0 || !all.every(promisesOnly ? isPromise : ALWAYS_TRUTHY)) return
    const text = sourceText(test) ?? "this value"
    const hint = all.every(isPromise) ? ` — await it: await ${text}`
        : all.every(atom => atom.kind === "function" || isNamed(atom, "function")) ? ` — did you mean to call it: ${text}()?`
        : all.every(atom => atom.kind === "array" || atom.kind === "tuple" || isNamed(atom, "array")) ? ` — an empty array is truthy too: use ${text}.length > 0` : ""
    report(test, `"${text}" is ${describe(type)}, so this condition is always true${hint}`)
}

export function inTestPosition(path_) {
    for (let current = path_; current.parentPath; current = current.parentPath) {
        const parent = current.parentPath
        if (parent.isLogicalExpression() && parent.node.operator !== "??") continue
        if (parent.isUnaryExpression({ operator: "!" })) return true
        return current.key === "test" && (parent.isIfStatement() || parent.isWhileStatement() || parent.isDoWhileStatement() ||
            parent.isForStatement() || parent.isConditionalExpression())
    }
    return false
}

export function checkInstanceofPrimitive(node, path_, env, report) {
    if (node.operator !== "instanceof") return
    const type = infer(node.left, path_, env)
    if (!type) return
    const all = atoms(type, env)
    const primitive = atom => (atom.kind === "literal") || (atom.kind === "named" && ["int", "float", "number", "string", "bool", "null", "undefined", "bigint", "symbol"].includes(atom.name))
    if (!all.length || !all.every(primitive)) return
    report(node, `"${sourceText(node.left) ?? "this value"}" is ${describe(type)}, and a primitive is never an instance of anything, so this is always false — use typeof`)
}

export function checkNaNComparison(node, report) {
    if (!["==", "===", "!=", "!=="].includes(node.operator)) return
    if (![node.left, node.right].some(side => t.isIdentifier(side, { name: "NaN" }) || (t.isMemberExpression(side) && t.isIdentifier(side.object, { name: "Number" }) && t.isIdentifier(side.property, { name: "NaN" })))) return
    const other = t.isIdentifier(node.left, { name: "NaN" }) || t.isMemberExpression(node.left) ? node.right : node.left
    report(node, `NaN is not equal to anything, itself included, so this is always ${node.operator.startsWith("!") ? "true" : "false"} — use Number.isNaN(${sourceText(other) ?? "..."})`)
}

export function checkSelfAssignment(node, report) {
    if (node.operator !== "=" || !t.isIdentifier(node.left) || !t.isIdentifier(node.right, { name: node.left.name })) return
    report(node, `"${node.left.name}" is assigned to itself, which changes nothing`)
}

function propertyName(property) {
    if (!t.isObjectProperty(property) && !t.isObjectMethod(property)) return null
    if (property.computed) return t.isStringLiteral(property.key) || t.isNumericLiteral(property.key) ? String(property.key.value) : null
    if (t.isObjectMethod(property) && property.kind !== "method") return null
    return t.isIdentifier(property.key) ? property.key.name : t.isStringLiteral(property.key) || t.isNumericLiteral(property.key) ? String(property.key.value) : null
}

export function checkDuplicateKeys(path_, report) {
    const call = path_.parentPath
    const definition = call?.isCallExpression() && t.isIdentifier(call.node.callee) && path_.listKey === "arguments" && path_.key === 1 &&
        ["__def_struct__", "__def_enum__", "__def_trait__"].includes(call.node.callee.name) && t.isStringLiteral(call.node.arguments[0])
        ? { kind: call.node.callee.name === "__def_enum__" ? "member" : "field", name: call.node.arguments[0].value } : null
    const seen = new Set()
    for (const property of path_.node.properties) {
        let name = propertyName(property)
        if (name === null) continue
        if (definition?.kind === "field") name = name.replace(/^\*/, "").trim()
        if (seen.has(name)) {
            report(property, definition ? `"${definition.name}" has ${definition.kind} "${name}" twice` : `key "${name}" is written twice in this object — only the last one counts`)
        }
        seen.add(name)
    }
}

function caseKey(test) {
    if (t.isStringLiteral(test)) return `s:${test.value}`
    if (t.isNumericLiteral(test)) return `n:${test.value}`
    if (t.isBooleanLiteral(test)) return `b:${test.value}`
    if (t.isNullLiteral(test)) return "null"
    if (t.isUnaryExpression(test, { operator: "-" }) && t.isNumericLiteral(test.argument)) return `n:${-test.argument.value}`
    if (t.isMemberExpression(test) && !test.computed && t.isIdentifier(test.object) && t.isIdentifier(test.property)) return `m:${test.object.name}.${test.property.name}`
    return null
}

export function checkDuplicateCases(node, report) {
    const seen = new Set()
    for (const item of node.cases) {
        if (!item.test) continue
        const key = caseKey(item.test)
        if (key === null) continue
        if (seen.has(key)) report(item.test, `this case repeats an earlier one, so it never runs`)
        seen.add(key)
    }
}

export function checkIsolatedComponent(path_, env, report) {
    const { node } = path_
    if (!t.isIdentifier(node.callee, { name: "__isolated_body__" })) return
    const fn = path_.get("arguments.0")
    const name = node.arguments[1].value
    const reported = new Set()
    fn.traverse({
        Identifier(inner) {
            const id = inner.node.name
            if (!inner.isReferencedIdentifier() || reported.has(id)) return
            const binding = inner.scope.getBinding(id)
            const outside = binding ? binding.scope.path !== fn && !binding.scope.path.isDescendant(fn) : env.importedLocals.has(id)
            if (!outside) return
            reported.add(id)
            report(inner.node, `isolated component "${name}" can't see "${id}": it runs in its own scope — move it inside the component or pass it as a prop`)
        }
    })
}

function continuesLine(end, start, env) {
    return typeof end === "number" && typeof start === "number" && env.code.slice(end, start).includes("\n")
}

export function checkLineContinuation(node, path_, env, report) {
    if (t.isMemberExpression(node) && node.computed) {
        const bracket = env.code.indexOf("[", node.object.end)
        if (bracket !== -1 && bracket < node.property.start && continuesLine(node.object.end, bracket, env)) {
            report(node.property, `this line starts with "[", so it continues the line above as an index — put ; at the end of the line above`)
        }
    } else if (t.isCallExpression(node) && typeof node.callee.end === "number") {
        const paren = env.code.indexOf("(", node.callee.end)
        if (paren !== -1 && paren < node.end && continuesLine(node.callee.end, paren, env) && /^\s*\($/.test(env.code.slice(node.callee.end, paren + 1))) {
            report(node, `this line starts with "(", so it calls the value on the line above — put ; at the end of the line above`)
        }
    }
}
