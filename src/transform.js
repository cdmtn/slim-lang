import { parse } from "@babel/parser"
import _traverse from "@babel/traverse"
import _generate from "@babel/generator"
import { preprocess } from "./parser.js"
import * as t from "@babel/types"
import { SourceMapConsumer } from "source-map"
import path from "path"

const traverse = _traverse.default ?? _traverse
const generate = _generate.default ?? _generate

function resolvePath(raw, fromFile) {
    const fromDir = path.dirname(fromFile)
    const projectRoot = path.resolve(".")
    const srcRoot = path.resolve("src")
    const absFrom = path.resolve(fromFile)

    function getDistFile(slimAbs) {
        if (slimAbs.startsWith(srcRoot)) {
            const rel = path.relative(srcRoot, slimAbs)
            return path.resolve("dist", rel.replace(/\.slim$/, ".js"))
        }
        const rel = path.relative(projectRoot, slimAbs)
        return path.resolve("dist", rel.replace(/\.slim$/, ".js"))
    }

    function toRelative(from, to) {
        const rel = path.relative(path.dirname(from), to).replace(/\\/g, "/")
        return rel.startsWith(".") ? rel : "./" + rel
    }

    if (raw.startsWith("@slim/")) {
        const rel = raw.replace("@slim/", "")
        const distTarget = path.resolve("dist/lib", rel + ".js")
        const distFrom = getDistFile(absFrom)
        return toRelative(distFrom, distTarget)
    }

    if (raw.endsWith(".js")) {
        return raw
    }

    const slimAbs = path.resolve(fromDir, raw + ".slim")
    const distTarget = getDistFile(slimAbs)
    const distFrom = getDistFile(absFrom)
    return toRelative(distFrom, distTarget)
}

function getDefaultsPath(sourceFile) {
    const projectRoot = path.resolve(".")
    const srcRoot = path.resolve("src")
    const abs = path.resolve(sourceFile)

    let distFile
    if (abs.startsWith(srcRoot)) {
        const rel = path.relative(srcRoot, abs)
        distFile = path.resolve("dist", rel.replace(/\.slim$/, ".js"))
    } else {
        const rel = path.relative(projectRoot, abs)
        distFile = path.resolve("dist", rel.replace(/\.slim$/, ".js"))
    }

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