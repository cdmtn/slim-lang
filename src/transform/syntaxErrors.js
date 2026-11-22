export function formatSyntaxError(err, originalCode, sourceFile) {
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
