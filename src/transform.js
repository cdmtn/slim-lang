import { parse } from "@babel/parser"
import _traverse from "@babel/traverse"
import _generate from "@babel/generator"
import { preprocess } from "./parser.js"
import * as t from "@babel/types"
import { SourceMapConsumer } from "source-map"
import path from "node:path"
import { getDistPath, resolveSlimImport } from "./modulePaths.js"

const traverse = _traverse.default ?? _traverse
const generate = _generate.default ?? _generate

function isRuntimeCall(node, name) {
    return t.isCallExpression(node) && t.isIdentifier(node.callee, { name })
}

function splitTypeUnion(typeText) {
    return typeText.split("|").map(part => part.trim()).filter(Boolean)
}

function getTypeReferenceName(typeText) {
    const withoutArray = typeText.replace(/(?:\[\])+$/, "")
    const withoutGeneric = withoutArray.replace(/<.*>$/, "")
    return withoutGeneric.split("::")[0]
}

function buildTypeSpec(typeText, path_, importedNames = new Set()) {
    const refs = splitTypeUnion(typeText).map((label) => {
        const referenceName = getTypeReferenceName(label)
        const binding = referenceName ? path_.scope.getBinding(referenceName) : null
        const args = [t.stringLiteral(label)]

        if (binding || importedNames.has(referenceName)) {
            args.push(t.arrowFunctionExpression([], t.identifier(referenceName)))
        }

        return t.callExpression(t.identifier("__type_ref__"), args)
    })

    return t.callExpression(t.identifier("__type_spec__"), refs)
}

function typeLabelFromArgument(node) {
    return t.isStringLiteral(node) ? node.value : null
}

function buildTypedCheck(binding, value) {
    return t.callExpression(t.identifier("__typed_variable_check__"), [
        t.cloneNode(binding.slot),
        value,
        t.stringLiteral(binding.name)
    ])
}

function getMemberName(member) {
    if (t.isPrivateName(member.property)) return `#${member.property.id.name}`
    if (!member.computed && t.isIdentifier(member.property)) return member.property.name
    if (member.computed && t.isStringLiteral(member.property)) return member.property.value
    return null
}

function instrumentRuntimeTypes(ast, sourceFile, importedNames) {
    const typedBindings = new Map()
    const staticFields = new Map()
    let bindingCount = 0

    function registerBinding(path_, name) {
        const binding = path_.scope.getBinding(name)
        if (!binding) return null

        let info = typedBindings.get(binding)
        if (!info) {
            info = {
                name,
                binding,
                slot: path_.scope.generateUidIdentifier(`slimType${bindingCount++}`)
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
            init.arguments[2] = t.cloneNode(binding.slot)
            init.arguments[3] = t.stringLiteral(binding.name)
        },

        ClassProperty(path_) {
            const { node } = path_
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

        CallExpression(path_) {
            const { node } = path_

            if (isRuntimeCall(node, "__typed_parameter__")) {
                const [value, expected, displayName, optional, message] = node.arguments
                if (!t.isIdentifier(value)) return

                const typeText = typeLabelFromArgument(expected)
                const binding = registerBinding(path_, value.name)
                if (!typeText || !binding) return

                node.arguments = [
                    value,
                    buildTypeSpec(typeText, path_, importedNames),
                    t.cloneNode(binding.slot),
                    t.isStringLiteral(displayName) ? displayName : t.stringLiteral(binding.name),
                    optional ?? t.booleanLiteral(false),
                    message ?? t.stringLiteral(`argument "${binding.name}" has an invalid type`)
                ]
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

        if (scopePath.isProgram() || scopePath.isBlockStatement()) {
            scopePath.unshiftContainer("body", declaration)
        } else if (scopePath.isFunction()) {
            scopePath.get("body").unshiftContainer("body", declaration)
        } else if (scopePath.isForStatement() && t.isVariableDeclaration(scopePath.node.init)) {
            scopePath.node.init.declarations.unshift(...declaration.declarations)
        } else {
            throw new Error(`Slim cannot create a runtime type scope for "${slots[0].name}"`)
        }
    }

    traverse(ast, {
        AssignmentExpression(path_) {
            const { node } = path_
            if (t.isMemberExpression(node.left)) {
                const staticField = getStaticField(path_, node.left)
                const fieldName = staticField?.name
                const field = staticField?.definition
                if (!field) return

                const check = value => t.callExpression(t.identifier("__typed_static_field_check__"), [
                    t.cloneNode(node.left.object),
                    t.stringLiteral(fieldName),
                    value,
                    t.stringLiteral(field.displayName)
                ])

                if (node.operator === "=") {
                    node.right = check(node.right)
                    return
                }

                if (["&&=", "||=", "??="].includes(node.operator)) {
                    const operator = node.operator.slice(0, -1)
                    const assignment = t.assignmentExpression(
                        "=",
                        t.cloneNode(node.left),
                        check(node.right)
                    )
                    path_.replaceWith(t.logicalExpression(operator, t.cloneNode(node.left), assignment))
                    path_.skip()
                    return
                }

                const operator = node.operator.slice(0, -1)
                node.operator = "="
                node.right = check(t.binaryExpression(operator, t.cloneNode(node.left), node.right))
                return
            }

            if (!t.isIdentifier(node.left)) return
            const binding = typedBindings.get(path_.scope.getBinding(node.left.name))
            if (!binding) return

            if (node.operator === "=") {
                node.right = buildTypedCheck(binding, node.right)
                return
            }

            if (["&&=", "||=", "??="].includes(node.operator)) {
                const operator = node.operator.slice(0, -1)
                const assignment = t.assignmentExpression(
                    "=",
                    t.cloneNode(node.left),
                    buildTypedCheck(binding, node.right)
                )
                path_.replaceWith(t.logicalExpression(operator, t.cloneNode(node.left), assignment))
                path_.skip()
                return
            }

            const operator = node.operator.slice(0, -1)
            node.operator = "="
            node.right = buildTypedCheck(
                binding,
                t.binaryExpression(operator, t.cloneNode(node.left), node.right)
            )
        },

        UpdateExpression(path_) {
            const { node } = path_
            if (t.isMemberExpression(node.argument)) {
                const staticField = getStaticField(path_, node.argument)
                const fieldName = staticField?.name
                const field = staticField?.definition
                if (!field) return

                const previous = path_.scope.generateUidIdentifier("typedPrevious")
                const nextValue = t.binaryExpression(
                    node.operator === "++" ? "+" : "-",
                    t.cloneNode(node.argument),
                    t.numericLiteral(1)
                )
                const check = t.callExpression(t.identifier("__typed_static_field_check__"), [
                    t.cloneNode(node.argument.object),
                    t.stringLiteral(fieldName),
                    nextValue,
                    t.stringLiteral(field.displayName)
                ])
                const assignment = t.assignmentExpression("=", t.cloneNode(node.argument), check)
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
                return
            }

            if (!t.isIdentifier(node.argument)) return

            const binding = typedBindings.get(path_.scope.getBinding(node.argument.name))
            if (!binding) return

            const previous = path_.scope.generateUidIdentifier("typedPrevious")
            const nextValue = t.binaryExpression(
                node.operator === "++" ? "+" : "-",
                t.cloneNode(node.argument),
                t.numericLiteral(1)
            )
            const assignment = t.assignmentExpression(
                "=",
                t.cloneNode(node.argument),
                buildTypedCheck(binding, nextValue)
            )
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
}

function resolvePath(raw, fromFile) {
    return resolveSlimImport(raw, fromFile)
}

function getDefaultsPath(sourceFile) {
    const distFile = getDistPath(sourceFile)
    const defaultsAbs = path.resolve("dist/external/defaults.js")
    const rel = path.relative(path.dirname(distFile), defaultsAbs)
    const relFixed = rel.replace(/\\/g, "/")
    return relFixed.startsWith(".") ? relFixed : "./" + relFixed
}

function parseSpecifiers(name) {
    const trimmed = name.trim()

    const namespaceMatch = trimmed.match(/^\*\s+as\s+([\w$]+)$/)
    if (namespaceMatch) {
        return [t.importNamespaceSpecifier(t.identifier(namespaceMatch[1]))]
    }

    if (trimmed.startsWith("{")) {
        const inner = trimmed.replace(/[{}]/g, "").trim()
        return inner.split(",").map(part => {
            const aliasParts = part.trim().split(/\s+as\s+/)
            const imported = aliasParts[0].trim()
            const local = (aliasParts[1] ?? aliasParts[0]).trim()
            return t.importSpecifier(t.identifier(local), t.identifier(imported))
        })
    }

    return [t.importSpecifier(t.identifier(trimmed), t.identifier(trimmed))]
}

function formatSyntaxError(err, originalCode, sourceFile, preprocessMap) {
    const loc = err.loc

    if (!loc) {
        console.error(`\nSyntaxError: ${err.message}\n`)
        process.exit(1)
    }

    const col = loc.column + 1
    const lines = originalCode.split("\n")

    let originalLine = loc.line
    try {
        const mapJson = preprocessMap.toJSON()
        const genLines = mapJson.sourcesContent?.[0]?.split("\n") ?? []
        const targetLine = lines[loc.line - 1]?.trim()

        if (targetLine) {
            const found = lines.findIndex(l => l.trim() === targetLine)
            if (found !== -1) originalLine = found + 1
        }
    } catch { }

    const sourceLine = lines[originalLine - 1] ?? ""
    const indent = sourceLine.search(/\S/)
    const pointer = " ".repeat(Math.max(0, col - indent - 1)) + "^"

    console.error([
        "",
        `SyntaxError: ${err.reasonCode ?? "Unexpected token"}`,
        `    at ${sourceFile}:${originalLine}:${col}`,
        "",
        `  ${sourceLine.trim()}`,
        `  ${pointer}`,
        "",
    ].join("\n"))

    process.exit(1)
}

export function transform(code, sourceFile = "input.ps") {
    const asyncFunctions = new Set()
    const imports = new Map()
    const wildcards = []

    const { code: pre, map: preprocessMap } = preprocess(code, sourceFile)

    // console.log(pre)
    // process.exit(0)

    let ast
    try {
        ast = parse(pre, {
            sourceType: "module",
            plugins: ["jsx"]
        })
    } catch (err) {
        if (err.code === "BABEL_PARSER_SYNTAX_ERROR") {
            formatSyntaxError(err, code, sourceFile, preprocessMap)
        }
        throw err
    }

    traverse(ast, {
        FunctionDeclaration(path_) {
            if (path_.node.async) {
                asyncFunctions.add(path_.node.id?.name)
            }
        },
        CallExpression(path_) {
            const callee = path_.node.callee

            if (t.isIdentifier(callee) && callee.name === "__use_all__") {
                const [sourceNode] = path_.node.arguments
                if (!t.isStringLiteral(sourceNode)) return
                wildcards.push(resolvePath(sourceNode.value, sourceFile))
                path_.remove()
                return
            }

            if (t.isIdentifier(callee) && callee.name === "__use__") {
                const [nameNode, sourceNode] = path_.node.arguments
                if (!t.isStringLiteral(nameNode) || !t.isStringLiteral(sourceNode)) return
                imports.set(nameNode.value, resolvePath(sourceNode.value, sourceFile))
                path_.remove()
            }
        },

        ClassDeclaration(path_) {
            if (!path_.node.superClass && imports.has("Component")) {
                path_.node.superClass = t.identifier("Component")
            }
        },

        ExpressionStatement(path_) {
            const expr = path_.node.expression
            if (
                t.isCallExpression(expr) &&
                t.isIdentifier(expr.callee) &&
                asyncFunctions.has(expr.callee.name)
            ) {
                path_.node.expression = t.callExpression(
                    t.memberExpression(expr, t.identifier("catch")),
                    [t.identifier("__handle_async_error__")]
                )
            }
        }
    })

    const importedNames = new Set()
    for (const name of imports.keys()) {
        for (const specifier of parseSpecifiers(name)) {
            importedNames.add(specifier.local.name)
        }
    }
    instrumentRuntimeTypes(ast, sourceFile, importedNames)

    const defaultsPath = getDefaultsPath(sourceFile)
    const defaultImport = t.importDeclaration([], t.stringLiteral(defaultsPath))

    const wildcardNodes = wildcards.flatMap((source) => {
        const alias = "__" + source.replace(/[^a-zA-Z0-9]/g, "_").replace(/^_+|_+$/g, "") + "__"

        return [
            t.importDeclaration(
                [t.importNamespaceSpecifier(t.identifier(alias))],
                t.stringLiteral(source)
            ),
            t.expressionStatement(
                t.callExpression(
                    t.memberExpression(t.identifier("Object"), t.identifier("assign")),
                    [t.identifier("globalThis"), t.identifier(alias)]
                )
            )
        ]
    })

    const importNodes = [...imports.entries()].map(([name, source]) =>
        t.importDeclaration(parseSpecifiers(name), t.stringLiteral(source))
    )

    const existingImports = ast.program.body.filter(n => t.isImportDeclaration(n))

    const exportDeclarations = ast.program.body.filter(n =>
        t.isExportNamedDeclaration(n) ||
        t.isExportDefaultDeclaration(n) ||
        t.isExportAllDeclaration(n)
    )

    const exportedNames = new Set()
    for (const node of exportDeclarations) {
        if (t.isExportNamedDeclaration(node) && !node.declaration && node.specifiers) {
            for (const spec of node.specifiers) {
                exportedNames.add(spec.local.name)
            }
        }
    }

    const topLevel = []
    const rest = []

    for (const node of ast.program.body) {
        if (t.isImportDeclaration(node)) continue
        if (t.isExportNamedDeclaration(node) || t.isExportDefaultDeclaration(node) || t.isExportAllDeclaration(node)) continue

        if (
            (t.isFunctionDeclaration(node) || t.isClassDeclaration(node)) &&
            node.id && exportedNames.has(node.id.name)
        ) {
            topLevel.push(node)
        } else {
            rest.push(node)
        }
    }

    const tryBlock = t.tryStatement(
        t.blockStatement(rest),
        t.catchClause(
            t.identifier("__err__"),
            t.blockStatement([
                t.expressionStatement(
                    t.callExpression(
                        t.identifier("__handle_sync_error__"),
                        [t.identifier("__err__")]
                    )
                )
            ])
        )
    )

    ast.program.body = [
        defaultImport,
        ...wildcardNodes,
        ...importNodes,
        ...existingImports,
        ...topLevel,
        ...exportDeclarations,
        tryBlock
    ]

    const { code: output } = generate(ast, { sourceMaps: false }, pre)

    const mapComment = `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(preprocessMap.toString()).toString("base64")
        }`

    return { code: output + mapComment }
}
