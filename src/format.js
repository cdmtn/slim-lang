import fs from "node:fs"
import { tokenize } from "./lexer.js"

function breakPipes(code) {
    const pipes = tokenize(code).filter(token => token.type === "punct" && token.value === "|>")
    for (const pipe of pipes.reverse()) {
        let start = pipe.start
        while (start > 0 && /\s/.test(code[start - 1])) start--
        code = code.slice(0, start) + "\n|>" + code.slice(pipe.end)
    }
    return code
}

function analyze(code) {
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

    return info
}

export function formatSlim(code) {
    const normalized = breakPipes(code.replace(/\r\n/g, "\n"))
    const lines = normalized.split("\n")
    const perLine = analyze(normalized)

    const out = lines.map((line, index) => {
        const info = perLine[index]
        if (!info || !info.reindentable) return line

        const trimmed = line.trim()
        if (trimmed === "") return ""

        let depth = info.depth
        if (/^[}\])]/.test(trimmed)) depth = Math.max(0, depth - 1)
        if (trimmed.startsWith("|>")) depth++
        return "    ".repeat(depth) + trimmed
    })

    return out.join("\n").replace(/\n+$/, "") + "\n"
}

export function formatFile(file) {
    const original = fs.readFileSync(file, "utf8")
    const formatted = formatSlim(original)
    if (formatted !== original) fs.writeFileSync(file, formatted)
    return formatted !== original
}
