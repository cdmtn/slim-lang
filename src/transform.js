import _traverse from "@babel/traverse"
import _generate from "@babel/generator"
import { parseProgram } from "./syntax/index.js"
import { emitJsDoc, emitDeclarations, jsdocComment } from "./jsdoc.js"
import { checkTypes, formatDiagnostics } from "./checker.js"
import { compileReactivity, reactiveExports } from "./reactivity.js"
import { readType, formatType, referenceName } from "./external/typeSyntax.js"
import * as t from "@babel/types"
import path from "node:path"
import { getDistPath, resolveSlimImport, resolveSlimSource, distDirName } from "./modulePaths.js"

const traverse = _traverse.default ?? _traverse
const generate = _generate.default ?? _generate

function isRuntimeCall(node, name) {
    return t.isCallExpression(node) && t.isIdentifier(node.callee, { name })
}

const BUILTIN_TYPE_NAMES = new Set([
    "int", "float", "number", "string", "bool", "null", "undefined",
    "object", "array", "function", "any", "element"
])

function buildTypeSpec(typeText, path_, importedNames = new Set()) {
    const type = readType(typeText)
    const parts = type.kind === "union" || type.kind === "intersection" ? type.types : [type]

    const refs = parts.map(part => {
        const name = referenceName(part)
        const binding = name ? path_.scope.getBinding(name) : null
        const args = [t.stringLiteral(formatType(part))]

        if ((binding || importedNames.has(name)) && !BUILTIN_TYPE_NAMES.has(name)) {
            args.push(t.arrowFunctionExpression([], t.identifier(name)))
        }

        return t.callExpression(t.identifier("__type_ref__"), args)
    })

    const combinator = type.kind === "intersection" ? "__type_spec_all__" : "__type_spec__"
    return t.callExpression(t.identifier(combinator), refs)
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

const UNWRAPPED_IN_RELEASE = new Set(["__typed_variable__", "__typed_pattern__"])
const REMOVED_IN_RELEASE = new Set(["__typed_parameter__", "__declare_return__"])

function stripRuntimeChecks(ast) {
    traverse(ast, {
        ExpressionStatement(path_) {
            const call = path_.node.expression
            if (t.isCallExpression(call) && t.isIdentifier(call.callee) && REMOVED_IN_RELEASE.has(call.callee.name)) {
                path_.remove()
            }
        },
        CallExpression(path_) {
            const { callee, arguments: args } = path_.node
            if (t.isIdentifier(callee) && UNWRAPPED_IN_RELEASE.has(callee.name) && args[0]) {
                path_.replaceWith(args[0])
            }
        }
    })
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

        ExpressionStatement(path_) {
            const call = path_.node.expression
            if (!isRuntimeCall(call, "__declare_return__")) return

            const [label, owner] = call.arguments
            const fn = path_.getFunctionParent()
            if (!t.isStringLiteral(label) || !fn) { path_.remove(); return }

            const specification = buildTypeSpec(label.value, path_, importedNames)
            const fnName = t.isStringLiteral(owner) ? owner.value : "function"

            fn.traverse({
                Function(inner) { inner.skip() },
                ReturnStatement(statement) {
                    statement.node.argument = t.callExpression(t.identifier("__typed_return__"), [
                        statement.node.argument ?? t.identifier("undefined"),
                        t.cloneNode(specification),
                        t.stringLiteral(fnName)
                    ])
                }
            })

            path_.remove()
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
        return binding ? value => buildTypedCheck(binding, value) : null
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
}

function getRuntimePath(distFile, entry) {
    const runtimeAbs = path.resolve(distDirName(), "external", entry)
    const rel = path.relative(path.dirname(distFile), runtimeAbs)
    const relFixed = rel.replace(/\\/g, "/")
    return relFixed.startsWith(".") ? relFixed : "./" + relFixed
}

const DOM_RUNTIME = new Set([
    "htmlToVdom", "HTMLElement", "__html__",
    "__flush_events__", "__bind_events__", "__lifecycle__",
    "__create_host__", "__adopt_into__", "__define_element__",
    "__template__", "__insert__", "__once__", "__root__", "__list__", "__attr__", "__set__", "__on__", "__spread__", "__branch__", "__enter__", "__leave__", "__child__", "__next__", "__move__", "Router", "Link", "Portal", "navigate", "route"
])

function usesDom(ast) {
    let found = false

    traverse(ast, {
        Identifier(path_) {
            if (!DOM_RUNTIME.has(path_.node.name)) return
            found = true
            path_.stop()
        }
    })

    return found
}

function parseSpecifiers(name, bareIsDefault = true) {
    const trimmed = name.trim()

    const namespaceMatch = trimmed.match(/^\*\s+as\s+([\w$]+)$/)
    if (namespaceMatch) {
        return [t.importNamespaceSpecifier(t.identifier(namespaceMatch[1]))]
    }

    if (trimmed.startsWith("{")) {
        const inner = trimmed.replace(/[{}]/g, "").trim()
        return inner.split(",").filter(part => part.trim()).map(part => {
            const aliasParts = part.trim().split(/\s+as\s+/)
            const imported = aliasParts[0].trim()
            const local = (aliasParts[1] ?? aliasParts[0]).trim()
            return t.importSpecifier(t.identifier(local), t.identifier(imported))
        })
    }

    const aliasMatch = trimmed.match(/^([\w$]+)\s+as\s+([\w$]+)$/)
    if (aliasMatch) {
        return [t.importSpecifier(t.identifier(aliasMatch[2]), t.identifier(aliasMatch[1]))]
    }

    if (!bareIsDefault) {
        return [t.importSpecifier(t.identifier(trimmed), t.identifier(trimmed))]
    }

    return [t.importDefaultSpecifier(t.identifier(trimmed))]
}

function formatSyntaxError(err, originalCode, sourceFile) {
    const loc = err.loc
    const atEnd = typeof err.pos === "number" && err.pos >= originalCode.trimEnd().length
    let message = err.slimMessage ??
        (atEnd ? "Unexpected end of file: a bracket or block is not closed" : err.message.replace(/\s*\(\d+:\d+\)$/, ""))

    if (!err.slimMessage && !atEnd && message.startsWith("Unexpected token") && typeof err.pos === "number") {
        const token = /^(?:[\w$]+|\S)/.exec(originalCode.slice(err.pos))?.[0]
        if (token) message = message.replace("Unexpected token", `Unexpected "${token}"`)
    }

    if (!loc) {
        const e = new Error(`SyntaxError: ${message}`)
        e.slimSyntaxError = true
        throw e
    }

    const line = loc.line
    const column = loc.column + 1
    const sourceLine = (originalCode.split("\n")[line - 1] ?? "").replace(/\r$/, "")
    const indent = sourceLine.length - sourceLine.trimStart().length
    const pointer = " ".repeat(Math.max(0, column - 1 - indent)) + "^"

    const e = new Error([
        `SyntaxError: ${message}`,
        `    at ${sourceFile}:${line}:${column}`,
        "",
        `  ${sourceLine.trim()}`,
        `  ${pointer}`,
    ].join("\n"))
    e.slimSyntaxError = true
    throw e
}

function isAsyncFunctionBinding(binding) {
    const node = binding?.path.node
    if (t.isFunctionDeclaration(node)) return node.async
    return t.isVariableDeclarator(node) && t.isFunction(node.init) && node.init.async
}

function callsAsyncFunction(path_, call) {
    return t.isCallExpression(call) && t.isIdentifier(call.callee) &&
        isAsyncFunctionBinding(path_.scope.getBinding(call.callee.name))
}

function isExport(node) {
    return t.isExportNamedDeclaration(node) || t.isExportDefaultDeclaration(node) || t.isExportAllDeclaration(node)
}

function catchTopLevel(statements) {
    return t.tryStatement(
        t.blockStatement(statements),
        t.catchClause(t.identifier("__err__"), t.blockStatement([
            t.expressionStatement(t.callExpression(t.identifier("__handle_sync_error__"), [t.identifier("__err__")]))
        ]))
    )
}

function layoutTopLevel(body) {
    const head = []
    const declared = []
    const ordered = []
    const hasExports = body.some(isExport)

    const assign = (target, value) =>
        ordered.push(t.expressionStatement(t.assignmentExpression("=", target, value)))

    const declare = (kind, names, exported) => {
        const declaration = t.variableDeclaration(kind, names.map(name => t.variableDeclarator(t.identifier(name))))
        declared.push(exported ? t.exportNamedDeclaration(declaration, []) : declaration)
    }

    const hoistVariables = (node, exported) => {
        const names = node.declarations.flatMap(declarator => Object.keys(t.getBindingIdentifiers(declarator.id)))
        declare(node.kind === "var" ? "var" : "let", names, exported)
        for (const declarator of node.declarations) {
            if (declarator.init) assign(declarator.id, declarator.init)
        }
    }

    const hoistClass = (node, exported) => {
        declare("let", [node.id.name], exported)
        assign(t.identifier(node.id.name), t.classExpression(node.id, node.superClass, node.body, node.decorators))
    }

    const hoistDefault = node => {
        const declaration = node.declaration
        if (t.isFunctionDeclaration(declaration)) return declared.push(node)

        let local = "__slim_default__"
        if (t.isClassDeclaration(declaration) && declaration.id) {
            local = declaration.id.name
            hoistClass(declaration, false)
        } else {
            declare("let", [local], false)
            assign(t.identifier(local), t.isClassDeclaration(declaration)
                ? t.classExpression(null, declaration.superClass, declaration.body, declaration.decorators)
                : declaration)
        }
        declared.push(t.exportNamedDeclaration(null, [t.exportSpecifier(t.identifier(local), t.identifier("default"))]))
    }

    for (const node of body) {
        if (t.isImportDeclaration(node) || node._slimTypeSlots) head.push(node)
        else if (!hasExports) ordered.push(node)
        else if (t.isFunctionDeclaration(node)) declared.push(node)
        else if (t.isVariableDeclaration(node)) hoistVariables(node, false)
        else if (t.isClassDeclaration(node) && node.id) hoistClass(node, false)
        else if (t.isExportDefaultDeclaration(node)) hoistDefault(node)
        else if (t.isExportNamedDeclaration(node) && t.isVariableDeclaration(node.declaration)) hoistVariables(node.declaration, true)
        else if (t.isExportNamedDeclaration(node) && t.isClassDeclaration(node.declaration)) hoistClass(node.declaration, true)
        else if (isExport(node)) declared.push(node)
        else ordered.push(node)
    }

    return [...head, ...declared, catchTopLevel(ordered)]
}

export function transform(code, sourceFile = "input.slim", options = {}) {
    const outFile = options.outFile ?? getDistPath(sourceFile)
    const bareIsDefault = options.uses !== "named" && options.uses !== "legacy"
    const imports = new Map()
    const wildcards = []
    const specifierSources = []

    let ast
    try {
        ast = parseProgram(code, sourceFile)
    } catch (err) {
        if (err.code === "BABEL_PARSER_SYNTAX_ERROR") formatSyntaxError(err, code, sourceFile)
        throw err
    }

    traverse(ast, {
        CallExpression(path_) {
            const callee = path_.node.callee

            if (t.isIdentifier(callee) && callee.name === "__use_all__") {
                const [sourceNode] = path_.node.arguments
                if (!t.isStringLiteral(sourceNode)) return
                wildcards.push(resolveSlimImport(sourceNode.value, sourceFile, outFile))
                specifierSources.push({ spec: null, raw: sourceNode.value })
                path_.remove()
                return
            }

            if (t.isIdentifier(callee) && callee.name === "__use__") {
                const [nameNode, sourceNode] = path_.node.arguments
                if (!t.isStringLiteral(nameNode) || !t.isStringLiteral(sourceNode)) return
                imports.set(nameNode.value, resolveSlimImport(sourceNode.value, sourceFile, outFile))
                specifierSources.push({ spec: nameNode.value, raw: sourceNode.value })
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
            const isVoid = t.isUnaryExpression(expr, { operator: "void" })
            const call = isVoid ? expr.argument : expr
            if (!callsAsyncFunction(path_, call)) return

            const handled = t.callExpression(t.memberExpression(call, t.identifier("catch")), [t.identifier("__handle_async_error__")])
            if (isVoid) expr.argument = handled
            else path_.node.expression = handled
        }
    })

    if (options.check !== false) {
        const moduleImports = []
        const moduleWildcards = []

        for (const { spec, raw } of specifierSources) {
            const slimSource = resolveSlimSource(raw, sourceFile)
            if (!slimSource) continue

            if (spec === null) {
                moduleWildcards.push(slimSource)
                continue
            }

            for (const specifier of parseSpecifiers(spec)) {
                if (!t.isImportSpecifier(specifier)) continue
                moduleImports.push({
                    local: specifier.local.name,
                    imported: t.isIdentifier(specifier.imported)
                        ? specifier.imported.name
                        : specifier.imported.value,
                    source: slimSource
                })
            }
        }

        const diagnostics = checkTypes(ast, {
            originalCode: code,
            sourceFile,
            imports: moduleImports,
            wildcards: moduleWildcards,
            locals: [...imports.keys()].flatMap(name => parseSpecifiers(name, bareIsDefault).map(specifier => specifier.local.name)),
            openGlobals: wildcards.length > 0
        })
        if (diagnostics.length > 0) {
            const error = new Error(formatDiagnostics(diagnostics))
            error.slimTypeErrors = diagnostics
            throw error
        }
    }

    const importedNames = new Set()
    for (const name of imports.keys()) {
        for (const specifier of parseSpecifiers(name, bareIsDefault)) {
            importedNames.add(specifier.local.name)
        }
    }
    const declarations = options.declarations ? emitDeclarations(ast) : null
    const typedefs = options.jsdoc ? emitJsDoc(ast) : []

    if (options.release) stripRuntimeChecks(ast)
    instrumentRuntimeTypes(ast, sourceFile, importedNames)
    const importedReactive = new Map()
    for (const { spec, raw } of specifierSources) {
        const slimSource = resolveSlimSource(raw, sourceFile)
        const exported = slimSource ? reactiveExports(slimSource) : null
        if (!exported?.size) continue
        if (spec === null) {
            for (const [name, kind] of exported) importedReactive.set(name, kind)
            continue
        }
        for (const specifier of parseSpecifiers(spec, bareIsDefault)) {
            if (!t.isImportSpecifier(specifier)) continue
            const imported = t.isIdentifier(specifier.imported) ? specifier.imported.name : specifier.imported.value
            if (exported.has(imported)) importedReactive.set(specifier.local.name, exported.get(imported))
        }
    }

    try {
        compileReactivity(ast, code, { sourceFile, importedReactive })
    } catch (err) {
        if (err.code === "BABEL_PARSER_SYNTAX_ERROR") formatSyntaxError(err, code, sourceFile)
        throw err
    }

    const runtimePath = getRuntimePath(outFile, usesDom(ast) ? "defaults.js" : "core.js")
    const defaultImport = t.importDeclaration([], t.stringLiteral(runtimePath))

    if (options.jsdoc) {
        if (typedefs.length > 0) {
            t.addComment(defaultImport, "leading", jsdocComment(typedefs), false)
        }
        t.addComment(defaultImport, "leading", " @ts-check", true)
    }

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
        t.importDeclaration(parseSpecifiers(name, bareIsDefault), t.stringLiteral(source))
    )

    ast.program.body = [
        defaultImport,
        ...wildcardNodes,
        ...importNodes,
        ...layoutTopLevel(ast.program.body)
    ]

    const { code: output, map } = generate(ast, { sourceMaps: true, sourceFileName: sourceFile }, code)
    const mapComment = `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`

    return { code: output + mapComment, declarations }
}
