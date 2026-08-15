import {
    extractExpr,
    extractExprBackward,
    extractExprRaw,
    parseTypedArgs,
    isInsideString,
    parseTypesEdits,
    buildTypedArgsResult
} from "./handlers/parserHandler.js"
import { parseComponentsEdits } from "./handlers/parser/components.js"
import { createMapped, applyEdits } from "./sourcemap.js"

export function stripComments(code) {
    let result = ""
    let i = 0

    while (i < code.length) {
        if (code[i] === '"' || code[i] === "'" || code[i] === "`") {
            const quote = code[i]
            result += code[i++]
            while (i < code.length) {
                if (code[i] === "\\" ) { result += code[i++] + code[i++]; continue }
                if (code[i] === quote) { result += code[i++]; break }
                result += code[i++]
            }
            continue
        }

        if (code[i] === "/" && code[i + 1] === "/") {
            while (i < code.length && code[i] !== "\n") i++
            continue
        }

        if (code[i] === "/" && code[i + 1] === "*") {
            i += 2
            while (i < code.length) {
                if (code[i] === "*" && code[i + 1] === "/") { i += 2; break }
                i++
            }
            continue
        }

        result += code[i++]
    }

    return result
}

function commentEdits(code) {
    const edits = []
    let i = 0

    while (i < code.length) {
        const c = code[i]

        if (c === '"' || c === "'" || c === "`") {
            const quote = c
            i++
            while (i < code.length) {
                if (code[i] === "\\") { i += 2; continue }
                if (code[i] === quote) { i++; break }
                i++
            }
            continue
        }

        if (c === "/" && code[i + 1] === "/") {
            const start = i
            while (i < code.length && code[i] !== "\n") i++
            edits.push({ start, end: i, replacement: "" })
            continue
        }

        if (c === "/" && code[i + 1] === "*") {
            const start = i
            i += 2
            while (i < code.length) {
                if (code[i] === "*" && code[i + 1] === "/") { i += 2; break }
                i++
            }
            edits.push({ start, end: i, replacement: "" })
            continue
        }

        i++
    }

    return edits
}

function condOperatorEdits(code, operator, replacement) {
    const edits = []
    let state = "code"
    let depth = 0

    const isWord = c => c && /[A-Za-z0-9_$]/.test(c)

    for (let i = 0; i < code.length; i++) {
        const c = code[i]
        const n = code[i + 1]

        if (state === "code") {
            if (c === "'") { state = "single"; continue }
            if (c === '"') { state = "double"; continue }
            if (c === "`") { state = "template"; continue }
            if (c === "/" && n === "/") { state = "lineComment"; i++; continue }
            if (c === "/" && n === "*") { state = "blockComment"; i++; continue }

            if (
                code.startsWith(operator, i) &&
                !isWord(code[i - 1]) &&
                !isWord(code[i + operator.length])
            ) {
                edits.push({ start: i, end: i + operator.length, replacement })
                i += operator.length - 1
                continue
            }
            continue
        }

        if (state === "single") {
            if (c === "\\" && n) { i++ }
            else if (c === "'") { state = "code" }
            continue
        }

        if (state === "double") {
            if (c === "\\" && n) { i++ }
            else if (c === '"') { state = "code" }
            continue
        }

        if (state === "template") {
            if (c === "$" && n === "{") { state = "templateExpr"; depth = 1; i++; continue }
            if (c === "\\" && n) { i++ }
            else if (c === "`") { state = "code" }
            continue
        }

        if (state === "templateExpr") {
            if (c === "{") depth++
            if (c === "}") depth--

            if (
                code.startsWith(operator, i) &&
                !isWord(code[i - 1]) &&
                !isWord(code[i + operator.length])
            ) {
                edits.push({ start: i, end: i + operator.length, replacement })
                i += operator.length - 1
                continue
            }

            if (depth === 0) state = "template"
            continue
        }

        if (state === "lineComment") {
            if (c === "\n") state = "code"
            continue
        }

        if (state === "blockComment") {
            if (c === "*" && n === "/") { i++; state = "code" }
            continue
        }
    }

    return edits
}

function operatorEdits(code, keyword, fn) {
    const edits = []
    let i = 0

    while (i < code.length) {
        const match = code.slice(i).match(new RegExp(`^${keyword}\\s+`))

        if (match) {
            const afterKeyword = i + match[0].length
            const expr = extractExpr(code, afterKeyword)
            const end = afterKeyword + expr.length
            edits.push({ start: i, end, replacement: `${fn}(${expr})` })
            i = end
            continue
        }

        i++
    }

    return edits
}

function applyBinaryOperator(mapped, token, fn) {
    let searchFrom = mapped.text.length

    while (searchFrom >= 0) {
        const text = mapped.text
        const idx = text.lastIndexOf(token, searchFrom)
        if (idx === -1) break
        searchFrom = idx - 1

        if (isInsideString(text, idx)) continue

        const { expr: left, start: leftStart } = extractExprBackward(text, idx)
        const { expr: right, end: rightEnd } = extractExprForwardLocal(text, idx + token.length)

        if (!left || !right) continue

        mapped = applyEdits(mapped, [{
            start: leftStart,
            end: rightEnd,
            replacement: `${fn}(${left}, ${right})`
        }])
    }

    return mapped
}

function extractExprForwardLocal(str, startPos) {
    let depth = 0
    let i = startPos

    while (i < str.length) {
        const ch = str[i]

        if (ch === '"' || ch === "'" || ch === "`") {
            const quote = ch
            i++
            while (i < str.length) {
                if (str[i] === "\\") { i += 2; continue }
                if (str[i] === quote) { i++; break }
                i++
            }
            continue
        }

        if (ch === "(" || ch === "[" || ch === "{") { depth++; i++; continue }
        if (ch === ")" || ch === "]" || ch === "}") {
            if (depth === 0) break
            depth--; i++; continue
        }

        if (depth === 0) {
            const two = str.slice(i, i + 2)
            if (["==", "!=", ">=", "<=", "&&", "||", "??"].includes(two)) break
            if (["+", "-", "*", "/", "%", "<", ">", "?", ":", ";", ",", "\n"].includes(ch)) break
        }

        i++
    }

    return { expr: str.slice(startPos, i).trim(), end: i }
}

function collectEdits(text, register) {
    const replacements = []

    function collect(pattern, handler) {
        const re = new RegExp(pattern.source,
            pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"
        )
        let match
        while ((match = re.exec(text)) !== null) {
            replacements.push({
                start: match.index,
                end: match.index + match[0].length,
                replacement: handler(...match)
            })
        }
    }

    function collectCustom(matcher, handler) {
        let i = 0
        while (i < text.length) {
            const result = matcher(text, i)
            if (!result) { i++; continue }

            replacements.push({
                start: result.start,
                end: result.end,
                replacement: handler(result)
            })
            i = result.end
        }
    }

    register(collect, collectCustom)
    return replacements
}

function functionEdits(text) {
    return collectEdits(text, (collect, collectCustom) => {
        // static async method
        collect(
            /\bstatic\s+async\s+(#?[\w$]+)\s*\(([^)]*)\)\s*\{/g,
            (_, name, args) => {
                const parsed = parseTypedArgs(args)
                const { signature, checks } = buildTypedArgsResult(parsed, name)
                if (!checks) return `static async ${name}(${signature}) {`
                return `static async ${name}(${signature}) {\n    ${checks}`
            }
        )

        // static method
        collect(
            /\bstatic\s+(?!async\s)(#?[\w$]+)\s*\(([^)]*)\)\s*\{/g,
            (_, name, args) => {
                const parsed = parseTypedArgs(args)
                const { signature, checks } = buildTypedArgsResult(parsed, name)
                if (!checks) return `static ${name}(${signature}) {`
                return `static ${name}(${signature}) {\n    ${checks}`
            }
        )

        // async method
        collect(
            /^([ \t]*)async\s+(#?[\w$]+)\s*\(([^)]*)\)\s*\{/gm,
            (_, indent, name, args) => {
                const parsed = parseTypedArgs(args)
                const { signature, checks } = buildTypedArgsResult(parsed, name)
                const kw = indent ? "async" : "async function"
                if (!checks) return `${indent}${kw} ${name}(${signature}) {`
                return `${indent}${kw} ${name}(${signature}) {\n    ${checks}`
            }
        )

        // default method
        collect(
            /^([ \t]*)(?!if\b|else\b|for\b|while\b|switch\b|catch\b|do\b|with\b|return\b|function\b|class\b|try\b|finally\b|async\b)([\w$]+)\s*\(([^)]*)\)\s*\{/gm,
            (_, indent, name, args) => {
                const parsed = parseTypedArgs(args)
                const { signature, checks } = buildTypedArgsResult(parsed, name)
                const kw = indent ? "" : "function "
                if (!checks) return `${indent}${kw}${name}(${signature}) {`
                return `${indent}${kw}${name}(${signature}) {\n    ${checks}`
            }
        )

        // arrow functions (block body)
        collect(
            /\b(let|const|var)\s+([\w$]+)\s*=\s*(async\s*)?\(([^)]*)\)\s*=>\s*\{/g,
            (match, keyword, name, asyncKw, args) => {
                const parsed = parseTypedArgs(args)
                const { signature, checks } = buildTypedArgsResult(parsed, name)
                if (!checks) return `${keyword} ${name} = ${asyncKw ?? ""}(${signature}) => {`
                return `${keyword} ${name} = ${asyncKw ?? ""}(${signature}) => {\n    ${checks}`
            }
        )

        // arrow functions (expression body)
        collectCustom(
            (src, i) => {
                const re = /\b(let|const|var)\s+([\w$]+)\s*=\s*(async\s*)?\(([^)]*)\)\s*=>\s*(?!\{)/y
                re.lastIndex = i
                const m = re.exec(src)
                if (!m) return null
                const { expr, end } = extractExprRaw(src, i + m[0].length)
                return { start: i, end, keyword: m[1], name: m[2], asyncKw: m[3], args: m[4], expr }
            },
            ({ keyword, name, asyncKw, args, expr }) => {
                const parsed = parseTypedArgs(args)
                const { signature, checks } = buildTypedArgsResult(parsed, name)
                const head = `${keyword} ${name} = ${asyncKw ?? ""}(${signature}) =>`
                if (!checks) return `${head} ${expr}`
                return `${head} {\n    ${checks}\n    return ${expr}\n}`
            }
        )

        // func declaration (async)
        collect(
            /\basync\s+func\s+([\w$]+)\s*\(([^)]*)\)\s*\{/g,
            (_, name, args) => {
                const parsed = parseTypedArgs(args)
                const { signature, checks } = buildTypedArgsResult(parsed, name)
                if (!checks) return `async function ${name}(${signature}) {`
                return `async function ${name}(${signature}) {\n    ${checks}`
            }
        )

        // func declaration
        collect(
            /\bfunc\s+([\w$]+)\s*\(([^)]*)\)\s*\{/g,
            (_, name, args) => {
                const parsed = parseTypedArgs(args)
                const { signature, checks } = buildTypedArgsResult(parsed, name)
                if (!checks) return `function ${name}(${signature}) {`
                return `function ${name}(${signature}) {\n    ${checks}`
            }
        )

        // JavaScript-compatible function declarations
        collect(
            /\b(async\s+)?function\s+([\w$]+)\s*\(([^)]*)\)\s*\{/g,
            (_, asyncKw, name, args) => {
                const parsed = parseTypedArgs(args)
                const { signature, checks } = buildTypedArgsResult(parsed, name)
                const prefix = asyncKw ?? ""
                if (!checks) return `${prefix}function ${name}(${signature}) {`
                return `${prefix}function ${name}(${signature}) {\n    ${checks}`
            }
        )
    })
}

function structuralEdits(text) {
    return collectEdits(text, (collect, collectCustom) => {
        // uses
        collect(
            /use\s+(\*\s+as\s+[\w$]+|\{[^}]+\}|[a-zA-Z_$][\w$]*)\s+from\s+"([^"]+)"\s*;?/g,
            (_, name, source) =>
                `__use__(${JSON.stringify(name.trim())}, ${JSON.stringify(source)})\n`
        )
        collect(
            /use\s+(\*\s+as\s+[\w$]+|\{[^}]+\}|[a-zA-Z_$][\w$]*)\s+from\s+(@slim[\w$\/.-]+)\s*;?/g,
            (_, name, source) =>
                `__use__(${JSON.stringify(name.trim())}, ${JSON.stringify(source)})\n`
        )
        collect(
            /use\s+(@slim[\w$\/.-]+)\s*;?/g,
            (_, source) => `__use_all__(${JSON.stringify(source)})\n`
        )
        collect(
            /use\s+"([^"]+)"\s*;?/g,
            (_, source) => `__use_all__(${JSON.stringify(source)})\n`
        )

        // struct
        collect(
            /(export\s+)?struct\s+([A-Z][\w$]*)\s*\{([\s\S]*?)\}/gm,
            (_, exportKw, name, body) => {
                const fields = body
                    .split("\n")
                    .map(line => line.trim())
                    .filter(Boolean)
                    .map(line => {
                        line = line.replace(/,\s*$/, "").trim()
                        const idx = line.indexOf(":")
                        if (idx === -1) return null
                        const field = line.slice(0, idx).trim()
                        const type  = line.slice(idx + 1).trim()
                        if (!field || !type) return null
                        return `"${field}": "${type}"`
                    })
                    .filter(Boolean)
                    .join(", ")

                const decl = `const ${name} = __def_struct__("${name}", { ${fields} })`
                return exportKw ? `export ${decl}` : decl
            }
        )
        // enum
        collect(
            /(export\s+)?enum\s+([A-Z][\w$]*)\s*\{([\s\S]*?)\}/gm,
            (_, exportKw, name, body) => {
                const fields = body
                    .split("\n")
                    .map(line => line.replace(/,\s*$/, "").trim())
                    .filter(Boolean)
                    .map(line => {
                        const idx = line.indexOf(":")
                        if (idx === -1) {
                            const field = line.trim()
                            return `"${field}": "${field}"`
                        }
                        const field = line.slice(0, idx).trim()
                        const value = line.slice(idx + 1).trim()
                        if (!field || !value) return null
                        return `"${field}": ${value}`
                    })
                    .filter(Boolean)
                    .join(", ")

                const decl = `const ${name} = __def_enum__("${name}", { ${fields} })`
                return exportKw ? `export ${decl}` : decl
            }
        )

        // decl w/ type
        collectCustom(
            (src, i) => {
                if (isInsideString(src, i)) return null;

                const re = /\b(let|const|var|static)\s+(#?[\w$]+)\s*:\s*([\w$]+(?:::[\w$]+)?(?:<[^<>]+>)?(?:\[\])?(?:\s*\|\s*[\w$]+(?:::[\w$]+)?(?:<[^<>]+>)?(?:\[\])?)*)\s*=/y
                re.lastIndex = i
                const m = re.exec(src)
                if (!m) return null
                const { expr, end } = extractExprRaw(src, i + m[0].length)
                return { start: i, end, keyword: m[1], name: m[2], type: m[3], expr }
            },
            ({ keyword, name, type, expr }) =>
                `${keyword} ${name} = __typed_variable__(${expr}, "${type}", "${name}")`
        )

        // pipes
        collect(
            /(\w[\w$.]*(?:\[.*?\])?)\s*(?:=>\s*([\w$]+))?\s*\n((?:\s*\|[^\n]+\n?)+)/g,
            (_, source, alias, pipes) => {
                const steps = [...pipes.matchAll(/\|\s*([\w$]+)\(([^)]*)\)/g)]
                const callbackMethods = new Set([
                    "map", "filter", "find", "findIndex",
                    "some", "every", "flatMap", "forEach",
                    "reduce", "reduceRight"
                ])
                const chain = steps.map(([, method, args]) => {
                    if (alias) {
                        if (args.includes("=>")) return `.${method}(${args.trim()})`
                        if (callbackMethods.has(method)) return `.${method}(${alias} => ${args.trim()})`
                        return `.${method}(${args.trim()})`
                    }
                    return `.${method}(${args.trim()})`
                }).join("")
                return `${source}${chain}`
            }
        )

        // lock const / lock operator
        collectCustom(
            (code, i) => {
                const match = code.slice(i).match(/^lock\s+const\s+([\w$]+)\s*=\s*/)
                if (!match) return null
                const name = match[1]
                const afterEq = i + match[0].length
                const expr = extractExpr(code, afterEq)
                return { start: i, end: afterEq + expr.length, name, expr }
            },
            ({ name, expr }) => `const ${name} = __lock_object__(${expr})`
        )

        // lock {expr}
        collectCustom(
            (code, i) => {
                const match = code.slice(i).match(/^lock\s+(?!const\s)/)
                if (!match) return null
                const afterKeyword = i + match[0].length
                const expr = extractExpr(code, afterKeyword)
                return { start: i, end: afterKeyword + expr.length, expr }
            },
            ({ expr }) => `__lock_object__(${expr})`
        )

        // elif
        collect(
            /\}\s*elif\s*\(/g,
            match => match.replace("elif", "else if")
        )

        // mode "..."
        collect(
            /mode\s+"([^"]+)"/,
            (_, name) => {
                if(name == "strict") {
                    return `"use strict"`
                }
                else {
                    return ''
                }
            }
        )
    })
}

export function preprocess(code, sourceFile = "index.slim") {
    let mapped = createMapped(code)

    mapped = applyEdits(mapped, commentEdits(mapped.text))
    mapped = applyEdits(mapped, condOperatorEdits(mapped.text, "or", "||"))

    mapped = applyEdits(mapped, parseTypesEdits(mapped.text))

    mapped = applyEdits(mapped, operatorEdits(mapped.text, "sizeof", "__sizeof__"))
    mapped = applyEdits(mapped, operatorEdits(mapped.text, "kindof", "type"))
    mapped = applyEdits(mapped, operatorEdits(mapped.text, "empty", "__is_empty__"))
    mapped = applyEdits(mapped, operatorEdits(mapped.text, "copyof", "__copyof__"))
    mapped = applyBinaryOperator(mapped, "~/", "__intdiv__")

    mapped = applyEdits(mapped, parseComponentsEdits(mapped.text))

    // functions/methods/arrows
    mapped = applyEdits(mapped, functionEdits(mapped.text))

    // struct/component/decl w/ type/lock
    mapped = applyEdits(mapped, structuralEdits(mapped.text))

    return { code: mapped.text, mapped, source: sourceFile }
}
