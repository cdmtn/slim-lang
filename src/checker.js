import path from "node:path"
import { collect } from "./checker/collect.js"
import { createEnvironment } from "./checker/core.js"
import { buildModuleTypes, localTypeNames, missingImports, moduleTypes, seedHost, seedImports } from "./checker/modules.js"
import { didYouMean } from "./suggest.js"
import { readType } from "./external/typeSyntax.js"
import { verify } from "./checker/verify.js"
import { checkWarnings } from "./checker/warnings.js"

export { createEnvironment, accepts } from "./checker/core.js"
export { infer } from "./checker/infer.js"
export { exportModuleTypes, importModuleTypes } from "./checker/modules.js"

function computeLineStarts(text) {
    const starts = [0]
    for (let i = 0; i < text.length; i++) {
        if (text[i] === "\n") starts.push(i + 1)
    }
    return starts
}

function offsetToLineCol(offset, lineStarts) {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (lineStarts[mid] <= offset) lo = mid
        else hi = mid - 1
    }
    return { line: lo, column: offset - lineStarts[lo] }
}

export function checkTypes(ast, {
    originalCode, sourceFile, imports = [], wildcards = [], locals = [], globals = [], openGlobals = false, warnings = false, useLocations = [],
    host = null, declared = [], inspect = null, environment = null
}) {
    const env = createEnvironment()
    env.environment = environment
    env.code = originalCode
    env.sourceFile = sourceFile
    env.importedLocals = new Set([...locals, ...globals])
    for (const name of locals) if (env.enums.get(name)?.builtin) env.enums.delete(name)
    env.openGlobals = openGlobals
    const diagnostics = []
    const originalLines = computeLineStarts(originalCode)
    const sourceLines = originalCode.split("\n")
    const reported = new Set()

    const diagnose = severity => (node, message) => {
        const offset = typeof node.start === "number" ? node.start : 0
        const key = `${offset}:${message}`
        if (reported.has(key)) return
        reported.add(key)

        const location = offsetToLineCol(offset, originalLines)
        diagnostics.push({
            message,
            severity,
            sourceFile,
            line: location.line + 1,
            column: location.column + 1,
            sourceLine: (sourceLines[location.line] ?? "").replace(/\r$/, "")
        })
    }

    const report = diagnose("error")

    const taken = localTypeNames(ast)
    if (host) seedHost(env, host, taken)
    seedImports(env, imports, wildcards, taken)
    for (const [name, label, kind] of declared) {
        env.declaredValues.set(name, readType(label))
        env.importedLocals.add(name)
        if (kind === "const") env.declaredConstants.add(name)
    }
    for (const { local, imported, source, available } of missingImports(imports)) {
        const use = useLocations.find(location => location.names.includes(local))
        report({ start: use?.start ?? 0 }, `"${path.basename(source)}" has no export "${imported}"${didYouMean(imported, available)}`)
    }
    collect(ast, env)
    verify(ast, env, report)
    inspect?.(env)
    if (warnings) checkWarnings(ast, env, diagnose("warning"), useLocations)
    moduleTypes.set(path.resolve(sourceFile), buildModuleTypes(ast, env))

    diagnostics.sort((a, b) => a.line - b.line || a.column - b.column)
    return diagnostics
}

export function formatDiagnostics(diagnostics) {
    return diagnostics.map(({ message, severity, sourceFile, line, column, sourceLine }) => {
        const text = sourceLine.trim()
        const indent = sourceLine.length - sourceLine.trimStart().length
        const pointer = " ".repeat(Math.max(0, column - 1 - indent)) + "^"

        return [
            `${severity === "warning" ? "Warning" : "TypeError"}: ${message}`,
            `    at ${sourceFile}:${line}:${column}`,
            "",
            `  ${text}`,
            `  ${pointer}`
        ].join("\n")
    }).join("\n\n")
}
