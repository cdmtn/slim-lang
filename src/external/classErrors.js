import fs from "fs"
import path from "path"

let __mappings__ = null
let __sourceFile__ = null

function loadMappings() {
    if (__mappings__) return
    try {
        const data = JSON.parse(
            fs.readFileSync(
                new URL("../../dist/mappings.json", import.meta.url),
                "utf8"
            )
        )
        __mappings__ = data.mappings
        __sourceFile__ = data.sourceFile
    } catch {
        __mappings__ = []
    }
}

function resolveOriginalLine(generatedLine) {
    loadMappings()
    if (!__mappings__?.length) return { line: generatedLine, file: __sourceFile__ }

    const mapping = __mappings__
        .filter(m => m.generatedLine <= generatedLine)
        .at(-1)

    return {
        line: mapping?.originalLine ?? generatedLine,
        file: __sourceFile__
    }
}

function parseStack(stack) {
    if (!stack) return null

    for (const line of stack.split("\n")) {
        const match = line.match(/at .+ \((.+):(\d+):(\d+)\)/)
            ?? line.match(/at (.+):(\d+):(\d+)/)

        if (!match) continue

        const [, file, ln, col] = match

        if (
            file.includes("node_modules") ||
            file.includes("node:internal") ||
            file.includes("src/defaults") ||
            file.includes("src/errorHandler") ||
            file.includes("src/classErrors") ||
            file.includes("src/handlers") ||
            file.includes("dist/outputs")
        ) continue

        return {
            file: file.replace(/^file:\/\/\//, "").replace(/\\/g, "/"),
            line: parseInt(ln),
            col: parseInt(col)
        }
    }

    for (const line of stack.split("\n")) {
        const match = line.match(/at .+ \((.+dist\/output\.js):(\d+):(\d+)\)/)
            ?? line.match(/at (.+dist\/output\.js):(\d+):(\d+)/)

        if (!match) continue

        const [, , ln, col] = match
        const resolved = resolveOriginalLine(parseInt(ln))

        return {
            file: resolved.file,
            line: resolved.line,
            col: parseInt(col)
        }
    }

    return null
}

function getSourceLine(file, line) {
    try {
        const content = fs.readFileSync(
            file.replace(/\\/g, "/"),
            "utf8"
        )
        return content.split("\n")[line - 1]?.replace(/\r$/, "") ?? null
    } catch {
        return null
    }
}

export function formatError(tag, message, file, line, col, sourceLine) {
    const parts = [`\n${tag}: ${message}`]

    if (file && line) {
        parts.push(`    at ${file}:${line}:${col ?? 1}`)
    }

    if (sourceLine) {
        const trimmed = sourceLine.trim()
        const indent = sourceLine.search(/\S/)
        const pointer = col
            ? " ".repeat(Math.max(0, col - indent - 1)) + "^"
            : "^"

        parts.push(`\n  ${trimmed}`)
        parts.push(`  ${pointer}`)
    }

    parts.push("")
    return parts.join("\n")
}

export class LangError extends Error {
    constructor(message, tag = "Error", meta = {}) {
        super(message)
        this.tag = tag
        this.name = tag

        const loc = parseStack(this.stack)

        this.file = meta.file ?? loc?.file ?? null
        this.line = meta.line ?? loc?.line ?? null
        this.col = meta.col ?? loc?.col ?? null
        this.sourceLine = meta.sourceLine ?? (
            this.file && this.line
                ? getSourceLine(this.file, this.line)
                : null
        )

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor)
        }
    }
}

export class StructError extends LangError {
    constructor(m, meta) { super(m, "StructError", meta) }
}
export class StructPassedError extends LangError {
    constructor(m, meta) { super(m, "StructPassedError", meta) }
}
export class StructExpectError extends LangError {
    constructor(m, meta) { super(m, "StructExpectError", meta) }
}
export class StructResultError extends StructError {
    constructor(m, meta) { super(m, "StructResultError", meta) }
}

export class TypeError_ extends LangError {
    constructor(m, meta) { super(m, "TypeError", meta) }
}
export class RuntimeError extends LangError {
    constructor(m, meta) { super(m, "RuntimeError", meta) }
}

export class ArgumentDeclarationTypeError extends TypeError_ {
    constructor(m, meta) { super(m, "ArgumentDeclarationTypeError", meta) }
}

export class EnumError extends LangError {
    constructor(m, meta) { super(m, "EnumError", meta) }
}

export class UseError extends Error {
    constructor(m, meta) { super(m, "UseError", meta) }
}