import fs from "node:fs"
import { babel } from "./syntax/plugin.js"

const OPENERS = new Set(["{", "(", "[", "${", "#{", "#["])
const CLOSERS = new Set(["}", ")", "]"])
const VERBATIM = new Set(["string", "template", "CommentBlock", "CommentLine", "regexp"])

const VOID_ELEMENTS = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr"
])

const label = token => typeof token.type === "string" ? token.type : token.type.label

function collectMarkup(node, out) {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) return node.forEach(child => collectMarkup(child, out))
    if (node.type === "SlimMarkup") out.push(node)
    for (const [key, value] of Object.entries(node)) {
        if (key !== "loc" && key !== "extra" && value && typeof value === "object") collectMarkup(value, out)
    }
}

function describeMarkup(code, node) {
    const holes = node.expressions.map(expression => {
        const open = code.lastIndexOf("${", expression.start)
        let close = expression.end
        while (close < node.end && code[close] !== "}") close++
        return { start: open, end: close + 1, depth: 0 }
    })

    const changes = []
    let depth = 0
    let inTag = false
    let closing = false
    let tag = ""
    let quote = null
    let hole = 0

    for (let i = node.start; i < node.end; i++) {
        if (hole < holes.length && i === holes[hole].start) {
            holes[hole].depth = depth
            i = holes[hole++].end - 1
            continue
        }
        const c = code[i]
        if (inTag) {
            if (quote) {
                if (c === quote) quote = null
            } else if (c === '"' || c === "'") {
                quote = c
            } else if (c === ">") {
                inTag = false
                if (closing) depth--
                else if (code[i - 1] !== "/" && !VOID_ELEMENTS.has(tag)) depth++
                changes.push({ at: i + 1, depth })
            }
        } else if (c === "<" && code[i + 1] === "/") {
            inTag = true
            closing = true
        } else if (c === "<" && /[A-Za-z]/.test(code[i + 1] ?? "")) {
            inTag = true
            closing = false
            const name = /^[\w:.-]+/.exec(code.slice(i + 1))
            tag = name ? name[0].toLowerCase() : ""
        }
    }

    const depthAt = offset => {
        let current = 0
        for (const change of changes) {
            if (change.at > offset) break
            current = change.depth
        }
        return current
    }

    return { start: node.start, end: node.end, holes, depthAt }
}

function depthsFromSyntax(code) {
    const ast = babel.parse(code, {
        sourceType: "module",
        tokens: true,
        errorRecovery: false,
        plugins: ["typescript", "slim"]
    })

    const markupNodes = []
    collectMarkup(ast.program, markupNodes)
    const markup = markupNodes.map(node => describeMarkup(code, node))

    const inText = (region, offset) =>
        offset >= region.start && offset < region.end && !region.holes.some(hole => offset >= hole.start && offset < hole.end)

    const brackets = ast.tokens.filter(token => {
        const kind = label(token)
        if (!OPENERS.has(kind) && !CLOSERS.has(kind)) return false
        return !markup.some(region => inText(region, token.start) ||
            region.holes.some(hole => token.start === hole.end - 1))
    })

    const templateText = []
    const stack = []
    for (const token of ast.tokens) {
        const kind = label(token)
        if (kind === "`") {
            if (stack.at(-1)?.kind === "template") templateText.push({ start: stack.pop().start, end: token.start })
            else stack.push({ kind: "template", start: token.end })
        } else if (kind === "${" && stack.at(-1)?.kind === "template") {
            templateText.push({ start: stack.at(-1).start, end: token.start + 1 })
            stack.push({ kind: "hole" })
        } else if (kind === "}" && stack.at(-1)?.kind === "hole") {
            stack.pop()
            stack.at(-1).start = token.end
        }
    }
    const inTemplateText = offset => templateText.some(range => offset > range.start && offset < range.end)

    const result = []
    let bracket = 0
    let depth = 0
    let tokenIndex = 0
    let lineStart = 0

    const lines = code.split("\n")
    for (const line of lines) {
        const first = lineStart + (line.length - line.trimStart().length)

        while (bracket < brackets.length && brackets[bracket].start < first) {
            depth += OPENERS.has(label(brackets[bracket])) ? 1 : -1
            bracket++
        }
        while (tokenIndex < ast.tokens.length && ast.tokens[tokenIndex].end <= first) tokenIndex++

        const token = ast.tokens[tokenIndex]
        const insideToken = (token && token.start < first && VERBATIM.has(label(token))) || inTemplateText(lineStart)
        const textRegion = markup.filter(region => inText(region, first)).at(-1)

        if (insideToken || line.trim() === "") {
            result.push(insideToken ? null : 0)
        } else {
            let lineDepth = Math.max(0, depth)
            for (const region of markup) {
                for (const hole of region.holes) {
                    if (first >= hole.start && first < hole.end) lineDepth += hole.depth
                }
            }

            const trimmed = line.trimStart()
            if (textRegion) {
                lineDepth += textRegion.depthAt(first) - (trimmed.startsWith("</") ? 1 : 0)
            } else if (token && token.start === first && CLOSERS.has(label(token))) {
                lineDepth--
            } else if (/^\|(?!\|)|^\.[A-Za-z_$]/.test(trimmed)) {
                lineDepth++
            }
            result.push(Math.max(0, lineDepth))
        }

        lineStart += line.length + 1
    }

    return result
}

function depthsFromText(code) {
    const info = [{ reindentable: true, depth: 0 }]
    let state = "code"
    let depth = 0
    let teDepth = 0

    for (let i = 0; i < code.length; i++) {
        const c = code[i]
        const n = code[i + 1]

        if (c === "\n") {
            if (state === "line") state = "code"
            info.push({ reindentable: state === "code", depth })
            continue
        }

        if (state === "code") {
            if (c === "'") state = "single"
            else if (c === '"') state = "double"
            else if (c === "`") state = "template"
            else if (c === "/" && n === "/") { state = "line"; i++ }
            else if (c === "/" && n === "*") { state = "block"; i++ }
            else if (c === "{" || c === "(" || c === "[") depth++
            else if (c === "}" || c === ")" || c === "]") depth = Math.max(0, depth - 1)
        } else if (state === "single") {
            if (c === "\\") i++
            else if (c === "'") state = "code"
        } else if (state === "double") {
            if (c === "\\") i++
            else if (c === '"') state = "code"
        } else if (state === "template") {
            if (c === "\\") i++
            else if (c === "`") state = "code"
            else if (c === "$" && n === "{") { i++; teDepth = 1; state = "templateExpr" }
        } else if (state === "templateExpr") {
            if (c === "{") teDepth++
            else if (c === "}") { teDepth--; if (teDepth === 0) state = "template" }
            else if (c === "'" || c === '"' || c === "`") {
                const quote = c
                i++
                while (i < code.length && code[i] !== quote) {
                    if (code[i] === "\\") i++
                    i++
                }
            }
        } else if (state === "block") {
            if (c === "*" && n === "/") { i++; state = "code" }
        }
    }

    const lines = code.split("\n")
    return lines.map((line, index) => {
        const entry = info[index]
        if (!entry?.reindentable) return null
        const trimmed = line.trim()
        if (trimmed === "") return 0
        return /^[}\])]/.test(trimmed) ? Math.max(0, entry.depth - 1) : entry.depth
    })
}

export function formatSlim(code) {
    const normalized = code.replace(/\r\n/g, "\n")

    let depths
    try {
        depths = depthsFromSyntax(normalized)
    } catch {
        depths = depthsFromText(normalized)
    }

    const out = normalized.split("\n").map((line, index) => {
        const depth = depths[index]
        if (depth === null || depth === undefined) return line
        const trimmed = line.trim()
        return trimmed === "" ? "" : "    ".repeat(depth) + trimmed
    })

    return out.join("\n").replace(/\n+$/, "") + "\n"
}

export function formatFile(file) {
    const original = fs.readFileSync(file, "utf8")
    const formatted = formatSlim(original)
    if (formatted !== original) fs.writeFileSync(file, formatted)
    return formatted !== original
}
