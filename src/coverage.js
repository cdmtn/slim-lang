import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const DIGITS = new Map([...BASE64].map((char, index) => [char, index]))

function decodeSegment(text) {
    const values = []
    let value = 0
    let shift = 0
    for (const char of text) {
        const digit = DIGITS.get(char)
        if (digit === undefined) return values
        value += (digit & 31) << shift
        if (digit & 32) {
            shift += 5
            continue
        }
        values.push(value & 1 ? -(value >>> 1) : value >>> 1)
        value = 0
        shift = 0
    }
    return values
}

function decodeMappings(mappings) {
    const segments = []
    let source = 0
    let originalLine = 0
    let originalColumn = 0
    mappings.split(";").forEach((line, generatedLine) => {
        let generatedColumn = 0
        for (const part of line.split(",")) {
            if (!part) continue
            const values = decodeSegment(part)
            generatedColumn += values[0]
            if (values.length < 4) continue
            source += values[1]
            originalLine += values[2]
            originalColumn += values[3]
            segments.push({ generatedLine, generatedColumn, source, originalLine })
        }
    })
    return segments
}

function inlineMap(code) {
    const match = code.match(/\/\/# sourceMappingURL=data:application\/json(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=]+)\s*$/)
    if (!match) return null
    try {
        return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"))
    } catch {
        return null
    }
}

function countAt(functions, offset) {
    let best = null
    for (const fn of functions) {
        for (const range of fn.ranges) {
            if (offset < range.startOffset || offset >= range.endOffset) continue
            if (!best || range.endOffset - range.startOffset <= best.endOffset - best.startOffset) best = range
        }
    }
    return best ? best.count : 1
}

function loadScripts(dir) {
    const scripts = new Map()
    if (!fs.existsSync(dir)) return scripts
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".json")) continue
        let report
        try {
            report = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))
        } catch {
            continue
        }
        for (const script of report.result ?? []) {
            if (!script.url.startsWith("file:")) continue
            const previous = scripts.get(script.url)
            if (previous) previous.push(...script.functions)
            else scripts.set(script.url, [...script.functions])
        }
    }
    return scripts
}

export function collectCoverage(dir, { include = () => true } = {}) {
    const files = new Map()
    for (const [url, functions] of loadScripts(dir)) {
        let file
        try {
            file = fileURLToPath(url)
        } catch {
            continue
        }
        if (!fs.existsSync(file)) continue
        const code = fs.readFileSync(file, "utf8")
        const map = inlineMap(code)
        if (!map?.sources?.length) continue

        const lineStarts = [0]
        for (let index = 0; index < code.length; index++) if (code[index] === "\n") lineStarts.push(index + 1)

        for (const segment of decodeMappings(map.mappings)) {
            const source = map.sources[segment.source]
            if (!source?.endsWith(".slim")) continue
            const resolved = path.resolve(path.dirname(file), map.sourceRoot ?? "", source)
            if (!include(resolved)) continue
            const offset = (lineStarts[segment.generatedLine] ?? 0) + segment.generatedColumn
            const lines = files.get(resolved) ?? new Map()
            const hit = countAt(functions, offset) > 0
            lines.set(segment.originalLine + 1, (lines.get(segment.originalLine + 1) ?? false) || hit)
            files.set(resolved, lines)
        }
    }
    return files
}

function ranges(numbers) {
    const parts = []
    let start = null
    let previous = null
    for (const number of numbers) {
        if (start !== null && number === previous + 1) {
            previous = number
            continue
        }
        if (start !== null) parts.push(start === previous ? `${start}` : `${start}-${previous}`)
        start = previous = number
    }
    if (start !== null) parts.push(start === previous ? `${start}` : `${start}-${previous}`)
    return parts.join(", ")
}

export function formatCoverage(files, root = process.cwd()) {
    const rows = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([file, lines]) => {
        const total = lines.size
        const covered = [...lines.values()].filter(Boolean).length
        const missed = [...lines].filter(([, hit]) => !hit).map(([line]) => line).sort((a, b) => a - b)
        return { name: path.relative(root, file) || file, percent: total ? (covered / total) * 100 : 100, missed: ranges(missed), covered, total }
    })
    if (rows.length === 0) return "No coverage data for .slim files"
    const all = rows.reduce((sum, row) => ({ covered: sum.covered + row.covered, total: sum.total + row.total }), { covered: 0, total: 0 })
    const width = Math.max(4, ...rows.map(row => row.name.length))
    const line = (name, percent, missed) => `${name.padEnd(width)} | ${percent.padStart(7)} | ${missed}`
    return [
        line("File", "Lines", "Uncovered lines"),
        "-".repeat(width + 30),
        ...rows.map(row => line(row.name, `${row.percent.toFixed(1)}%`, row.missed)),
        "-".repeat(width + 30),
        line("All files", `${(all.total ? (all.covered / all.total) * 100 : 100).toFixed(1)}%`, "")
    ].join("\n")
}
