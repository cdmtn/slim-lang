import fs from "node:fs"
import { babel, operatorWordsDeclared } from "./syntax/plugin.js"

const OPENERS = new Set(["{", "(", "[", "${", "#{", "#["])
const CLOSERS = new Set(["}", ")", "]"])
const VERBATIM = new Set(["string", "template", "CommentBlock", "CommentLine", "regexp"])

const VOID_ELEMENTS = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr"
])

const RAW_ELEMENTS = new Set(["pre", "textarea", "script", "style"])
const PRESERVED_ELEMENTS = new Set(["pre", "textarea", "script"])

const CONTINUATION = /^(?:\|\||&&|\?\?|\?(?![.?])|:(?!:)|\|(?!\|)|\.[A-Za-z_$])/

const label = token => typeof token.type === "string" ? token.type : token.type.label

function collectMarkup(node, out, inComponent = false) {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) return node.forEach(child => collectMarkup(child, out, inComponent))
    if (node.type === "SlimMarkup") out.push({ node, stringMode: !inComponent })
    const inside = inComponent || node.type === "SlimComponentDeclaration"
    for (const [key, value] of Object.entries(node)) {
        if (key !== "loc" && key !== "extra" && value && typeof value === "object") collectMarkup(value, out, inside)
    }
}

function describeMarkup(code, node, stringMode) {
    const holes = node.expressions.map(expression => {
        const open = code.lastIndexOf("${", expression.start)
        let close = expression.end
        while (close < node.end && code[close] !== "}") close++
        return { start: open, end: close + 1 }
    })

    const events = []
    const verbatim = stringMode ? [{ start: node.start, end: node.end }] : []
    let inTag = false
    let closing = false
    let tag = ""
    let tagStart = 0
    let quote = null
    let quoteStart = 0
    let hole = 0

    const enterHole = () => {
        const { start, end } = holes[hole++]
        events.push({ at: start, from: start, open: true }, { at: end - 1, from: end - 1, open: false })
        return end
    }
    const skipTo = stop => {
        while (hole < holes.length && holes[hole].start < stop) enterHole()
    }

    for (let i = node.start; i < node.end; i++) {
        if (hole < holes.length && i === holes[hole].start) {
            i = enterHole() - 1
            continue
        }
        const c = code[i]
        if (inTag) {
            if (quote) {
                if (c === quote) {
                    if (/[\r\n]/.test(code.slice(quoteStart, i))) verbatim.push({ start: quoteStart, end: i })
                    quote = null
                }
            } else if (c === '"' || c === "'") {
                quote = c
                quoteStart = i
            } else if (c === ">") {
                inTag = false
                if (closing) {
                    events.push({ at: tagStart, from: tagStart, open: false })
                } else if (code[i - 1] === "/" || VOID_ELEMENTS.has(tag)) {
                    events.push({ at: code[i - 1] === "/" ? i - 1 : i, from: i, open: false })
                } else {
                    if (RAW_ELEMENTS.has(tag)) {
                        const end = code.toLowerCase().indexOf(`</${tag}`, i + 1)
                        const stop = end === -1 || end > node.end ? node.end : end
                        if (PRESERVED_ELEMENTS.has(tag)) verbatim.push({ start: i + 1, end: stop })
                        skipTo(stop)
                        i = stop - 1
                    }
                }
            }
        } else if (c === "<" && code.startsWith("<!--", i)) {
            const end = code.indexOf("-->", i + 4)
            const stop = end === -1 || end > node.end ? node.end : end + 3
            skipTo(stop)
            i = stop - 1
        } else if (c === "<" && code[i + 1] === "/") {
            inTag = true
            closing = true
            tagStart = i
        } else if (c === "<" && /[A-Za-z]/.test(code[i + 1] ?? "")) {
            inTag = true
            closing = false
            tagStart = i
            events.push({ at: i, from: i, open: true })
            const name = /^[\w:.-]+/.exec(code.slice(i + 1))
            tag = name ? name[0].toLowerCase() : ""
        }
    }

    return { start: node.start, end: node.end, holes, events, verbatim }
}

function distinctLines(stack) {
    let count = 0
    for (let index = 0; index < stack.length; index++) {
        if (index === 0 || stack[index] !== stack[index - 1]) count++
    }
    return count
}

function depthsFromSyntax(code) {
    const ast = babel.parse(code, {
        sourceType: "module",
        tokens: true,
        errorRecovery: false,
        plugins: ["typescript", ["slim", { words: [...operatorWordsDeclared(code)] }]]
    })

    const markupNodes = []
    collectMarkup(ast.program, markupNodes)
    const markup = markupNodes.map(({ node, stringMode }) => describeMarkup(code, node, stringMode))

    const inText = (region, offset) =>
        offset >= region.start && offset < region.end && !region.holes.some(hole => offset >= hole.start && offset < hole.end)

    const brackets = ast.tokens.filter(token => {
        const kind = label(token)
        if (!OPENERS.has(kind) && !CLOSERS.has(kind)) return false
        return !markup.some(region => inText(region, token.start) ||
            region.holes.some(hole => token.start === hole.start || token.start === hole.end - 1))
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

    const lines = code.split("\n")
    const lineStarts = []
    let offset = 0
    for (const line of lines) {
        lineStarts.push(offset)
        offset += line.length + 1
    }
    const lineOf = position => {
        let low = 0
        let high = lineStarts.length - 1
        while (low < high) {
            const middle = (low + high + 1) >> 1
            if (lineStarts[middle] <= position) low = middle
            else high = middle - 1
        }
        return low
    }

    const events = [
        ...brackets.map(token => ({ at: token.start, from: token.start, open: OPENERS.has(label(token)) })),
        ...markup.flatMap(region => region.events)
    ].sort((a, b) => a.at - b.at)

    const result = []
    const open = []
    let event = 0
    let tokenIndex = 0

    lines.forEach((line, index) => {
        const lineStart = lineStarts[index]
        const first = lineStart + (line.length - line.trimStart().length)

        while (event < events.length && events[event].at < first) {
            if (events[event].open) open.push(lineOf(events[event].from))
            else open.pop()
            event++
        }
        while (tokenIndex < ast.tokens.length && ast.tokens[tokenIndex].end <= first) tokenIndex++

        const token = ast.tokens[tokenIndex]
        const insideToken = (token && token.start < first && VERBATIM.has(label(token))) || inTemplateText(lineStart) ||
            markup.some(region => region.verbatim.some(range => lineStart > range.start && lineStart <= range.end))

        if (insideToken || line.trim() === "") {
            result.push(insideToken ? null : 0)
            return
        }

        const closing = event < events.length && events[event].at === first && !events[event].open && open.length > 0
        let lineDepth = closing ? distinctLines(open.filter(item => item !== open.at(-1))) : distinctLines(open)
        const inMarkupText = markup.some(region => inText(region, first))
        if (!closing && !inMarkupText && CONTINUATION.test(line.trimStart())) lineDepth++
        result.push(lineDepth)
    })

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
    const crlf = (code.match(/\r\n/g)?.length ?? 0) * 2 > (code.match(/\n/g)?.length ?? 0)
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

    const formatted = out.join("\n").replace(/\n+$/, "") + "\n"
    return crlf ? formatted.replace(/\n/g, "\r\n") : formatted
}

export function formatFile(file) {
    const original = fs.readFileSync(file, "utf8")
    const formatted = formatSlim(original)
    if (formatted !== original) fs.writeFileSync(file, formatted)
    return formatted !== original
}
