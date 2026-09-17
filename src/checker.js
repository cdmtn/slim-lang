import _traverse from "@babel/traverse"
import * as t from "@babel/types"
import path from "node:path"
import { computeLineStarts, offsetToLineCol } from "./sourcemap.js"

const traverse = _traverse.default ?? _traverse

const NUMERIC = new Set(["int", "float", "number"])
const KNOWN = new Set([
    "int", "float", "number", "string", "bool", "null", "undefined",
    "object", "array", "function", "any", "element"
])

function splitUnion(label) {
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

function expand(label) {
    const trimmed = label.trim()
    if (trimmed.endsWith("?")) return `${trimmed.slice(0, -1).trim()} | null | undefined`
    return trimmed
}

function isIntersection(label) {
    return label.includes("&") && !label.includes("|")
}

function elementOf(label) {
    if (!label.endsWith("[]")) return null
    const inner = label.slice(0, -2).trim()
    if (inner.startsWith("(") && inner.endsWith(")")) return inner.slice(1, -1).trim()
    return inner
}

function baseName(label) {
    return label.replace(/(\[\])+$/, "").replace(/<[\s\S]*>$/, "").trim()
}

function splitList(text) {
    const parts = []
    let depth = 0
    let current = ""

    for (const char of text) {
        if (char === "<" || char === "[" || char === "(") depth++
        else if (char === ">" || char === "]" || char === ")") depth--
        else if (char === "," && depth === 0) { parts.push(current.trim()); current = ""; continue }
        current += char
    }
    if (current.trim()) parts.push(current.trim())
    return parts
}

function genericOf(label) {
    const open = label.indexOf("<")
    if (open === -1 || !label.endsWith(">")) return null
    return {
        container: label.slice(0, open).trim(),
        args: splitList(label.slice(open + 1, -1))
    }
}

function tupleOf(label) {
    if (!label.startsWith("[") || !label.endsWith("]") || label.length <= 2) return null
    return splitList(label.slice(1, -1))
}

function normalize(label) {
    const trimmed = label.trim()
    const generic = genericOf(trimmed)
    if (generic && generic.container === "Array" && generic.args.length === 1) {
        return `${normalize(generic.args[0])}[]`
    }
    return trimmed
}

function resolveStruct(name, env, seen = new Set()) {
    const definition = env.structs.get(name)
    if (!definition) return null
    if (definition.resolved) return definition

    if (!definition.parent) {
        return { ...definition, ancestors: new Set(), resolved: true }
    }
    if (seen.has(name)) return null

    seen.add(name)
    const parent = resolveStruct(definition.parent, env, seen)
    if (!parent) return null

    const fields = new Map(parent.fields)
    for (const [field, info] of definition.fields) fields.set(field, info)

    return {
        fields,
        defaults: new Set([...parent.defaults, ...definition.defaults]),
        methods: new Set([...parent.methods, ...definition.methods]),
        ancestors: new Set([definition.parent, ...parent.ancestors]),
        parent: null,
        resolved: true
    }
}

function inherits(name, ancestor, env) {
    if (name === ancestor) return true
    return resolveStruct(name, env)?.ancestors.has(ancestor) ?? false
}

export function createEnvironment() {
    return {
        structs: new Map(),
        enums: new Map(),
        customTypes: new Set(),
        functions: new Map(),
        bindings: new Map(),
        classes: new Set(),
        methodOwners: new Map(),
        returns: new Map(),
        functionsByName: new Map(),
        importedFunctions: new Map()
    }
}

const moduleTypes = new Map()

function signatureFor(name, path_, env) {
    const binding = path_.scope.getBinding(name)
    if (binding) return env.functions.get(binding) ?? null
    return env.importedFunctions.get(name) ?? null
}

const BUILTIN_CLASSES = new Set(["Map", "Set", "Date", "Promise", "RegExp", "Error"])

function isOpen(label, env) {
    const base = baseName(label)
    if (!base) return true

    if (env.customTypes.has(base)) return true
    if (KNOWN.has(base) || BUILTIN_CLASSES.has(base)) return false
    if (env.structs.has(base) || env.enums.has(base)) return false
    if (label.includes("::")) return !env.enums.has(label.split("::")[0])
    return true
}

function acceptsAtom(target, source, env) {
    if (target === source) return true
    if (target === "any" || source === "any") return true

    const targetElement = elementOf(target)
    const sourceElement = elementOf(source)
    if (targetElement) {
        if (source === "array") return true
        if (!sourceElement) return isOpen(source, env)
        if (sourceElement === "null") return true
        return accepts(targetElement, sourceElement, env, true)
    }
    if (target === "array") return !!sourceElement || source === "array" || isOpen(source, env)
    if (sourceElement) return target === "object" || isOpen(target, env)

    if (isOpen(target, env) || isOpen(source, env)) return true

    if (NUMERIC.has(target) && NUMERIC.has(source)) {
        if (target === "int") return source === "int"
        return true
    }

    const targetTuple = tupleOf(target)
    const sourceTuple = tupleOf(source)
    if (targetTuple || sourceTuple) {
        if (!targetTuple || !sourceTuple) return false
        if (targetTuple.length !== sourceTuple.length) return false
        return targetTuple.every((part, index) => accepts(part, sourceTuple[index], env, true))
    }

    const targetGeneric = genericOf(target)
    if (targetGeneric) {
        return baseName(target) === baseName(source)
    }
    if (genericOf(source)) return baseName(target) === baseName(source)

    if (BUILTIN_CLASSES.has(target)) return target === source
    if (BUILTIN_CLASSES.has(source)) return false

    if (target === "object") return source === "object" || env.structs.has(source)
    if (env.structs.has(target)) {
        return source === "object" || inherits(source, target, env)
    }

    if (target.includes("::")) {
        const [enumName] = target.split("::")
        const definition = env.enums.get(enumName)
        if (!definition) return true
        if (source === target || source === enumName) return true
        return definition.valueTypes.has(source)
    }

    if (env.enums.has(target)) {
        const definition = env.enums.get(target)
        return source.startsWith(`${target}::`) || definition.valueTypes.has(source)
    }

    return false
}

export function accepts(target, source, env, requireAll = false) {
    if (!target || !source) return true

    const targetLabel = expand(target)
    const sourceLabel = expand(source)
    if (isIntersection(targetLabel) || isIntersection(sourceLabel)) return true

    const targets = splitUnion(targetLabel).map(normalize)
    const sources = splitUnion(sourceLabel).map(normalize)
    const fits = one => targets.some(other => acceptsAtom(other, one, env))

    return requireAll ? sources.every(fits) : sources.some(fits)
}

function unionOf(left, right) {
    if (!left || !right) return null
    if (left === right) return left
    return `${left} | ${right}`
}

function typedVariableLabel(node) {
    if (!t.isCallExpression(node)) return null
    if (!t.isIdentifier(node.callee, { name: "__typed_variable__" })) return null
    return t.isStringLiteral(node.arguments[1]) ? node.arguments[1].value : null
}

function structLiteralLabel(node, env) {
    if (!t.isCallExpression(node)) return null
    const callee = node.callee
    if (!t.isMemberExpression(callee) || callee.computed) return null
    if (!t.isIdentifier(callee.property, { name: "new" })) return null
    if (!t.isIdentifier(callee.object) || !env.structs.has(callee.object.name)) return null
    return callee.object.name
}

export function infer(node, path_, env) {
    if (!node) return null

    if (t.isNumericLiteral(node)) return Number.isInteger(node.value) ? "int" : "float"
    if (t.isStringLiteral(node) || t.isTemplateLiteral(node)) return "string"
    if (t.isBooleanLiteral(node)) return "bool"
    if (t.isNullLiteral(node)) return "null"
    if (t.isIdentifier(node, { name: "undefined" })) return "undefined"
    if (t.isObjectExpression(node)) return "object"
    if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) return "function"

    if (t.isArrayExpression(node)) {
        if (node.elements.length === 0) return "null[]"

        const kinds = new Set()
        for (const item of node.elements) {
            if (!item || t.isSpreadElement(item)) return "array"
            const kind = infer(item, path_, env)
            if (!kind) return "array"
            kinds.add(kind)
        }

        if (kinds.size === 1) return `${[...kinds][0]}[]`
        return `(${[...kinds].join(" | ")})[]`
    }

    const structInstance = structLiteralLabel(node, env)
    if (structInstance) return structInstance

    if (t.isNewExpression(node) && t.isIdentifier(node.callee)) {
        const name = node.callee.name
        if (env.classes.has(name) || BUILTIN_CLASSES.has(name)) return name
        return null
    }

    if (t.isIdentifier(node)) {
        const binding = path_.scope.getBinding(node.name)
        return binding ? env.bindings.get(binding) ?? null : null
    }

    if (t.isThisExpression(node)) {
        const fn = path_.getFunctionParent()
        return fn ? env.methodOwners.get(fn.node) ?? null : null
    }

    if (t.isMemberExpression(node) && node.computed) {
        const objectType = normalize(infer(node.object, path_, env) ?? "")
        if (!objectType) return null

        const element = elementOf(objectType)
        if (element) return element

        const tuple = tupleOf(objectType)
        if (tuple && t.isNumericLiteral(node.property)) return tuple[node.property.value] ?? null
        return null
    }

    if (t.isMemberExpression(node) && t.isIdentifier(node.property)) {
        if (t.isIdentifier(node.object) && env.enums.has(node.object.name)) {
            return `${node.object.name}::${node.property.name}`
        }
        const objectType = infer(node.object, path_, env)
        const definition = objectType ? resolveStruct(objectType, env) : null
        return definition?.fields.get(node.property.name)?.type ?? null
    }

    if (t.isUnaryExpression(node)) {
        if (node.operator === "!") return "bool"
        if (node.operator === "-" || node.operator === "+") {
            const operand = infer(node.argument, path_, env)
            return NUMERIC.has(operand) ? operand : null
        }
        if (node.operator === "typeof") return "string"
        return null
    }

    if (t.isBinaryExpression(node)) {
        const operator = node.operator
        if (["==", "!=", "===", "!==", "<", ">", "<=", ">=", "instanceof", "in"].includes(operator)) {
            return "bool"
        }

        const left = infer(node.left, path_, env)
        const right = infer(node.right, path_, env)

        if (operator === "+") {
            if (left === "string" || right === "string") return "string"
            if (NUMERIC.has(left) && NUMERIC.has(right)) {
                return left === "int" && right === "int" ? "int" : "float"
            }
            return null
        }

        if (["-", "*", "%", "**"].includes(operator)) {
            if (NUMERIC.has(left) && NUMERIC.has(right)) {
                return left === "int" && right === "int" ? "int" : "float"
            }
            return null
        }

        if (operator === "/") return NUMERIC.has(left) && NUMERIC.has(right) ? "float" : null
        return null
    }

    if (t.isLogicalExpression(node)) {
        return unionOf(infer(node.left, path_, env), infer(node.right, path_, env))
    }

    if (t.isConditionalExpression(node)) {
        return unionOf(infer(node.consequent, path_, env), infer(node.alternate, path_, env))
    }

    if (t.isAwaitExpression(node)) return null

    if (t.isCallExpression(node) && t.isIdentifier(node.callee)) {
        const label = typedVariableLabel(node)
        if (label) return label

        return signatureFor(node.callee.name, path_, env)?.returns ?? null
    }

    return null
}

function declaredReturn(fn) {
    if (!t.isBlockStatement(fn.body)) return null

    for (const statement of fn.body.body) {
        if (!t.isExpressionStatement(statement)) continue
        const call = statement.expression
        if (!t.isCallExpression(call)) continue
        if (!t.isIdentifier(call.callee, { name: "__declare_return__" })) continue
        if (t.isStringLiteral(call.arguments[0])) return call.arguments[0].value
    }
    return null
}

function collectParameters(fn) {
    const declared = new Map()

    if (t.isBlockStatement(fn.body)) {
        for (const statement of fn.body.body) {
            if (!t.isExpressionStatement(statement)) continue
            const call = statement.expression
            if (!t.isCallExpression(call)) continue
            if (!t.isIdentifier(call.callee, { name: "__typed_parameter__" })) continue

            const [value, label, , optional] = call.arguments
            if (!t.isIdentifier(value) || !t.isStringLiteral(label)) continue
            declared.set(value.name, {
                type: label.value,
                optional: t.isBooleanLiteral(optional) ? optional.value : false
            })
        }
    }

    let rest = false
    const parameters = fn.params.map(param => {
        if (t.isRestElement(param)) { rest = true; return { name: null, type: null, required: false } }
        if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
            return { name: param.left.name, type: declared.get(param.left.name)?.type ?? null, required: false }
        }
        if (t.isIdentifier(param)) {
            const info = declared.get(param.name)
            return { name: param.name, type: info?.type ?? null, required: !info?.optional }
        }
        return { name: null, type: null, required: false }
    })

    const returns = declaredReturn(fn)
    return { parameters, rest, returns, typed: declared.size > 0 || !!returns }
}

function functionName(path_) {
    if (t.isFunctionDeclaration(path_.node) && path_.node.id) return path_.node.id.name
    if (path_.parentPath?.isVariableDeclarator() && t.isIdentifier(path_.parent.id)) {
        return path_.parent.id.name
    }
    if (path_.parentPath?.isObjectProperty()) {
        const key = path_.parent.key
        if (t.isStringLiteral(key)) return key.value
        if (t.isIdentifier(key)) return key.name
    }
    if ((t.isClassMethod(path_.node) || t.isObjectMethod(path_.node)) && t.isIdentifier(path_.node.key)) {
        return path_.node.key.name
    }
    return "function"
}

function collect(ast, env) {
    traverse(ast, {
        ClassDeclaration(path_) {
            if (path_.node.id) env.classes.add(path_.node.id.name)
        },

        VariableDeclarator(path_) {
            const { id, init } = path_.node
            if (!t.isIdentifier(id)) return

            const binding = path_.scope.getBinding(id.name)

            if (t.isCallExpression(init) && t.isIdentifier(init.callee)) {
                const name = init.callee.name
                const [nameArg, schema] = init.arguments

                if (name === "__def_struct__" && t.isStringLiteral(nameArg) && t.isObjectExpression(schema)) {
                    const fields = new Map()
                    for (const property of schema.properties) {
                        if (!t.isObjectProperty(property) || !t.isStringLiteral(property.value)) continue
                        const key = t.isStringLiteral(property.key) ? property.key.value
                            : t.isIdentifier(property.key) ? property.key.name : null
                        if (key === null) continue
                        const optional = key.startsWith("*")
                        fields.set(optional ? key.slice(1).trim() : key, {
                            type: property.value.value,
                            optional
                        })
                    }

                    const defaults = new Set()
                    if (t.isObjectExpression(init.arguments[3])) {
                        for (const property of init.arguments[3].properties) {
                            if (!t.isObjectProperty(property)) continue
                            const key = t.isStringLiteral(property.key) ? property.key.value
                                : t.isIdentifier(property.key) ? property.key.name : null
                            if (key !== null) defaults.add(key)
                        }
                    }

                    const methods = new Set()
                    if (t.isObjectExpression(init.arguments[5])) {
                        for (const property of init.arguments[5].properties) {
                            if (!t.isObjectProperty(property)) continue
                            const key = t.isStringLiteral(property.key) ? property.key.value
                                : t.isIdentifier(property.key) ? property.key.name : null
                            if (key === null) continue
                            methods.add(key)
                            if (t.isFunction(property.value)) {
                                env.methodOwners.set(property.value, nameArg.value)
                            }
                        }
                    }

                    const parent = t.isStringLiteral(init.arguments[4]) ? init.arguments[4].value : null
                    env.structs.set(nameArg.value, { fields, defaults, methods, parent })
                    return
                }

                if (name === "__def_enum__" && t.isStringLiteral(nameArg) && t.isObjectExpression(schema)) {
                    const members = new Set()
                    const valueTypes = new Set()
                    for (const property of schema.properties) {
                        if (!t.isObjectProperty(property)) continue
                        const key = t.isStringLiteral(property.key) ? property.key.value
                            : t.isIdentifier(property.key) ? property.key.name : null
                        if (key !== null) members.add(key)
                        if (t.isStringLiteral(property.value)) valueTypes.add("string")
                        else if (t.isNumericLiteral(property.value)) {
                            valueTypes.add(Number.isInteger(property.value.value) ? "int" : "float")
                        } else valueTypes.add("any")
                    }
                    env.enums.set(nameArg.value, { members, valueTypes })
                    return
                }

                if (name === "__type_def__" && t.isStringLiteral(nameArg)) {
                    env.customTypes.add(nameArg.value)
                    return
                }

                const label = typedVariableLabel(init)
                if (label && binding) env.bindings.set(binding, label)
            }

            const instance = structLiteralLabel(init, env)
            if (instance && binding) env.bindings.set(binding, instance)

            if ((t.isArrowFunctionExpression(init) || t.isFunctionExpression(init)) && binding) {
                const signature = collectParameters(init)
                env.functions.set(binding, signature)
                if (binding.scope.path.isProgram()) env.functionsByName.set(id.name, signature)
            }
        },

        FunctionDeclaration(path_) {
            if (!path_.node.id) return
            const name = path_.node.id.name
            const binding = path_.scope.getBinding(name)
            if (!binding) return

            const signature = collectParameters(path_.node)
            env.functions.set(binding, signature)
            if (binding.scope.path.isProgram()) env.functionsByName.set(name, signature)
        },

        Function(path_) {
            const { parameters, returns } = collectParameters(path_.node)
            for (const parameter of parameters) {
                if (!parameter.name || !parameter.type) continue
                const binding = path_.scope.getBinding(parameter.name)
                if (binding) env.bindings.set(binding, parameter.type)
            }

            if (returns) {
                env.returns.set(path_.node, { label: returns, name: functionName(path_) })
            }
        }
    })
}

function describe(label) {
    return label.includes("|") || label.includes("&") ? `(${label})` : label
}

function checkStructLiteral(structName, node, path_, env, report) {
    const definition = resolveStruct(structName, env)
    if (!definition) return

    const seen = new Set()
    for (const property of node.properties) {
        if (!t.isObjectProperty(property)) return
        const key = t.isIdentifier(property.key) && !property.computed ? property.key.name
            : t.isStringLiteral(property.key) ? property.key.value : null
        if (key === null) return

        seen.add(key)
        const field = definition.fields.get(key)
        if (!field) {
            report(property, `"${structName}" has no field "${key}"`)
            continue
        }

        const value = infer(property.value, path_, env)
        if (!accepts(field.type, value, env)) {
            report(property.value,
                `"${structName}.${key}" expects ${describe(field.type)}, got ${describe(value)}`)
        }
    }

    for (const [name, field] of definition.fields) {
        if (field.optional || seen.has(name) || definition.defaults.has(name)) continue
        report(node, `"${structName}" is missing field "${name}" of type ${describe(field.type)}`)
    }
}

function matchExpression(node) {
    if (!t.isCallExpression(node) || node.arguments.length !== 1) return null

    const callee = node.callee
    if (!t.isArrowFunctionExpression(callee) || callee.params.length !== 1) return null
    if (!t.isIdentifier(callee.params[0], { name: "__match" })) return null
    if (!t.isBlockStatement(callee.body)) return null

    const covered = []
    let wildcard = false
    let guarded = false

    for (const statement of callee.body.body) {
        if (t.isBlockStatement(statement)) { guarded = true; continue }

        if (t.isIfStatement(statement)) {
            const test = statement.test
            if (t.isCallExpression(test) && t.isIdentifier(test.callee, { name: "__match_eq__" })) {
                covered.push(test.arguments[1])
            } else guarded = true
            continue
        }

        if (t.isReturnStatement(statement)) {
            wildcard = !t.isIdentifier(statement.argument, { name: "undefined" })
        }
    }

    return { covered, wildcard, guarded, scrutinee: node.arguments[0] }
}

function checkExhaustive(node, match, path_, env, report) {
    if (match.guarded || match.wildcard) return

    const label = infer(match.scrutinee, path_, env)
    if (!label) return

    const enumName = label.includes("::") ? label.split("::")[0] : label
    const definition = env.enums.get(enumName)
    if (!definition) return

    const covered = new Set()
    for (const arm of match.covered) {
        if (!t.isMemberExpression(arm) || arm.computed) return
        if (!t.isIdentifier(arm.object, { name: enumName })) return
        if (!t.isIdentifier(arm.property)) return
        covered.add(arm.property.name)
    }

    const missing = [...definition.members].filter(member => !covered.has(member))
    if (missing.length === 0) return

    report(node, `match on "${enumName}" does not handle ${missing.map(member => `${enumName}.${member}`).join(", ")}` +
        ` — add the missing case${missing.length === 1 ? "" : "s"} or a "_" fallback`)
}

function checkValue(label, node, path_, env, report, describeTarget, phrase = "expects") {
    if (t.isObjectExpression(node) && env.structs.has(label)) {
        checkStructLiteral(label, node, path_, env, report)
        return
    }

    const actual = infer(node, path_, env)
    if (!accepts(label, actual, env)) {
        report(node, `${describeTarget} ${phrase} ${describe(label)}, got ${describe(actual)}`)
    }
}

function verify(ast, env, report) {
    traverse(ast, {
        VariableDeclarator(path_) {
            const { id, init } = path_.node
            if (!t.isIdentifier(id) || !t.isCallExpression(init)) return

            const label = typedVariableLabel(init)
            if (!label) return

            checkValue(label, init.arguments[0], path_, env, report, `"${id.name}"`)
        },

        AssignmentExpression(path_) {
            const { node } = path_
            if (!t.isIdentifier(node.left) || node.operator !== "=") return

            const binding = path_.scope.getBinding(node.left.name)
            const label = binding ? env.bindings.get(binding) : null
            if (!label) return

            checkValue(label, node.right, path_, env, report, `"${node.left.name}"`)
        },

        CallExpression(path_) {
            const { node } = path_

            const match = matchExpression(node)
            if (match) checkExhaustive(node, match, path_, env, report)

            const constructed = structLiteralLabel(node, env)
            if (constructed && t.isObjectExpression(node.arguments[0])) {
                const definition = resolveStruct(constructed, env)
                if (!definition) return

                for (const property of node.arguments[0].properties) {
                    if (!t.isObjectProperty(property)) return
                    const key = t.isIdentifier(property.key) && !property.computed ? property.key.name
                        : t.isStringLiteral(property.key) ? property.key.value : null
                    if (key === null) return

                    const field = definition.fields.get(key)
                    if (!field) {
                        report(property, `"${constructed}" has no field "${key}"`)
                        continue
                    }

                    const value = infer(property.value, path_, env)
                    if (!accepts(field.type, value, env)) {
                        report(property.value,
                            `"${constructed}.${key}" expects ${describe(field.type)}, got ${describe(value)}`)
                    }
                }
                return
            }

            if (!t.isIdentifier(node.callee)) return

            const signature = signatureFor(node.callee.name, path_, env)
            if (!signature || !signature.typed) return
            if (node.arguments.some(argument => t.isSpreadElement(argument))) return

            const name = node.callee.name
            const required = signature.parameters.filter(parameter => parameter.required).length

            if (node.arguments.length < required) {
                report(node, `"${name}" expects ${required} argument${required === 1 ? "" : "s"}, got ${node.arguments.length}`)
                return
            }
            if (!signature.rest && node.arguments.length > signature.parameters.length) {
                report(node,
                    `"${name}" takes ${signature.parameters.length} argument${signature.parameters.length === 1 ? "" : "s"}, got ${node.arguments.length}`)
                return
            }

            node.arguments.forEach((argument, index) => {
                const parameter = signature.parameters[index]
                if (!parameter?.type) return
                checkValue(parameter.type, argument, path_, env, report,
                    `argument "${parameter.name}" of "${name}"`)
            })
        },

        ReturnStatement(path_) {
            const fn = path_.getFunctionParent()
            const declared = fn ? env.returns.get(fn.node) : null
            if (!declared) return

            const value = path_.node.argument
            if (!value) {
                if (!accepts(declared.label, "undefined", env)) {
                    report(path_.node,
                        `"${declared.name}" must return ${describe(declared.label)}, got undefined`)
                }
                return
            }

            checkValue(declared.label, value, path_, env, report, `"${declared.name}"`, "must return")
        },

        MemberExpression(path_) {
            const { node } = path_
            if (node.computed || !t.isIdentifier(node.property)) return
            if (!t.isIdentifier(node.object) && !t.isThisExpression(node.object)) return
            if (t.isAssignmentExpression(path_.parent) && path_.parent.left === node) return

            const label = infer(node.object, path_, env)
            const definition = label ? resolveStruct(label, env) : null
            if (!definition) return

            const field = node.property.name
            if (definition.fields.has(field) || definition.methods.has(field)) return

            report(node.property, `"${label}" has no field "${field}"`)
        }
    })
}

function exportedNames(ast) {
    const names = new Map()

    traverse(ast, {
        ExportNamedDeclaration(path_) {
            const declaration = path_.node.declaration

            if (t.isVariableDeclaration(declaration)) {
                for (const declarator of declaration.declarations) {
                    if (t.isIdentifier(declarator.id)) names.set(declarator.id.name, declarator.id.name)
                }
            } else if ((t.isFunctionDeclaration(declaration) || t.isClassDeclaration(declaration)) && declaration.id) {
                names.set(declaration.id.name, declaration.id.name)
            }

            for (const specifier of path_.node.specifiers ?? []) {
                if (!t.isExportSpecifier(specifier)) continue
                const exported = t.isIdentifier(specifier.exported)
                    ? specifier.exported.name
                    : specifier.exported.value
                names.set(exported, specifier.local.name)
            }
        }
    })

    return names
}

function buildModuleTypes(ast, env) {
    const record = {
        structs: new Map(),
        enums: new Map(),
        customTypes: new Set(),
        functions: new Map(),
        ambient: { structs: new Map(), enums: new Map(), customTypes: new Set() }
    }

    for (const name of env.structs.keys()) {
        const resolved = resolveStruct(name, env)
        if (resolved) record.ambient.structs.set(name, resolved)
    }
    for (const [name, definition] of env.enums) record.ambient.enums.set(name, definition)
    for (const name of env.customTypes) record.ambient.customTypes.add(name)

    for (const [exported, local] of exportedNames(ast)) {
        const struct = record.ambient.structs.get(local)
        if (struct) record.structs.set(exported, struct)
        if (env.enums.has(local)) record.enums.set(exported, env.enums.get(local))
        if (env.customTypes.has(local)) record.customTypes.add(exported)
        if (env.functionsByName.has(local)) record.functions.set(exported, env.functionsByName.get(local))
    }

    return record
}

function seedImports(env, imports, wildcards) {
    const merge = (record, name, local) => {
        if (record.structs.has(name)) env.structs.set(local, record.structs.get(name))
        if (record.enums.has(name)) env.enums.set(local, record.enums.get(name))
        if (record.customTypes.has(name)) env.customTypes.add(local)
        if (record.functions.has(name)) env.importedFunctions.set(local, record.functions.get(name))
    }

    const sources = new Set([...wildcards, ...imports.map(entry => entry.source)])

    for (const source of sources) {
        const record = moduleTypes.get(source)
        if (!record) continue

        for (const [name, definition] of record.ambient.structs) {
            if (!env.structs.has(name)) env.structs.set(name, definition)
        }
        for (const [name, definition] of record.ambient.enums) {
            if (!env.enums.has(name)) env.enums.set(name, definition)
        }
        for (const name of record.ambient.customTypes) env.customTypes.add(name)
    }

    for (const source of wildcards) {
        const record = moduleTypes.get(source)
        if (!record) continue
        for (const name of record.structs.keys()) merge(record, name, name)
        for (const name of record.enums.keys()) merge(record, name, name)
        for (const name of record.customTypes) merge(record, name, name)
        for (const name of record.functions.keys()) merge(record, name, name)
    }

    for (const { local, imported, source } of imports) {
        const record = moduleTypes.get(source)
        if (record) merge(record, imported, local)
    }
}

export function checkTypes(ast, { mapped, originalCode, sourceFile, imports = [], wildcards = [] }) {
    const env = createEnvironment()
    const diagnostics = []
    const originalLines = computeLineStarts(originalCode)
    const sourceLines = originalCode.split("\n")

    const report = (node, message) => {
        const offset = typeof node.start === "number" ? node.start : 0
        const origin = mapped.origin[offset]
        const location = origin >= 0 ? offsetToLineCol(origin, originalLines) : null

        diagnostics.push({
            message,
            sourceFile,
            line: location ? location.line + 1 : 0,
            column: location ? location.column + 1 : 0,
            sourceLine: location ? sourceLines[location.line] ?? "" : ""
        })
    }

    seedImports(env, imports, wildcards)
    collect(ast, env)
    moduleTypes.set(path.resolve(sourceFile), buildModuleTypes(ast, env))

    verify(ast, env, report)

    diagnostics.sort((a, b) => a.line - b.line || a.column - b.column)
    return diagnostics
}

export function formatDiagnostics(diagnostics) {
    return diagnostics.map(({ message, sourceFile, line, column, sourceLine }) => {
        const text = sourceLine.trim()
        const indent = sourceLine.length - sourceLine.trimStart().length
        const pointer = " ".repeat(Math.max(0, column - 1 - indent)) + "^"

        return [
            `TypeError: ${message}`,
            `    at ${sourceFile}:${line}:${column}`,
            "",
            `  ${text}`,
            `  ${pointer}`
        ].join("\n")
    }).join("\n\n")
}
