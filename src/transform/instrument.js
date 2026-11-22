import _traverse from "@babel/traverse"
import { readType, formatType } from "../external/typeSyntax.js"
import * as t from "@babel/types"
import { completesNormally } from "../checker/flow.js"
import { TYPED_RETURNS, allowsUndefined, buildTypeSpec, buildTypedCheck, getMemberName, identifierNames, isRuntimeCall, typeLabelFromArgument } from "./typeSpecs.js"
import { hoistTypeSpecs, primitiveTest } from "./fastChecks.js"

const traverse = _traverse.default ?? _traverse

export function instrumentRuntimeTypes(ast, sourceFile, importedNames) {
    const typedBindings = new Map()
    const staticFields = new Map()
    const taken = identifierNames(ast.program)
    let bindingCount = 0

    const assigned = new Set()
    const noteAssignment = (path_, target) => {
        if (t.isIdentifier(target)) assigned.add(path_.scope.getBinding(target.name))
    }
    traverse(ast, {
        AssignmentExpression(path_) { noteAssignment(path_, path_.node.left) },
        UpdateExpression(path_) { noteAssignment(path_, path_.node.argument) }
    })

    function slotName() {
        let name
        do name = `_slimType${bindingCount++}`
        while (taken.has(name))
        taken.add(name)
        return t.identifier(name)
    }

    function registerBinding(path_, name) {
        const binding = path_.scope.getBinding(name)
        if (!binding) return null

        let info = typedBindings.get(binding)
        if (!info) {
            info = {
                name,
                binding,
                slot: assigned.has(binding) ? slotName() : null
            }
            typedBindings.set(binding, info)
        }

        return info
    }

    function getStaticField(path_, member) {
        const fieldName = getMemberName(member)
        let classBinding = null

        if (t.isIdentifier(member.object)) {
            classBinding = path_.scope.getBinding(member.object.name)
        } else if (t.isThisExpression(member.object)) {
            const method = path_.findParent(parent => parent.isClassMethod() || parent.isClassPrivateMethod())
            const classPath = path_.findParent(parent => parent.isClassDeclaration())
            if (method?.node.static && classPath?.node.id) {
                classBinding = classPath.scope.getBinding(classPath.node.id.name)
            }
        }

        return fieldName ? {
            name: fieldName,
            definition: staticFields.get(classBinding)?.get(fieldName)
        } : null
    }

    traverse(ast, {
        VariableDeclarator(path_) {
            const { id, init } = path_.node
            if (!t.isIdentifier(id) || !isRuntimeCall(init, "__typed_variable__")) return

            const typeText = typeLabelFromArgument(init.arguments[1])
            const binding = registerBinding(path_, id.name)
            if (!typeText || !binding) return

            init.arguments[1] = buildTypeSpec(typeText, path_, importedNames)
            init.arguments[2] = binding.slot ? t.cloneNode(binding.slot) : t.nullLiteral()
            init.arguments[3] = t.stringLiteral(binding.name)
        },

        ClassProperty(path_) {
            const { node } = path_
            if (!node.static && isRuntimeCall(node.value, "__typed_variable__")) {
                const typeText = typeLabelFromArgument(node.value.arguments[1])
                if (typeText && /\bthis\b/.test(typeText)) node.value.arguments[1] = buildTypeSpec(typeText, path_.get("value"), importedNames)
                return
            }
            if (!node.static || !isRuntimeCall(node.value, "__typed_variable__")) return

            const typeText = typeLabelFromArgument(node.value.arguments[1])
            const fieldName = getMemberName({ property: node.key, computed: node.computed })
            const classPath = path_.findParent(parent => parent.isClassDeclaration())
            const className = classPath?.node.id?.name
            const classBinding = className ? classPath.scope.getBinding(className) : null
            if (!typeText || !fieldName || !classBinding) return

            const fields = staticFields.get(classBinding) ?? new Map()
            const displayName = `${className}.${fieldName}`
            fields.set(fieldName, { displayName })
            staticFields.set(classBinding, fields)

            node.value = t.callExpression(t.identifier("__typed_static_field__"), [
                t.thisExpression(),
                t.stringLiteral(fieldName),
                node.value.arguments[0],
                buildTypeSpec(typeText, path_, importedNames),
                t.stringLiteral(displayName)
            ])
        },

        ExpressionStatement(path_) {
            const call = path_.node.expression
            if (!isRuntimeCall(call, "__declare_return__")) return

            const [label, owner] = call.arguments
            const fn = path_.getFunctionParent()
            if (!t.isStringLiteral(label) || !fn) { path_.remove(); return }

            const declared = readType(label.value)
            const resolved = fn.node.async && !fn.node.generator && declared.kind === "generic" && declared.name === "Promise" && declared.args.length === 1
                ? formatType(declared.args[0]) : label.value
            const specification = buildTypeSpec(resolved, path_, importedNames)
            const fnName = t.isStringLiteral(owner) ? owner.value : "function"

            fn.traverse(TYPED_RETURNS, { specification, fnName, label: resolved, primitiveTest })

            const body = fn.node.body
            if (t.isBlockStatement(body) && !fn.node.generator && !fn.node._slimSignatureOnly && !allowsUndefined(readType(resolved)) && completesNormally(body)) {
                body.body.push(t.returnStatement(t.callExpression(t.identifier("__typed_return__"), [
                    t.identifier("undefined"),
                    t.cloneNode(specification),
                    t.stringLiteral(fnName)
                ])))
            }

            path_.remove()
        },

        CallExpression(path_) {
            const { node } = path_

            if (node._slimTypeArgs?.length && t.isMemberExpression(node.callee) && !node.callee.computed &&
                t.isIdentifier(node.callee.property, { name: "new" }) && t.isIdentifier(node.callee.object)) {
                const label = `${node.callee.object.name}<${node._slimTypeArgs.join(", ")}>`
                delete node._slimTypeArgs
                path_.replaceWith(t.callExpression(t.identifier("__typed_return__"), [
                    node, buildTypeSpec(label, path_, importedNames), t.stringLiteral(`${node.callee.object.name}.new`)
                ]))
                return
            }

            if (isRuntimeCall(node, "__typed_parameter__")) {
                const [value, expected, displayName, optional, message] = node.arguments
                if (!t.isIdentifier(value)) return

                const typeText = typeLabelFromArgument(expected)
                const binding = registerBinding(path_, value.name)
                if (!typeText || !binding) return

                node.arguments = [
                    value,
                    buildTypeSpec(typeText, path_, importedNames),
                    binding.slot ? t.cloneNode(binding.slot) : t.nullLiteral(),
                    t.isStringLiteral(displayName) ? displayName : t.stringLiteral(binding.name),
                    optional ?? t.booleanLiteral(false),
                    message ?? t.stringLiteral(`argument "${binding.name}" has an invalid type, got `)
                ]
                const test = !binding.slot && path_.parentPath.isExpressionStatement() &&
                    primitiveTest(typeText, value, t.isBooleanLiteral(optional, { value: true }))
                if (test) {
                    path_.replaceWith(t.logicalExpression("||", test, node))
                    path_.skip()
                }
                return
            }

            if (isRuntimeCall(node, "__typed_catch__")) {
                const typeText = typeLabelFromArgument(node.arguments[1])
                if (typeText) node.arguments[1] = buildTypeSpec(typeText, path_, importedNames)
                return
            }

            if (isRuntimeCall(node, "__def_struct__")) {
                const schema = node.arguments[1]
                if (!t.isObjectExpression(schema)) return

                const specifications = []
                for (const property of schema.properties) {
                    if (!t.isObjectProperty(property)) continue
                    const field = t.isIdentifier(property.key)
                        ? property.key.name
                        : t.isStringLiteral(property.key)
                            ? property.key.value
                            : null
                    const typeText = typeLabelFromArgument(property.value)
                    if (!field || !typeText) continue

                    specifications.push(t.objectProperty(
                        t.stringLiteral(field.replace(/^\*/, "")),
                        buildTypeSpec(typeText, path_, importedNames)
                    ))
                }

                if (specifications.length > 0) {
                    node.arguments[2] = t.objectExpression(specifications)
                }
                return
            }

            if (isRuntimeCall(node, "__type_def__")) {
                const properties = node.arguments[2]
                if (!t.isObjectExpression(properties)) return

                const oneLine = properties.properties.some(property =>
                    t.isObjectProperty(property) &&
                    (t.isIdentifier(property.key, { name: "type" }) ||
                        t.isStringLiteral(property.key, { value: "type" })) &&
                    t.isStringLiteral(property.value, { value: "one-line-expr" })
                )

                if (oneLine && t.isIdentifier(node.arguments[1])) {
                    node.arguments[1] = buildTypeSpec(node.arguments[1].name, path_, importedNames)
                } else if (oneLine && t.isStringLiteral(node.arguments[1])) {
                    node.arguments[1] = buildTypeSpec(node.arguments[1].value, path_, importedNames)
                }

                for (const property of properties.properties) {
                    if (!t.isObjectProperty(property)) continue
                    const key = t.isIdentifier(property.key)
                        ? property.key.name
                        : t.isStringLiteral(property.key)
                            ? property.key.value
                            : null
                    if (key !== "extends" || !t.isStringLiteral(property.value)) continue
                    property.value = buildTypeSpec(property.value.value, path_, importedNames)
                }
            }
        }
    })

    const slotsByScope = new Map()
    for (const info of typedBindings.values()) {
        if (!info.slot) continue
        const scope = info.binding.scope
        const slots = slotsByScope.get(scope) ?? []
        slots.push(info.slot)
        slotsByScope.set(scope, slots)
    }

    for (const [scope, slots] of slotsByScope) {
        const declaration = t.variableDeclaration(
            "let",
            slots.map(slot => t.variableDeclarator(t.cloneNode(slot), t.objectExpression([])))
        )
        const scopePath = scope.path

        if (scopePath.isProgram()) {
            declaration._slimTypeSlots = true
            scopePath.unshiftContainer("body", declaration)
        } else if (scopePath.isBlockStatement()) {
            scopePath.unshiftContainer("body", declaration)
        } else if (scopePath.isFunction()) {
            scopePath.ensureBlock()
            scopePath.get("body").unshiftContainer("body", declaration)
        } else if (scopePath.isForStatement() && t.isVariableDeclaration(scopePath.node.init)) {
            scopePath.node.init.declarations.unshift(...declaration.declarations)
        } else {
            throw new Error(`Slim cannot create a runtime type scope for "${slots[0].name}"`)
        }
    }

    function checkerFor(path_, target) {
        if (t.isMemberExpression(target)) {
            const field = getStaticField(path_, target)
            if (!field?.definition) return null

            return value => t.callExpression(t.identifier("__typed_static_field_check__"), [
                t.cloneNode(target.object),
                t.stringLiteral(field.name),
                value,
                t.stringLiteral(field.definition.displayName)
            ])
        }

        if (!t.isIdentifier(target)) return null
        const binding = typedBindings.get(path_.scope.getBinding(target.name))
        return binding?.slot ? value => buildTypedCheck(binding, value) : null
    }

    traverse(ast, {
        AssignmentExpression(path_) {
            const { node } = path_
            const check = checkerFor(path_, node.left)
            if (!check) return

            if (node.operator === "=") {
                node.right = check(node.right)
                return
            }

            const operator = node.operator.slice(0, -1)

            if (["&&", "||", "??"].includes(operator)) {
                const assignment = t.assignmentExpression("=", t.cloneNode(node.left), check(node.right))
                path_.replaceWith(t.logicalExpression(operator, t.cloneNode(node.left), assignment))
                path_.skip()
                return
            }

            node.operator = "="
            node.right = check(t.binaryExpression(operator, t.cloneNode(node.left), node.right))
        },

        UpdateExpression(path_) {
            const { node } = path_
            const check = checkerFor(path_, node.argument)
            if (!check) return

            const previous = path_.scope.generateUidIdentifier("typedPrevious")
            const nextValue = t.binaryExpression(
                node.operator === "++" ? "+" : "-",
                t.cloneNode(node.argument),
                t.numericLiteral(1)
            )
            const assignment = t.assignmentExpression("=", t.cloneNode(node.argument), check(nextValue))
            const result = node.prefix ? t.cloneNode(node.argument) : t.cloneNode(previous)

            path_.replaceWith(t.callExpression(
                t.arrowFunctionExpression([], t.blockStatement([
                    t.variableDeclaration("const", [t.variableDeclarator(previous, t.cloneNode(node.argument))]),
                    t.expressionStatement(assignment),
                    t.returnStatement(result)
                ])),
                []
            ))
            path_.skip()
        }
    })

    hoistTypeSpecs(ast, importedNames)
}
