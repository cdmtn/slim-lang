import { diagnosticDetails } from "./hints.js"
import { resolveErrorLocation } from "./location.js"

// Accepts the original positional API or an error/diagnostic plus host options.
export function formatError(tag, message, file, line, col, sourceLine, options = {}) {
    let meta = options
    if (tag && typeof tag === "object") {
        const err = tag
        options = message ?? {}
        const loc = resolveErrorLocation(err)
        tag = err.tag ?? err.name ?? "Error"
        message = err.message ?? String(err)
        file = loc?.file
        line = loc?.line
        col = loc?.col
        sourceLine = loc?.sourceLine
        meta = { ...err, ...options }
    }
    const { code, hint } = diagnosticDetails({ ...meta, tag, message })
    const tty = options.tty ?? (typeof process !== "undefined" && process.stderr?.isTTY === true)
    const env = options.env ?? (typeof process !== "undefined" ? process.env : {})
    const color = tty && !Object.hasOwn(env ?? {}, "NO_COLOR")
    const paint = (text, ansi) => color ? `\x1b[${ansi}m${text}\x1b[0m` : text
    const parts = [tty
        ? `\n${paint(`error[${code}]`, "1;31")}: ${tag}: ${message}`
        : `\n${tag}: ${message}`]

    if (file && line) {
        parts.push(tty
            ? ` ${paint("-->", "1;34")} ${file}:${line}:${col ?? 1}`
            : `    at ${file}:${line}:${col ?? 1}`)
    }

    if (sourceLine !== null && sourceLine !== undefined) {
        const trimmed = sourceLine.trim()
        const indent = sourceLine.search(/\S/)
        const pointer = col
            ? " ".repeat(Math.max(0, col - Math.max(0, indent) - 1)) + "^".repeat(Math.max(1, meta.length ?? 1))
            : "^"

        if (tty) {
            const width = String(line ?? 1).length
            const gutter = paint("|", "1;34")
            parts.push(`${" ".repeat(width + 1)}${gutter}`)
            parts.push(`${paint(String(line ?? 1), "1;34")} ${gutter} ${trimmed}`)
            parts.push(`${" ".repeat(width + 1)}${gutter} ${paint(pointer, "1;31")}`)
        } else {
            parts.push(`\n  ${trimmed}`)
            parts.push(`  ${pointer}`)
        }
    }

    if (!tty) parts.push(`    error[${code}]`)
    if (hint) parts.push(`    ${paint("help:", "1;36")} ${hint}`)
    parts.push(`    For more information: slmc explain ${code}`)
    parts.push("")
    return parts.join("\n")
}

