import { babel } from "../babel.js"

export const {
    tt, tokenIsIdentifier, tokenIsKeywordOrIdentifier, tokenCanStartExpression, tokenOperatorPrecedence, functionFlags, ExpressionErrors
} = babel.internals

export const LEXICAL = 8201
export const FUNCTION_SCOPE = 514

export const PREFIX_OPERATORS = new Set(["sizeof", "kindof", "empty", "copyof", "lock"])
export const NOT_AN_OPERAND = new Set(["in", "of", "instanceof", "as", "from"])
export const AMBIGUOUS_OPERANDS = new Set([tt.plusMin, tt.incDec, tt.slash, tt.slashAssign, tt.lt, tt.parenL, tt.modulo, tt.star, tt.exponent])
export const DECLARATION_WORDS = new Set(["struct", "enum", "func", "component", "trait"])
export const STRUCTURAL_PATTERNS = new Set(["ObjectExpression", "ArrayExpression", "CallExpression"])
export const TRY_ENDS = new Set([tt.parenR, tt.bracketR, tt.braceR, tt.comma, tt.semi, tt.eof])

export const VOID_ELEMENTS = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr"
])
export const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"])
export const STATEMENT_WORDS = ["if", "for", "while", "do", "switch", "return", "const", "let", "var", "throw", "try"]
export const UNTERMINATED = new Set(["UnterminatedRegExp", "UnterminatedString", "UnterminatedTemplate", "UnterminatedComment"])

export const isLetter = c => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z")
export const isTagChar = c => isLetter(c) || (c >= "0" && c <= "9") || c === "-" || c === "_" || c === ":" || c === "."
export const isBlank = c => c === " " || c === "\t" || c === "\r" || c === "\n"
export const hasLineBreak = text => /[\n\r\u2028\u2029]/.test(text)

function lineColumn(input, pos) {
    let line = 1
    let lineStart = 0
    for (let i = 0; i < pos; i++) {
        if (input[i] === "\n") {
            line++
            lineStart = i + 1
        }
    }
    return { line, column: pos - lineStart }
}

export function slimSyntaxError(input, pos, message) {
    const { line, column } = lineColumn(input, pos)
    const error = new SyntaxError(`${message} (${line}:${column})`)
    error.loc = { line, column, index: pos }
    error.pos = pos
    error.code = "BABEL_PARSER_SYNTAX_ERROR"
    error.reasonCode = "SlimSyntaxError"
    error.slimMessage = message
    return error
}

export let declaredWords = null

export function collectDeclaredWords(words) {
    const previous = declaredWords
    declaredWords = words
    return previous
}
