import _traverse from "@babel/traverse"
import _generate from "@babel/generator"
import { parseProgram, findUses } from "./syntax/index.js"
import { emitJsDoc, emitDeclarations, jsdocComment } from "./jsdoc.js"
import { checkTypes, formatDiagnostics } from "./checker.js"
import { compileReactivity, reactiveImports, slimModuleTarget } from "./reactivity.js"
import * as t from "@babel/types"
import fs from "node:fs"
import path from "node:path"
import { getDistPath, resolveSlimImport, resolveSlimSource } from "./modulePaths.js"
import { autoImportsFor } from "./autoImport.js"
import * as RUNTIME_CORE from "./external/runtime-core.js"
import * as RUNTIME_DOM from "./external/runtime-dom.js"
import { TEST_NAMES, isRuntimeCall, structAssignments } from "./transform/typeSpecs.js"
import { stripRuntimeChecks } from "./transform/release.js"
import { instrumentRuntimeTypes } from "./transform/instrument.js"
import { RENAMED_BUILTINS, getRuntimePath, renameBuiltins, runtimeReferences, usesDom } from "./transform/runtime.js"
import { formatSyntaxError } from "./transform/syntaxErrors.js"
import { markProvenReturns } from "./transform/proven.js"
import { hostImports } from "./transform/host.js"
import { shareTraits } from "./transform/traits.js"
import { BUILD_FLAGS, applyBuildFlags } from "./transform/buildFlags.js"
import { dropPlainStructCasts, typeScopes } from "./transform/structs.js"
import { callsAsyncFunction, layoutTopLevel } from "./transform/topLevel.js"
import { globalsOf, rememberGlobals, rewriteGlobals } from "./transform/globals.js"

const traverse = _traverse.default ?? _traverse
const generate = _generate.default ?? _generate

function parseSpecifiers(name, bareIsDefault = true) {
    if (name.startsWith("#")) return []
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

const hostStamps = new Map()

function loadHost(host, options) {
    if (!fs.existsSync(host)) throw new Error(`The host file "${host}" was not found - check "host" in slimconfig.json`)
    const { mtimeMs } = fs.statSync(host)
    if (hostStamps.get(host) === mtimeMs) return
    hostStamps.delete(host)
    transform(fs.readFileSync(host, "utf8"), host, { ...options, host: null, outFile: undefined, warnings: false })
    hostStamps.set(host, mtimeMs)
}

export function transform(code, sourceFile = "input.slim", options = {}) {
    const outFile = options.outFile ?? getDistPath(sourceFile)
    const bareIsDefault = options.uses !== "named" && options.uses !== "legacy"
    const imports = new Map()
    const wildcards = []
    const specifierSources = []
    const declared = []
    const hostFile = options.host ? path.resolve(options.host.endsWith(".slim") ? options.host : options.host + ".slim") : null
    const host = hostFile === path.resolve(sourceFile) ? null : hostFile

    let ast
    try {
        ast = parseProgram(code, sourceFile)
    } catch (err) {
        if (err.code === "BABEL_PARSER_SYNTAX_ERROR") formatSyntaxError(err, code, sourceFile)
        throw err
    }

    const slimModule = raw => {
        const found = slimModuleTarget(raw, sourceFile)
        return found ? resolveSlimImport(found.target, sourceFile, outFile) + found.suffix : null
    }
    const useSource = raw => slimModule(raw) ?? resolveSlimImport(raw, sourceFile, outFile)
    const moduleSource = source => {
        if (t.isStringLiteral(source)) source.value = slimModule(source.value) ?? source.value
    }

    traverse(ast, {
        "ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration"(path_) {
            moduleSource(path_.node.source)
        },

        CallExpression(path_) {
            const callee = path_.node.callee

            if (t.isImport(callee)) {
                const [source] = path_.node.arguments
                if (t.isTemplateLiteral(source) && source.expressions.length === 0) {
                    path_.node.arguments[0] = t.stringLiteral(source.quasis[0].value.cooked)
                }
                moduleSource(path_.node.arguments[0])
                return
            }

            if (t.isIdentifier(callee) && callee.name === "__declare_value__") {
                declared.push(path_.node.arguments.map(argument => argument.value))
                path_.remove()
                return
            }

            if (t.isIdentifier(callee) && callee.name === "__use_all__") {
                const [sourceNode] = path_.node.arguments
                if (!t.isStringLiteral(sourceNode)) return
                wildcards.push(useSource(sourceNode.value))
                specifierSources.push({ spec: null, raw: sourceNode.value })
                path_.remove()
                return
            }

            if (t.isIdentifier(callee) && callee.name === "__use__") {
                const [nameNode, sourceNode] = path_.node.arguments
                if (!t.isStringLiteral(nameNode) || !t.isStringLiteral(sourceNode)) return
                const source = useSource(sourceNode.value)
                imports.set(/^\{\s*\}$/.test(nameNode.value) ? "#" + source : nameNode.value, source)
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

    rememberGlobals(path.resolve(sourceFile), declared)

    if (host) {
        loadHost(host, options)
        const raw = "./" + path.relative(path.dirname(path.resolve(sourceFile)), host).replace(/\\/g, "/").replace(/\.slim$/, "")
        imports.set("{}", resolveSlimImport(raw, sourceFile, outFile))
    }

    const autoWarnings = []
    const sideImports = []
    if (options.autoImport) {
        const taken = new Set([...imports.keys()].flatMap(name => parseSpecifiers(name, bareIsDefault).map(specifier => specifier.local.name)))
        for (const found of autoImportsFor(ast, sourceFile, options.autoImport, taken, { code, warnings: autoWarnings })) {
            if (found.sideEffect) {
                sideImports.push(resolveSlimImport(found.raw, sourceFile, outFile))
                continue
            }
            const spec = `{ ${found.names.join(", ")} }`
            imports.set(spec, resolveSlimImport(found.raw, sourceFile, outFile))
            specifierSources.push({ spec, raw: found.raw })
        }
    }

    let warnings = []
    let checkedEnv = null
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

        const useLocations = findUses(code).filter(use => use.spec !== null).map(use => ({
            start: use.start,
            names: parseSpecifiers(use.spec, bareIsDefault).map(specifier => specifier.local.name)
        }))
        const diagnostics = checkTypes(ast, {
            warnings: options.warnings !== false,
            useLocations,
            originalCode: code,
            sourceFile,
            imports: moduleImports,
            wildcards: moduleWildcards,
            locals: [...imports.keys()].flatMap(name => parseSpecifiers(name, bareIsDefault).map(specifier => specifier.local.name)),
            globals: options.test ? [...(options.globals ?? []), ...TEST_NAMES] : options.globals ?? [],
            host,
            declared: [...declared, ...BUILD_FLAGS.map(name => [name, "bool"])],
            openGlobals: wildcards.length > 0,
            environment: options.env ?? null,
            inspect: env => {
                checkedEnv = env
                markProvenReturns(ast, env)
            }
        })
        const errors = diagnostics.filter(diagnostic => diagnostic.severity === "error")
        warnings = diagnostics.filter(diagnostic => diagnostic.severity === "warning")
        if (errors.length > 0) {
            const error = new Error(formatDiagnostics(errors))
            error.slimTypeErrors = errors
            error.slimWarnings = warnings
            throw error
        }
    }

    if (options.warnings !== false && autoWarnings.length > 0) warnings = [...autoWarnings, ...warnings]

    rewriteGlobals(ast, new Set([...declared.map(([name]) => name), ...globalsOf(host)]))

    applyBuildFlags(ast, options.release === true)

    const importedNames = new Set()
    for (const name of imports.keys()) {
        for (const specifier of parseSpecifiers(name, bareIsDefault)) {
            importedNames.add(specifier.local.name)
        }
    }
    const declarations = options.declarations ? emitDeclarations(ast) : null
    const typedefs = options.jsdoc ? emitJsDoc(ast) : []

    structAssignments(ast)
    if (options.release) {
        stripRuntimeChecks(ast)
        const sources = [host, ...specifierSources.map(({ raw }) => resolveSlimSource(raw, sourceFile))]
        dropPlainStructCasts(ast, typeScopes({ env: checkedEnv, ast, sources }))
    }
    instrumentRuntimeTypes(ast, sourceFile, importedNames)
    traverse(ast, {
        CallExpression(path_) {
            if (!isRuntimeCall(path_.node, "__isolated_body__")) return
            const fn = path_.get("arguments.0")
            const helpers = new Set()
            fn.traverse({
                ReferencedIdentifier(ref) {
                    const binding = ref.scope.getBinding(ref.node.name)
                    if (binding && (binding.scope === fn.scope || binding.scope.path.isDescendant(fn))) return
                    const renamed = RENAMED_BUILTINS[ref.node.name]
                    if (renamed && !importedNames.has(ref.node.name)) ref.node.name = renamed
                    if (ref.node.name in RUNTIME_DOM || ref.node.name in RUNTIME_CORE) helpers.add(ref.node.name)
                }
            })
            const names = [...helpers].sort()
            path_.replaceWith(t.stringLiteral(generate(t.program(fn.node.body.body), { compact: true }).code))
            path_.skip()
            const construct = path_.parentPath
            const invoke = construct.parentPath
            if (names.length === 0 || !construct.isNewExpression() || !invoke.isCallExpression()) return
            const [binding] = construct.node.arguments
            if (t.isStringLiteral(binding, { value: "" })) binding.value = "__props__"
            construct.node.arguments.splice(construct.node.arguments.length - 1, 0, ...names.map(name => t.stringLiteral(name)))
            invoke.node.arguments.push(...names.map(name => t.identifier(name)))
        }
    })
    const { values: importedReactive, readers: importedReaders } = reactiveImports(specifierSources, sourceFile, { bareIsDefault })

    try {
        compileReactivity(ast, code, { sourceFile, importedReactive, importedReaders })
    } catch (err) {
        if (err.code === "BABEL_PARSER_SYNTAX_ERROR") formatSyntaxError(err, code, sourceFile)
        throw err
    }

    renameBuiltins(ast, importedNames)

    const runtimeImports = options.runtime === "imports"
    const runtimePath = getRuntimePath(outFile, runtimeImports ? "runtime-core.js" : usesDom(ast) ? "defaults.js" : "core.js")
    const defaultImport = t.importDeclaration([], t.stringLiteral(runtimePath))

    if (options.jsdoc) {
        if (typedefs.length > 0) {
            const groups = []
            let pending = []
            for (const line of typedefs) {
                pending.push(line)
                if (!line.startsWith("@template")) {
                    groups.push(pending)
                    pending = []
                }
            }
            for (const group of groups) t.addComment(defaultImport, "leading", jsdocComment(group), false)
        }
        t.addComment(defaultImport, "leading", " @ts-check", true)
    }

    if (host) {
        const named = hostImports(ast, host, sourceFile, importedNames)
        if (named) {
            const entries = [...imports.entries()].flatMap(([spec, source]) => spec !== "{}" ? [[spec, source]] : [...named].map(([file, names]) => {
                for (const name of names) importedNames.add(name)
                const raw = "./" + path.relative(path.dirname(path.resolve(sourceFile)), file).replace(/\\/g, "/").replace(/\.slim$/, "")
                return [`{ ${names.join(", ")} }`, resolveSlimImport(raw, sourceFile, outFile)]
            }))
            imports.clear()
            for (const [spec, source] of entries) imports.set(spec, source)
        }
    }

    if (options.release) shareTraits(ast, importedNames)

    const wildcardAliases = new Set()
    const wildcardNodes = wildcards.flatMap((source) => {
        const base = "__" + source.replace(/[^a-zA-Z0-9]/g, "_").replace(/^_+|_+$/g, "")
        let alias = base + "__"
        for (let n = 2; wildcardAliases.has(alias); n++) alias = `${base}_${n}__`
        wildcardAliases.add(alias)

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
    ).concat(sideImports.map(source => t.importDeclaration([], t.stringLiteral(source))))

    ast.program.body = [
        defaultImport,
        ...wildcardNodes,
        ...importNodes,
        ...layoutTopLevel(ast.program.body)
    ]

    if (runtimeImports) {
        const names = runtimeReferences(ast)
        defaultImport.specifiers = names.map(name => t.importSpecifier(t.identifier(name), t.identifier(name)))
        if (names.some(name => !(name in RUNTIME_CORE))) defaultImport.source = t.stringLiteral(getRuntimePath(outFile, "runtime-dom.js"))
    }

    const sourceMaps = options.sourceMaps ?? "inline"
    if (sourceMaps === false || sourceMaps === "none") {
        return { code: generate(ast, {}, code).code, declarations, warnings, map: null }
    }
    const { code: output, map } = generate(ast, { sourceMaps: true, sourceFileName: sourceFile }, code)
    if (sourceMaps === "file") {
        return { code: `${output}\n//# sourceMappingURL=${path.basename(outFile)}.map`, declarations, warnings, map }
    }
    const mapComment = `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`
    return { code: output + mapComment, declarations, warnings, map: null }
}
