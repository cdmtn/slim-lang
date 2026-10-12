const KEYWORDS = new Set([
    "struct", "enum", "type", "func", "component", "use", "lock", "mode", "elif",
    "and", "or", "sizeof", "kindof", "empty", "copyof",
    "break", "case", "catch", "class", "const", "continue", "debugger", "default",
    "delete", "do", "else", "export", "extends", "finally", "for", "function",
    "if", "import", "in", "instanceof", "new", "return", "super", "switch", "this",
    "throw", "try", "typeof", "var", "void", "while", "with", "yield", "let",
    "static", "async", "await", "of", "as", "from"
])

const REGEX_KEYWORDS = new Set([
    "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
    "do", "else", "yield", "await", "case", "throw"
])

const PUNCTUATORS = [
    ">>>=", "===", "!==", ">>>", "**=", "<<=", ">>=", "&&=", "||=", "??=", "...",
    "~/", "|>", "::", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "**", "++",
    "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>",
    "{", "}", "(", ")", "[", "]", ";", ",", "<", ">", "+", "-", "*", "/", "%",
    "&", "|", "^", "!", "~", "?", ":", "=", ".", "@"
]

const NUMBER = /(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?)n?/y
const NAME = /[A-Za-z_$][\w$]*/y

function regexAllowed(prev) {
    if (!prev) return true
    if (prev.type === "number" || prev.type === "string" || prev.type === "regex" || prev.type === "template") {
        return false
    }
    if (prev.type === "name") {
        return prev.keyword && REGEX_KEYWORDS.has(prev.value)
    }
    if (prev.type === "punct") {
        return prev.value !== ")" && prev.value !== "]"
    }
    return true
}

function scanRegex(code, start) {
    let i = start + 1
    let inClass = false

    while (i < code.length) {
        const c = code[i]
        if (c === "\n") return start
        if (c === "\\") { i += 2; continue }
        if (c === "[") inClass = true
        else if (c === "]") inClass = false
        else if (c === "/" && !inClass) { i++; break }
        i++
    }

    if (i > code.length) return start
    while (i < code.length && /[a-z]/i.test(code[i])) i++
    return i
}

export function tokenize(code) {
    const tokens = []
    const modes = [{ kind: "code", brace: 0, interp: false }]
    let prev = null
    let i = 0

    const emit = (type, start, end, keyword = false) => {
        const token = { type, value: code.slice(start, end), start, end }
        if (keyword) token.keyword = true
        tokens.push(token)
        if (type !== "ws" && type !== "newline" && type !== "comment") prev = token
        return token
    }

    while (i < code.length) {
        const mode = modes[modes.length - 1]

        if (mode.kind === "template") {
            const start = i
            while (i < code.length) {
                const c = code[i]
                if (c === "\\") { i += 2; continue }
                if (c === "`" || (c === "$" && code[i + 1] === "{")) break
                i++
            }
            if (i > start) emit("template", start, i)

            if (code[i] === "`") {
                emit("punct", i, i + 1); i++
                modes.pop()
            } else if (code[i] === "$") {
                emit("punct", i, i + 2); i += 2
                modes.push({ kind: "code", brace: 0, interp: true })
            }
            continue
        }

        const c = code[i]

        if (c === " " || c === "\t" || c === "\r") {
            const start = i
            while (i < code.length && (code[i] === " " || code[i] === "\t" || code[i] === "\r")) i++
            emit("ws", start, i); continue
        }

        if (c === "\n") { emit("newline", i, i + 1); i++; continue }

        if (c === "/" && code[i + 1] === "/") {
            const start = i
            while (i < code.length && code[i] !== "\n") i++
            emit("comment", start, i); continue
        }

        if (c === "/" && code[i + 1] === "*") {
            const start = i
            i += 2
            while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) i++
            i = Math.min(i + 2, code.length)
            emit("comment", start, i); continue
        }

        if (c === "'" || c === '"') {
            const start = i
            i++
            while (i < code.length) {
                if (code[i] === "\\") { i += 2; continue }
                if (code[i] === c || code[i] === "\n") { break }
                i++
            }
            if (code[i] === c) i++
            emit("string", start, i); continue
        }

        if (c === "`") {
            emit("punct", i, i + 1); i++
            modes.push({ kind: "template" }); continue
        }

        if (c === "}" && mode.interp && mode.brace === 0) {
            emit("punct", i, i + 1); i++
            modes.pop(); continue
        }
        if (c === "{" && mode.interp) mode.brace++
        if (c === "}" && mode.interp) mode.brace--

        if (c === "/" && regexAllowed(prev)) {
            const end = scanRegex(code, i)
            if (end > i) { emit("regex", i, end); i = end; continue }
        }

        NUMBER.lastIndex = i
        const num = NUMBER.exec(code)
        if (num && num.index === i && num[0].length > 0) {
            emit("number", i, i + num[0].length); i += num[0].length; continue
        }

        NAME.lastIndex = i
        const name = NAME.exec(code)
        if (name && name.index === i) {
            emit("name", i, i + name[0].length, KEYWORDS.has(name[0])); i += name[0].length; continue
        }

        let matched = null
        for (const p of PUNCTUATORS) {
            if (code.startsWith(p, i)) { matched = p; break }
        }
        if (matched) {
            emit("punct", i, i + matched.length); i += matched.length; continue
        }

        emit("other", i, i + 1); i++
    }

    return tokens
}
