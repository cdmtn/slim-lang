import { babel } from "./babel.js"
import { PREFIX_OPERATORS, collectDeclaredWords } from "./parser/shared.js"
import { slimBase } from "./parser/base.js"
import { slimStatements } from "./parser/statements.js"
import { slimDeclarations } from "./parser/declarations.js"
import { slimFunctions } from "./parser/functions.js"
import { slimOperators } from "./parser/operators.js"
import { slimMatch } from "./parser/match.js"
import { slimMarkup } from "./parser/markup.js"
export { slimSyntaxError } from "./parser/shared.js"

const slim = superClass => slimMarkup(slimMatch(slimOperators(slimFunctions(slimDeclarations(slimStatements(slimBase(superClass)))))))

babel.registerPlugin("slim", slim)

const DECLARED_WORD = new RegExp(`\\b(?:const|let|var|state|func|function|class|component|struct|enum|type)\\s+(${[...PREFIX_OPERATORS].join("|")})\\b`, "g")

export function operatorWordsDeclared(code) {
    return new Set([...code.matchAll(DECLARED_WORD)].map(match => match[1]))
}

export function parseSlim(code, sourceFilename = "input.slim", { comments = false } = {}) {
    const parse = words => babel.parse(code, {
        sourceType: "module",
        sourceFilename,
        attachComment: comments,
        allowReturnOutsideFunction: false,
        plugins: ["typescript", ["slim", { words: [...words] }]]
    })
    const words = operatorWordsDeclared(code)
    const seen = new Set()
    const previous = collectDeclaredWords(seen)
    let result
    let failure = null
    try {
        result = parse(words)
    } catch (error) {
        failure = error
    } finally {
        collectDeclaredWords(previous)
    }
    const missing = [...seen].filter(word => !words.has(word))
    if (missing.length) return parse(new Set([...words, ...missing]))
    if (failure) throw failure
    return result
}

export { babel }
