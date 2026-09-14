import {
    extractExpr,
    extractExprBackward,
    extractExprRaw,
    parseTypedArgs,
    isInsideString,
    parseTypesEdits,
    buildTypedArgsResult,
    readTypeAnnotation
} from "./handlers/parserHandler.js"
import { parseComponentsEdits } from "./handlers/parser/components.js"
import { createMapped, applyEdits } from "./sourcemap.js"
import { tokenize } from "./lexer.js"

export function stripComments(code) {
    return tokenize(code).map(token => token.type === "comment" ? "" : token.value).join("")
}

function commentEdits(code) {
    const edits = []
    for (const token of tokenize(code)) {
        if (token.type === "comment") {
            edits.push({ start: token.start, end: token.end, replacement: "" })
        }
    }
    return edits
}

const EXPRESSION_ENDS = new Set([")", "]", "}", "`", "++", "--"])

function endsExpression(token) {
    if (!token) return false
    if (token.type === "punct") return EXPRESSION_ENDS.has(token.value)
    return token.type === "name" || token.type === "number" ||
        token.type === "string" || token.type === "regex" || token.type === "template"
}

function wordOperatorEdits(code) {
    const replacements = { __proto__: null, or: "||", and: "&&" }
    const edits = []
    let prev = null

    for (const token of tokenize(code)) {
        if (token.type === "ws" || token.type === "newline" || token.type === "comment") continue

        // Lower word operators only after an operand.
        const replacement = token.type === "name" ? replacements[token.value] : undefined
        if (replacement && endsExpression(prev)) {
            edits.push({ start: token.start, end: token.end, replacement })
        }

        prev = token
    }
    return edits
}

function operatorEdits(code, keyword, fn) {
    const edits = []

    for (const token of tokenize(code)) {
        if (token.type !== "name" || token.value !== keyword) continue

        let afterKeyword = token.end
        while (afterKeyword < code.length && /\s/.test(code[afterKeyword])) afterKeyword++
        if (afterKeyword === token.end) continue

        const expr = extractExpr(code, afterKeyword)
        if (!expr) continue

        edits.push({ start: token.start, end: afterKeyword + expr.length, replacement: `${fn}(${expr})` })
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
    const tokens = tokenize(text)

    const isCode = offset => {
        let lo = 0
        let hi = tokens.length - 1
        while (lo <= hi) {
            const mid = (lo + hi) >> 1
            const token = tokens[mid]
            if (offset < token.start) hi = mid - 1
            else if (offset >= token.end) lo = mid + 1
            else return token.type !== "string" && token.type !== "template" &&
                token.type !== "comment" && token.type !== "regex"
        }
        return true
    }

    // Handlers may preserve offsets for verbatim source slices.
    const edit = (start, end, produced) => {
        const body = typeof produced === "string" ? { replacement: produced } : produced
        replacements.push({ start, end, ...body })
    }

    function collect(pattern, handler) {
        const re = new RegExp(pattern.source,
            pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"
        )
        let match
        while ((match = re.exec(text)) !== null) {
            if (!isCode(match.index)) continue
            edit(match.index, match.index + match[0].length, handler(...match))
        }
    }

    function collectCustom(matcher, handler) {
        let i = 0
        while (i < text.length) {
            const result = matcher(text, i)
            if (!result) { i++; continue }

            if (isCode(result.start)) edit(result.start, result.end, handler(result))
            i = result.end
        }
    }

    register(collect, collectCustom)
    return replacements
}

const NOT_A_CALL = "(?!if\\b|else\\b|for\\b|while\\b|switch\\b|catch\\b|do\\b|with\\b|return\\b|function\\b|class\\b|try\\b|finally\\b|async\\b)"
const OPENS_BODY = "\\s*\\{"

function functionEdits(text) {
    return collectEdits(text, (collect, collectCustom) => {
        const signature = (head, handler, tail = OPENS_BODY) =>
            collectCustom(headMatcher(head, tail), handler)

        // Carry return contracts into the AST pass for function-local checks.
        const lower = ({ args, returns }, name, emit) => {
            const parsed = parseTypedArgs(args)
            const { signature: params, checks } = buildTypedArgsResult(parsed, name)
            const declaration = returns ? `__declare_return__("${returns}", "${name}")` : ""
            const prelude = [checks, declaration].filter(Boolean).join("\n    ")

            return prelude ? emit(params, `\n    ${prelude}\n`) : emit(params, "")
        }

        signature(
            "\\bstatic\\s+async\\s+(#?[\\w$]+)\\s*\\(",
            ({ groups: [name], args, returns }) =>
                lower({ args, returns }, name, (params, checks) => `static async ${name}(${params}) {${checks}`)
        )

        signature(
            "\\bstatic\\s+(?!async\\s)(#?[\\w$]+)\\s*\\(",
            ({ groups: [name], args, returns }) =>
                lower({ args, returns }, name, (params, checks) => `static ${name}(${params}) {${checks}`)
        )

        signature(
            "^([ \\t]*)async\\s+(#?[\\w$]+)\\s*\\(",
            ({ groups: [indent, name], args, returns }) => {
                const keyword = indent ? "async" : "async function"
                return lower({ args, returns }, name, (params, checks) =>
                    `${indent}${keyword} ${name}(${params}) {${checks}`)
            }
        )

        signature(
            `^([ \\t]*)${NOT_A_CALL}([\\w$]+)\\s*\\(`,
            ({ groups: [indent, name], args, returns }) => {
                const keyword = indent ? "" : "function "
                return lower({ args, returns }, name, (params, checks) =>
                    `${indent}${keyword}${name}(${params}) {${checks}`)
            }
        )

        signature(
            `(\\{[ \\t]*)(async\\s+)?${NOT_A_CALL}([\\w$]+)\\s*\\(`,
            ({ groups: [brace, asyncKw, name], args, returns }) => {
                const prefix = asyncKw ? "async " : ""
                return lower({ args, returns }, name, (params, checks) =>
                    `${brace}${prefix}${name}(${params}) {${checks}`)
            }
        )

        signature(
            "\\b(let|const|var)\\s+([\\w$]+)\\s*=\\s*(async\\s*)?\\(",
            ({ groups: [keyword, name, asyncKw], args, returns }) =>
                lower({ args, returns }, name, (params, checks) =>
                    `${keyword} ${name} = ${asyncKw ?? ""}(${params}) => {${checks}`),
            "\\s*=>\\s*\\{"
        )

        const arrowHead = headMatcher(
            "\\b(let|const|var)\\s+([\\w$]+)\\s*=\\s*(async\\s*)?\\(",
            "\\s*=>\\s*(?!\\{)"
        )
        collectCustom(
            (src, i) => {
                const head = arrowHead(src, i)
                if (!head) return null
                const { expr, end } = extractExprRaw(src, head.end)
                return { ...head, end, expr }
            },
            ({ groups: [keyword, name, asyncKw], args, returns, expr }) =>
                lower({ args, returns }, name, (params, checks) => {
                    const head = `${keyword} ${name} = ${asyncKw ?? ""}(${params}) =>`
                    if (!checks) return `${head} ${expr}`
                    return `${head} {${checks}    return ${expr}\n}`
                })
        )

        signature(
            "\\basync\\s+func\\s+([\\w$]+)\\s*\\(",
            ({ groups: [name], args, returns }) =>
                lower({ args, returns }, name, (params, checks) => `async function ${name}(${params}) {${checks}`)
        )

        signature(
            "\\bfunc\\s+([\\w$]+)\\s*\\(",
            ({ groups: [name], args, returns }) =>
                lower({ args, returns }, name, (params, checks) => `function ${name}(${params}) {${checks}`)
        )

        signature(
            "\\b(async\\s+)?function\\s+([\\w$]+)\\s*\\(",
            ({ groups: [asyncKw, name], args, returns }) =>
                lower({ args, returns }, name, (params, checks) =>
                    `${asyncKw ?? ""}function ${name}(${params}) {${checks}`)
        )
    })
}

// Cache tokens for whole-file and extracted-body scans.
const tokenCache = new Map()

function tokensFor(src) {
    const hit = tokenCache.get(src)
    if (hit) return hit

    const tokens = tokenize(src)
    const starts = new Map()
    for (let index = 0; index < tokens.length; index++) {
        starts.set(tokens[index].start, index)
    }

    if (tokenCache.size >= 8) tokenCache.delete(tokenCache.keys().next().value)
    const entry = { tokens, starts }
    tokenCache.set(src, entry)
    return entry
}

// Match brackets by tokens so literals and comments do not affect depth.
function readBalanced(src, pos, open = "{", close = "}") {
    const { tokens, starts } = tokensFor(src)
    let index = starts.get(pos)
    if (index === undefined) return -1

    let depth = 0
    for (; index < tokens.length; index++) {
        const token = tokens[index]
        if (token.type !== "punct") continue

        if (token.value === open || (open === "{" && token.value === "${")) depth++
        else if (token.value === close) {
            depth--
            if (depth === 0) return token.end
        }
    }
    return -1
}

// Read balanced arguments after matching a construct head.
// Return type may be introduced by `->` or `:` (e.g. `func f(): number`).
const returnArrow = /\s*(?:->|:)\s*/y

function headMatcher(head, tail) {
    const headRe = new RegExp(head, "ym")
    const tailRe = new RegExp(tail, "ym")

    return (src, i) => {
        headRe.lastIndex = i
        const start = headRe.exec(src)
        if (!start) return null

        const parenPos = i + start[0].length - 1
        const parenEnd = readBalanced(src, parenPos, "(", ")")
        if (parenEnd === -1) return null

        let cursor = parenEnd
        let returns = null

        returnArrow.lastIndex = cursor
        const arrow = returnArrow.exec(src)
        if (arrow) {
            const annotation = readTypeAnnotation(src, cursor + arrow[0].length)
            if (!annotation) return null
            returns = annotation.type
            cursor = annotation.end
        }

        tailRe.lastIndex = cursor
        const end = tailRe.exec(src)
        if (!end) return null

        return {
            start: i,
            end: cursor + end[0].length,
            groups: start.slice(1),
            args: src.slice(parenPos + 1, parenEnd - 1),
            returns
        }
    }
}

function splitTopLevel(str, separator) {
    const parts = []
    let depth = 0
    let current = ""

    for (let i = 0; i < str.length; i++) {
        const c = str[i]
        if (c === '"' || c === "'" || c === "`") {
            const quote = c
            current += c
            i++
            while (i < str.length) {
                current += str[i]
                if (str[i] === "\\") { i++; if (i < str.length) current += str[i]; i++; continue }
                if (str[i] === quote) break
                i++
            }
            continue
        }
        if (c === "(" || c === "[" || c === "{") depth++
        else if (c === ")" || c === "]" || c === "}") depth--
        else if (c === separator && depth === 0) { parts.push(current); current = ""; continue }
        current += c
    }
    if (current.trim()) parts.push(current)
    return parts
}

function topLevelArrow(str) {
    let depth = 0
    for (let i = 0; i < str.length - 1; i++) {
        const c = str[i]
        if (c === '"' || c === "'" || c === "`") {
            const quote = c
            i++
            while (i < str.length) { if (str[i] === "\\") { i += 2; continue } if (str[i] === quote) break; i++ }
            continue
        }
        if (c === "(" || c === "[" || c === "{") depth++
        else if (c === ")" || c === "]" || c === "}") depth--
        else if (depth === 0 && c === "=" && str[i + 1] === ">") return i
    }
    return -1
}

function matchMatcher(src, i) {
    if (i > 0 && /[\w$.]/.test(src[i - 1])) return null

    const re = /match\s*\(/y
    re.lastIndex = i
    const m = re.exec(src)
    if (!m || m.index !== i) return null

    const parenPos = i + m[0].length - 1
    const parenEnd = readBalanced(src, parenPos, "(", ")")
    if (parenEnd === -1) return null

    let j = parenEnd
    while (j < src.length && /\s/.test(src[j])) j++
    if (src[j] !== "{") return null

    const braceEnd = readBalanced(src, j)
    if (braceEnd === -1) return null

    return {
        start: i,
        end: braceEnd,
        scrutinee: src.slice(parenPos + 1, parenEnd - 1).trim(),
        body: src.slice(j + 1, braceEnd - 1)
    }
}

function topLevelWhen(str) {
    let depth = 0
    for (let i = 0; i < str.length; i++) {
        const c = str[i]
        if (c === '"' || c === "'" || c === "`") {
            const quote = c
            i++
            while (i < str.length) { if (str[i] === "\\") { i += 2; continue } if (str[i] === quote) break; i++ }
            continue
        }
        if (c === "(" || c === "[" || c === "{") depth++
        else if (c === ")" || c === "]" || c === "}") depth--
        else if (depth === 0 && str.startsWith("when", i) &&
            !/[\w$]/.test(str[i - 1] || "") && !/[\w$]/.test(str[i + 4] || "")) return i
    }
    return -1
}

// Recursively lower nested match expressions without touching strings.
function lowerMatches(str) {
    if (!str.includes("match")) return str

    const { tokens } = tokensFor(str)
    const edits = []

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index]
        if (token.type !== "name" || token.value !== "match") continue

        const found = matchMatcher(str, token.start)
        if (!found) continue

        edits.push({ start: found.start, end: found.end, replacement: buildMatch(found) })
        while (index + 1 < tokens.length && tokens[index + 1].start < found.end) index++
    }

    if (edits.length === 0) return str

    let out = ""
    let cursor = 0
    for (const edit of edits) {
        out += str.slice(cursor, edit.start) + edit.replacement
        cursor = edit.end
    }
    return out + str.slice(cursor)
}

function buildMatch({ scrutinee, body }) {
    const statements = []
    let fallback = "return undefined"

    for (const rawCase of splitTopLevel(body, ",")) {
        const arrow = topLevelArrow(rawCase)
        if (arrow === -1) continue

        const head = rawCase.slice(0, arrow).trim()
        const result = lowerMatches(rawCase.slice(arrow + 2).trim())
        if (!head || !result) continue

        const when = topLevelWhen(head)
        if (when !== -1) {
            const binding = head.slice(0, when).trim()
            const guard = head.slice(when + 4).trim()
            const bind = binding && binding !== "_" ? `const ${binding} = __match; ` : ""
            statements.push(`{ ${bind}if (${guard}) return ${result} }`)
        } else if (head === "_") {
            fallback = `return ${result}`
        } else {
            statements.push(`if (__match_eq__(__match, ${head})) return ${result}`)
        }
    }

    return `((__match) => { ${[...statements, fallback].join("; ")} })(${lowerMatches(scrutinee)})`
}

function declMatcher(keyword) {
    return (src, i) => {
        const re = new RegExp(`(export\\s+)?${keyword}\\s+([A-Z][\\w$]*)(?:\\s+extends\\s+([A-Z][\\w$]*))?\\s*\\{`, "y")
        re.lastIndex = i
        const m = re.exec(src)
        if (!m) return null

        const bracePos = i + m[0].length - 1
        const end = readBalanced(src, bracePos)
        if (end === -1) return null

        return { start: i, end, exportKw: m[1], name: m[2], extendsName: m[3], body: src.slice(bracePos + 1, end - 1) }
    }
}

const declarationHead = /\b(let|const|var|static)\s+(#?[\w$]+|\{[^{}]*\}|\[[^\[\]]*\])\s*:\s*/y

const structMethodHead = /([\w$]+)\s*\(/y

function structMethod(body, i) {
    structMethodHead.lastIndex = i
    const head = structMethodHead.exec(body)
    if (!head) return null

    const parenPos = i + head[0].length - 1
    const parenEnd = readBalanced(body, parenPos, "(", ")")
    if (parenEnd === -1) return null

    let brace = parenEnd
    while (brace < body.length && /\s/.test(body[brace])) brace++
    if (body[brace] !== "{") return null

    const end = readBalanced(body, brace)
    if (end === -1) return null

    return {
        name: head[1],
        params: body.slice(parenPos + 1, parenEnd - 1),
        body: body.slice(brace + 1, end - 1),
        end
    }
}

function parseStructBody(body) {
    const fieldLines = []
    const methods = []
    let i = 0

    while (i < body.length) {
        while (i < body.length && /[\s,]/.test(body[i])) i++
        if (i >= body.length) break

        const method = structMethod(body, i)
        if (method) {
            methods.push(`"${method.name}": function(${method.params}) {${method.body}}`)
            i = method.end
            continue
        }

        const start = i
        while (i < body.length && body[i] !== "\n") i++
        fieldLines.push(body.slice(start, i))
    }

    return { fieldLines, methods }
}

function structuralEdits(text) {
    return collectEdits(text, (collect, collectCustom) => {
        collectCustom(matchMatcher, buildMatch)

        collect(
            /use\s+(\*\s+as\s+[\w$]+|\{[^}]+\}|[a-zA-Z_$][\w$]*)\s+from\s+["']([^"']+)["']\s*;?/g,
            (_, name, source) =>
                `__use__(${JSON.stringify(name.trim())}, ${JSON.stringify(source)})\n`
        )
        collect(
            /use\s+(\*\s+as\s+[\w$]+|\{[^}]+\}|[a-zA-Z_$][\w$]*)\s+from\s+(@[\w$\/.-]+)\s*;?/g,
            (_, name, source) =>
                `__use__(${JSON.stringify(name.trim())}, ${JSON.stringify(source)})\n`
        )
        collect(
            /use\s+(@[\w$\/.-]+)\s*;?/g,
            (_, source) => `__use_all__(${JSON.stringify(source)})\n`
        )
        collect(
            /use\s+["']([^"']+)["']\s*;?/g,
            (_, source) => `__use_all__(${JSON.stringify(source)})\n`
        )

        collectCustom(
            declMatcher("struct"),
            ({ exportKw, name, extendsName, body }) => {
                const { fieldLines, methods } = parseStructBody(body)
                const schema = []
                const defaults = []

                for (let line of fieldLines) {
                    line = line.trim().replace(/,\s*$/, "").trim()
                    if (!line) continue

                    const idx = line.indexOf(":")
                    if (idx === -1) continue

                    const field = line.slice(0, idx).trim()
                    let rest = line.slice(idx + 1).trim()
                    if (!field) continue

                    const eq = rest.indexOf("=")
                    if (eq !== -1) {
                        const value = rest.slice(eq + 1).trim()
                        rest = rest.slice(0, eq).trim()
                        if (value) defaults.push(`"${field.replace(/^\*/, "").trim()}": () => (${value})`)
                    }

                    if (!rest) continue
                    schema.push(`"${field}": "${rest}"`)
                }

                const defaultsArg = defaults.length ? `{ ${defaults.join(", ")} }` : "{}"
                const args = [`"${name}"`, `{ ${schema.join(", ")} }`, "{}", defaultsArg]
                if (extendsName || methods.length) args.push(extendsName ? `"${extendsName}"` : "null")
                if (methods.length) args.push(`{ ${methods.join(", ")} }`)

                const decl = `const ${name} = __def_struct__(${args.join(", ")})`
                return exportKw ? `export ${decl}` : decl
            }
        )
        collectCustom(
            declMatcher("enum"),
            ({ exportKw, name, body }) => {
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

        collectCustom(
            (src, i) => {
                if (isInsideString(src, i)) return null

                declarationHead.lastIndex = i
                const head = declarationHead.exec(src)
                if (!head) return null

                // `export default const X: T = ...` is not valid JS as a single
                // statement; lower it to a typed declaration plus `export default X`.
                const leadingDefault = src.slice(0, i).match(/export\s+default\s+$/)
                const start = leadingDefault ? i - leadingDefault[0].length : i

                const annotation = readTypeAnnotation(src, i + head[0].length)
                if (!annotation) return null

                let equals = annotation.end
                while (equals < src.length && /\s/.test(src[equals])) equals++
                if (src[equals] !== "=" || src[equals + 1] === "=" || src[equals + 1] === ">") return null

                const { expr, start: exprStart, end } = extractExprRaw(src, equals + 1)
                return {
                    start, end, keyword: head[1], name: head[2], type: annotation.type,
                    expr, exprStart, defaultExport: !!leadingDefault
                }
            },
            ({ keyword, name, type, expr, exprStart, defaultExport }) => {
                const pattern = name.startsWith("{") || name.startsWith("[")
                // Keep the declaration exported so the module wrapper leaves it at
                // top level, then re-export the binding as default. Emitting a bare
                // `const` plus `export default X` would trap the `const` in the
                // module's try/catch, leaving the default export undefined.
                const prefix = defaultExport ? "export " : ""
                const head = pattern
                    ? `${prefix}${keyword} ${name} = __typed_pattern__(`
                    : `${prefix}${keyword} ${name} = __typed_variable__(`
                const tail = pattern ? `, "${type}")` : `, "${type}", "${name}")`
                const suffix = defaultExport ? `\nexport { ${name} as default }` : ""

                return {
                    replacement: `${head}${expr}${tail}${suffix}`,
                    spans: [{ at: head.length, from: exprStart, length: expr.length }]
                }
            }
        )

        collect(
            /(\w[\w$.]*(?:\[.*?\])?)\s*(?:=>\s*([\w$]+))?\s*\n((?:\s*\|(?!\|)[^\n]+\n?)+)/g,
            (match, source, alias, pipes) => {
                const steps = [...pipes.matchAll(/\|\s*([\w$]+)\(([^)]*)\)/g)]
                // Preserve non-pipe bars, such as multiline union types.
                if (steps.length === 0) return match

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

        collectCustom(
            (code, i) => {
                if (i > 0 && /[\w$]/.test(code[i - 1])) return null
                const match = code.slice(i).match(/^lock\s+const\s+([\w$]+)\s*=\s*/)
                if (!match) return null
                const name = match[1]
                const afterEq = i + match[0].length
                const expr = extractExpr(code, afterEq)
                return { start: i, end: afterEq + expr.length, name, expr }
            },
            ({ name, expr }) => `const ${name} = __lock_object__(${expr})`
        )

        collectCustom(
            (code, i) => {
                if (i > 0 && /[\w$]/.test(code[i - 1])) return null
                const match = code.slice(i).match(/^lock\s+(?!const\s)/)
                if (!match) return null
                const afterKeyword = i + match[0].length
                const expr = extractExpr(code, afterKeyword)
                return { start: i, end: afterKeyword + expr.length, expr }
            },
            ({ expr }) => `__lock_object__(${expr})`
        )

        collect(
            /\}\s*elif\s*\(/g,
            match => match.replace("elif", "else if")
        )

        collect(
            /mode\s+["']([^"']+)["']/,
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
    mapped = applyEdits(mapped, wordOperatorEdits(mapped.text))

    mapped = applyEdits(mapped, parseTypesEdits(mapped.text))

    mapped = applyEdits(mapped, operatorEdits(mapped.text, "sizeof", "__sizeof__"))
    mapped = applyEdits(mapped, operatorEdits(mapped.text, "kindof", "type"))
    mapped = applyEdits(mapped, operatorEdits(mapped.text, "empty", "__is_empty__"))
    mapped = applyEdits(mapped, operatorEdits(mapped.text, "copyof", "__copyof__"))
    mapped = applyBinaryOperator(mapped, "~/", "__intdiv__")

    mapped = applyEdits(mapped, parseComponentsEdits(mapped.text))

    mapped = applyEdits(mapped, functionEdits(mapped.text))

    mapped = applyEdits(mapped, structuralEdits(mapped.text))

    return { code: mapped.text, mapped, source: sourceFile }
}
