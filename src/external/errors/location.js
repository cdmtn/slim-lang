// Source frames require a host-provided file reader.
let readSource = null

export function setSourceReader(reader) {
    readSource = typeof reader === "function" ? reader : null
}

let __mappings__ = null
let __sourceFile__ = null

function loadMappings() {
    if (__mappings__) return
    try {
        const data = JSON.parse(readSource(new URL("../../../dist/mappings.json", import.meta.url)))
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

function isInternalFrame(normalized) {
    return (
        normalized.includes("node_modules") ||
        normalized.includes("node:") ||
        normalized.includes("/external/") ||
        normalized.includes("/src/handlers/") ||
        normalized.includes("/src/compile.js") ||
        normalized.includes("/src/transform.js") ||
        normalized.includes("/src/parser.js")
    )
}

export function parseStack(stack, skip = 0) {
    if (!stack) return null

    const frames = []
    for (const line of stack.split("\n")) {
        const match = line.match(/at .+ \((.+):(\d+):(\d+)\)/)
            ?? line.match(/at (.+):(\d+):(\d+)/)

        if (!match) continue

        const [, file, ln, col] = match
        const normalized = file.replace(/^file:\/\/\//, "").replace(/\\/g, "/")

        if (isInternalFrame(normalized)) continue

        frames.push({ file: normalized, line: parseInt(ln), col: parseInt(col) })
    }

    if (frames.length) {
        const slimFrames = frames.filter(f => f.file.endsWith(".slim"))
        const pool = slimFrames.length ? slimFrames : frames
        const frame = pool[Math.min(skip, pool.length - 1)]
        if (frame.file.endsWith("/dist/output.js")) {
            const resolved = resolveOriginalLine(frame.line)
            return { file: resolved.file ?? frame.file, line: resolved.line, col: frame.col }
        }
        return frame
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

export function getSourceLine(file, line) {
    if (!readSource) return null

    try {
        const content = readSource(file.replace(/\\/g, "/"))
        return content?.split("\n")[line - 1]?.replace(/\r$/, "") ?? null
    } catch {
        return null
    }
}

export function resolveErrorLocation(err) {
    if (err?.file && err?.line) {
        return {
            file: err.file,
            line: err.line,
            col: err.col ?? null,
            sourceLine: err.sourceLine ?? getSourceLine(err.file, err.line),
            length: err.length ?? 1
        }
    }

    const loc = parseStack(err?.stack)
    if (!loc) return null

    return {
        file: loc.file,
        line: loc.line,
        col: loc.col ?? null,
        sourceLine: getSourceLine(loc.file, loc.line),
        length: err?.length ?? 1
    }
}

