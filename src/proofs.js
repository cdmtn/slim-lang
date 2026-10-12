// Static elimination of runtime type checks.
//
// The checker (checker.js) is deliberately permissive: `accepts` answers "true" whenever it
// cannot tell. That is right for diagnostics and wrong for removing a runtime guard, so this
// module has its own, much smaller notion of *proof*:
//
//   a check is removed only when the value is built from literals, operators with a fixed
//   result type, variables/parameters whose own checks guarantee their declared type, or
//   calls of functions whose `-> T` is guaranteed on every path -- and the type involved is
//   one of the primitives below. Anything else keeps its check.
//
// Every decision, kept or removed, is recorded so `slmc build --explain-checks` can list it.

import _traverse from "@babel/traverse"
import * as t from "@babel/types"

const traverse = _traverse.default ?? _traverse

// Types whose runtime representation is a JS primitive: guardTypedValue() is a no-op for
// them, so dropping the check cannot change observable behaviour.
const PRIMITIVES = new Set(["int", "float", "number", "string", "bool", "null", "undefined"])
const NUMERIC = new Set(["int", "float", "number"])

function splitTop(label) {
    const parts = []
    let depth = 0
    let current = ""
    for (const char of label) {
        if (char === "<" || char === "[" || char === "(") depth++
        else if (char === ">" || char === "]" || char === ")") depth--
        else if (char === "|" && depth === 0) { parts.push(current.trim()); current = ""; continue }
        current += char
    }
    if (current.trim()) parts.push(current.trim())
    return parts
}

function atomsOf(label) {
    const trimmed = label.trim()
    const expanded = trimmed.endsWith("?")
        ? `${trimmed.slice(0, -1).trim()} | null | undefined`
        : trimmed
    if (expanded.includes("&") && !expanded.includes("|")) return null
    return splitTop(expanded)
}

function strictlyMatches(target, source) {
    if (target === source) return PRIMITIVES.has(source)
    return target === "number" && (source === "int" || source === "float")
}

// True only if every value of `source` is certain to pass the runtime check for `target`.
export function provenAccepts(target, source) {
    if (!target || !source) return false

    const targets = atomsOf(target)
    const sources = atomsOf(source)
    if (!targets || !sources || sources.length === 0) return false

    return sources.every(atom => PRIMITIVES.has(atom) && targets.some(other => strictlyMatches(other, atom)))
}

function isPrimitiveLabel(label) {
    const atoms = atomsOf(label)
    return !!atoms && atoms.length > 0 && atoms.every(atom => PRIMITIVES.has(atom))
}

function unionLabel(a, b) {
    const atoms = [...new Set([...atomsOf(a), ...atomsOf(b)])]
    return atoms.join(" | ")
}

// The write sites transform.js instruments: `x = v`, `x += v`, `x++`. Anything else
// (destructuring assignment, for-of targets) writes without a check, so a binding that sees
// one of them cannot be trusted to hold its declared type.
function onlyInstrumentedWrites(binding) {
    return binding.constantViolations.every(violation =>
        (violation.isAssignmentExpression() && t.isIdentifier(violation.node.left)) ||
        violation.isUpdateExpression()
    )
}

function trustedBindingLabel(name, path_, env) {
    const binding = path_.scope.getBinding(name)
    if (!binding || binding.kind === "var") return null

    // Parameter defaults execute before the body and its parameter guards.
    for (let parent = path_; parent; parent = parent.parentPath) {
        if (parent.listKey === "params") return null
    }
    const label = env.provenBindings.get(binding)
    if (!label || !onlyInstrumentedWrites(binding)) return null
    return label
}

// -> { label, proof } when the value of `node` provably has `label`; null otherwise.
export function prove(node, path_, env) {
    if (!node) return null

    if (t.isNumericLiteral(node)) {
        return Number.isInteger(node.value)
            ? { label: "int", proof: `int literal ${node.value}` }
            : { label: "float", proof: `float literal ${node.value}` }
    }
    if (t.isStringLiteral(node)) return { label: "string", proof: "string literal" }
    if (t.isTemplateLiteral(node)) return { label: "string", proof: "template literal" }
    if (t.isBooleanLiteral(node)) return { label: "bool", proof: `bool literal ${node.value}` }
    if (t.isNullLiteral(node)) return { label: "null", proof: "null literal" }

    if (t.isIdentifier(node)) {
        if (node.name === "undefined" && !path_.scope.getBinding("undefined")) {
            return { label: "undefined", proof: "undefined literal" }
        }
        const label = trustedBindingLabel(node.name, path_, env)
        return label ? { label, proof: `"${node.name}" is a checked ${label} binding` } : null
    }

    if (t.isUnaryExpression(node)) {
        if (node.operator === "!") return { label: "bool", proof: "negation" }
        if (node.operator === "typeof") return { label: "string", proof: "typeof" }
        if (node.operator === "-" || node.operator === "+") {
            const operand = prove(node.argument, path_, env)
            if (operand && NUMERIC.has(operand.label)) {
                return { label: operand.label, proof: `unary ${node.operator} of ${operand.label}` }
            }
        }
        return null
    }

    if (t.isBinaryExpression(node)) {
        const operator = node.operator
        if (["==", "!=", "===", "!==", "<", ">", "<=", ">=", "instanceof", "in"].includes(operator)) {
            return { label: "bool", proof: `comparison ${operator}` }
        }

        if (!["+", "-", "*", "/", "%", "**"].includes(operator)) return null
        const left = prove(node.left, path_, env)
        const right = prove(node.right, path_, env)

        if (operator === "+" && (left?.label === "string" || right?.label === "string")) {
            return { label: "string", proof: "string concatenation" }
        }
        // int + int may overflow to Infinity, which the runtime classifies as float, so
        // arithmetic is only ever proven to be a `number`.
        if (left && right && NUMERIC.has(left.label) && NUMERIC.has(right.label)) {
            return { label: "number", proof: `numeric ${operator}` }
        }
        return null
    }

    if (t.isConditionalExpression(node)) {
        const yes = prove(node.consequent, path_, env)
        const no = prove(node.alternate, path_, env)
        if (!yes || !no) return null
        return { label: unionLabel(yes.label, no.label), proof: `both branches are proven (${yes.label}, ${no.label})` }
    }

    if (t.isCallExpression(node) && t.isIdentifier(node.callee)) {
        const binding = path_.scope.getBinding(node.callee.name)
        // Wildcard imports are assigned to mutable globalThis properties; they are not
        // stable callees. Named imports are conservatively kept as well.
        const signature = binding ? env.functions.get(binding) : null

        if (signature?.returns && signature.soundReturn) {
            return { label: signature.returns, proof: `call of "${node.callee.name}" declared -> ${signature.returns}` }
        }
    }

    return null
}

// Why a value could not be proven, for --explain-checks.
export function unprovenReason(node, path_, env) {
    if (!node) return "no value"
    if (t.isCallExpression(node)) {
        if (t.isMemberExpression(node.callee)) {
            const text = t.isIdentifier(node.callee.object) && t.isIdentifier(node.callee.property)
                ? `${node.callee.object.name}.${node.callee.property.name}`
                : "a method"
            return `value comes from ${text}(), which is not statically typed`
        }
        if (t.isIdentifier(node.callee)) {
            const binding = path_.scope.getBinding(node.callee.name)
            const signature = binding ? env.functions.get(binding) : env.importedFunctions.get(node.callee.name)
            if (!signature) return `"${node.callee.name}" is not a typed Slim function`
            if (!signature.returns) return `"${node.callee.name}" has no declared return type`
            return `"${node.callee.name}" may not return on every path, is async, or is reassigned`
        }
        return "call result is not statically typed"
    }
    if (t.isIdentifier(node)) {
        const binding = path_.scope.getBinding(node.name)
        if (!binding) return `"${node.name}" is not a local binding (global or import)`
        if (!env.provenBindings.has(binding)) return `"${node.name}" has no declared type`
        return `"${node.name}" is written by a construct that is not type-checked`
    }
    if (t.isMemberExpression(node)) return "member access is not statically typed"
    if (t.isAwaitExpression(node)) return "awaited value is not statically typed"
    if (t.isObjectExpression(node) || t.isArrayExpression(node)) return "object and array values are always checked"
    return `${node.type} is not a provable expression`
}

function exportedLocals(ast) {
    const names = new Set()
    traverse(ast, {
        ExportNamedDeclaration(path_) {
            const declaration = path_.node.declaration
            if (t.isVariableDeclaration(declaration)) {
                for (const declarator of declaration.declarations) {
                    if (t.isIdentifier(declarator.id)) names.add(declarator.id.name)
                }
            } else if ((t.isFunctionDeclaration(declaration) || t.isClassDeclaration(declaration)) && declaration.id) {
                names.add(declaration.id.name)
            }
            for (const specifier of path_.node.specifiers ?? []) {
                if (t.isExportSpecifier(specifier)) names.add(specifier.local.name)
            }
        },
        ExportDefaultDeclaration(path_) {
            const declaration = path_.node.declaration
            if (t.isIdentifier(declaration)) names.add(declaration.name)
            else if ((t.isFunctionDeclaration(declaration)) && declaration.id) names.add(declaration.id.name)
        }
    })
    return names
}

function typedParameterCalls(fn) {
    const calls = []
    if (!t.isBlockStatement(fn.body)) return calls

    for (const statement of fn.body.body) {
        if (!t.isExpressionStatement(statement)) continue
        const call = statement.expression
        if (t.isCallExpression(call) && t.isIdentifier(call.callee, { name: "__typed_parameter__" })) calls.push(call)
    }
    return calls
}

// Parameter checks may go only when every use of the function is a direct call in this
// module that passes a proven value: the function is not exported, not reassigned, never
// escapes as a value (callback, property, export specifier), and uses no spread arguments.
function analyzeParameters(ast, env, record) {
    const exported = exportedLocals(ast)

    for (const [binding, definition] of env.fnDefs) {
        const fnPath = definition.path
        const calls = typedParameterCalls(fnPath.node)
        if (calls.length === 0) continue

        const name = binding.identifier.name
        const sites = []
        let why = null

        if (exported.has(name)) why = "function is exported"
        else if (t.isFunctionExpression(fnPath.node) && fnPath.node.id) why = "named function expression has a separate self binding"
        else if (!binding.constant) why = "function binding is reassigned"
        else if (binding.referencePaths.length === 0) why = "function is never called in this module"
        else {
            for (const reference of binding.referencePaths) {
                const parent = reference.parentPath
                if (!parent?.isCallExpression() || parent.node.callee !== reference.node) {
                    why = "function is used as a value (callback, property or export)"
                    break
                }
                if (parent.node.arguments.some(argument => t.isSpreadElement(argument))) {
                    why = "a call uses spread arguments"
                    break
                }
                sites.push(parent)
            }
        }

        const parameters = fnPath.node.params.map(param =>
            t.isAssignmentPattern(param) ? param.left : param)

        for (const call of calls) {
            const [value, label, , optional] = call.arguments
            if (!t.isIdentifier(value) || !t.isStringLiteral(label)) continue

            const index = parameters.findIndex(param => t.isIdentifier(param, { name: value.name }))
            const isOptional = t.isBooleanLiteral(optional) && optional.value
            const parameterBinding = fnPath.scope.getBinding(value.name)
            const subject = `parameter "${value.name}" of "${name}"`

            let reason = why
            let proof = null

            if (!reason && !isPrimitiveLabel(label.value)) reason = `type ${label.value} is not a primitive`
            if (!reason && (!parameterBinding || !parameterBinding.constant)) reason = "parameter is reassigned inside the function"
            if (!reason && index === -1) reason = "parameter shape is not a plain identifier"
            if (!reason && fnPath.node.params.some(param => t.isAssignmentPattern(param))) {
                reason = "parameter defaults execute before parameter checks"
            }

            if (!reason) {
                const proofs = []
                for (const site of sites) {
                    const argument = site.node.arguments[index]
                    if (!argument) {
                        if (isOptional) { proofs.push("omitted optional argument"); continue }
                        reason = "a call omits this argument"
                        break
                    }
                    const proven = prove(argument, site, env)
                    if (!proven || !provenAccepts(label.value, proven.label)) {
                        reason = proven
                            ? `a call passes ${proven.label}, which does not satisfy ${label.value}`
                            : `a call passes an unproven value (${unprovenReason(argument, site, env)})`
                        break
                    }
                    proofs.push(proven.proof)
                }
                if (!reason) proof = `all ${sites.length} call(s) in this module pass proven values (${[...new Set(proofs)].join("; ")})`
            }

            record({
                kind: "parameter",
                name: subject,
                label: label.value,
                node: call,
                removed: !reason,
                reason: reason ?? proof,
                apply: () => { call._slimElide = true }
            })
        }
    }
}

// Decide every instrumented check in the module. Mutates the AST only through `_slimElide`
// / `_slimProven` flags that transform.js consults; the checks themselves are untouched.
export function analyzeChecks(ast, env, { locate, elide = true }) {
    const decisions = []
    let dynamicScope = false
    traverse(ast, { CallExpression(p) {
        if (t.isIdentifier(p.node.callee, { name: "eval" })) dynamicScope = true
    } })
    const shadowedPrimitive = [...env.customTypes, ...env.structs.keys(), ...env.enums.keys()].some(name => PRIMITIVES.has(name))
    if (dynamicScope || shadowedPrimitive) elide = false

    const reported = new WeakSet()
    const record = ({ kind, name, label, node, removed, reason, apply }) => {
        reported.add(node)
        const at = locate(node)
        decisions.push({
            kind,
            name,
            type: label,
            status: removed && elide ? "removed" : "kept",
            line: at.line,
            column: at.column,
            reason: dynamicScope ? "direct eval prevents static proof" : shadowedPrimitive ? "a primitive type is redefined by this module or its imports" : !elide && removed ? "elision disabled: " + reason : reason
        })
        if (removed && elide) apply?.()
    }

    analyzeParameters(ast, env, record)

    // Writes to checked bindings. A declaration check may only be dropped once every later
    // write is proven too, because the declaration is what registers the binding's type.
    const writesProven = new Map()
    const noteWrite = (binding, ok) => {
        writesProven.set(binding, (writesProven.get(binding) ?? true) && ok)
    }

    traverse(ast, {
        AssignmentExpression(path_) {
            const { node } = path_
            if (!t.isIdentifier(node.left)) return
            const binding = path_.scope.getBinding(node.left.name)
            const typed = binding ? env.runtimeTyped.get(binding) : null
            if (!typed) return

            const name = node.left.name
            if (node.operator !== "=") {
                noteWrite(binding, false)
                record({ kind: "assignment", name: `"${name}" ${node.operator}`, label: typed.label, node: node.left,
                    removed: false, reason: "compound assignment is always checked" })
                return
            }

            const proven = prove(node.right, path_, env)
            const stable = binding.kind !== "var" && onlyInstrumentedWrites(binding)
            const ok = stable && !!proven && isPrimitiveLabel(typed.label) && provenAccepts(typed.label, proven.label)
            noteWrite(binding, ok)
            record({
                kind: "assignment",
                name: `"${name}"`,
                label: typed.label,
                node: node.left,
                removed: ok,
                reason: ok ? proven.proof
                    : !stable ? "binding may be redeclared or written without a check"
                    : proven ? `${proven.label} is not proven to satisfy ${typed.label}`
                        : unprovenReason(node.right, path_, env),
                apply: () => { node._slimProven = true }
            })
        },

        UpdateExpression(path_) {
            const { node } = path_
            if (!t.isIdentifier(node.argument)) return
            const binding = path_.scope.getBinding(node.argument.name)
            const typed = binding ? env.runtimeTyped.get(binding) : null
            if (!typed) return

            noteWrite(binding, false)
            record({ kind: "assignment", name: `"${node.argument.name}" ${node.operator}`, label: typed.label, node: node.argument,
                removed: false, reason: "increment/decrement is always checked" })
        }
    })

    traverse(ast, {
        VariableDeclarator(path_) {
            const { id, init } = path_.node
            if (!t.isIdentifier(id) || !t.isCallExpression(init)) return
            if (!t.isIdentifier(init.callee, { name: "__typed_variable__" })) return
            if (!t.isStringLiteral(init.arguments[1])) return

            const label = init.arguments[1].value
            const binding = path_.scope.getBinding(id.name)
            if (!binding) return

            const proven = prove(init.arguments[0], path_, env)
            let reason = null

            if (!isPrimitiveLabel(label)) reason = `type ${label} is not a primitive; objects are guarded at runtime`
            else if (!proven) reason = unprovenReason(init.arguments[0], path_, env)
            else if (!provenAccepts(label, proven.label)) reason = `${proven.label} is not proven to satisfy ${label}`
            else if (binding.kind === "var") reason = "var bindings are hoisted"
            else if (!onlyInstrumentedWrites(binding)) reason = "binding is written by a construct that is not type-checked"
            else if (writesProven.get(binding) === false) reason = "a later write to this variable is not proven"

            record({
                kind: "variable",
                name: `"${id.name}"`,
                label,
                node: id,
                removed: !reason,
                reason: reason ?? proven.proof,
                apply: () => { init._slimElide = true }
            })
        },

        ReturnStatement(path_) {
            const fn = path_.getFunctionParent()
            const declared = fn ? env.returns.get(fn.node) : null
            if (!declared) return

            const value = path_.node.argument
            const proven = value ? prove(value, path_, env) : { label: "undefined", proof: "bare return is undefined" }
            let reason = null

            if (!value && path_.scope.getBinding("undefined")) reason = "undefined is shadowed"
            else if (!isPrimitiveLabel(declared.label)) reason = `type ${declared.label} is not a primitive`
            else if (!proven) reason = unprovenReason(value, path_, env)
            else if (!provenAccepts(declared.label, proven.label)) reason = `${proven.label} is not proven to satisfy ${declared.label}`

            record({
                kind: "return",
                name: `"${declared.name}"`,
                label: declared.label,
                node: path_.node,
                removed: !reason,
                reason: reason ?? proven.proof,
                apply: () => { path_.node._slimProven = true }
            })
        }
    })

    // Methods, anonymous callbacks, field initializers and destructuring keep their guards.
    traverse(ast, {
        CallExpression(p) {
            const node = p.node
            if (!t.isIdentifier(node.callee)) return
            const kind = { __typed_parameter__: "parameter", __typed_variable__: "field", __typed_pattern__: "pattern" }[node.callee.name]
            if (!kind || reported.has(node)) return
            if (p.parentPath.isVariableDeclarator() && reported.has(p.parent.id)) return
            const label = node.arguments[1]
            if (!t.isStringLiteral(label)) return
            record({ kind, name: t.isIdentifier(node.arguments[0]) ? node.arguments[0].name : kind,
                label: label.value, node, removed: false, reason: "no proof for this check site" })
        }
    })

    decisions.sort((a, b) => a.line - b.line || a.column - b.column || a.kind.localeCompare(b.kind))
    return decisions
}

// A function whose declared return type is honoured on every path: not async/generator,
// and its body ends in `return` or `throw`, so it cannot fall off the end with `undefined`.
export function returnsOnEveryPath(fn) {
    if (fn.async || fn.generator || !t.isBlockStatement(fn.body)) return false
    const last = fn.body.body[fn.body.body.length - 1]
    return t.isReturnStatement(last) || t.isThrowStatement(last)
}
