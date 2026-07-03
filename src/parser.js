import MagicString from "magic-string"

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

export function preprocess(code, sourceFile = "input.ps") {
    let preprocessed = stripComments(code)
    preprocessed = replaceOperator(preprocessed, "sizeof", "__sizeof__")
    preprocessed = replaceOperator(preprocessed, "kindof", "type")
    preprocessed = replaceOperator(preprocessed, "empty", "__is_empty__")

    const s = new MagicString(preprocessed)

    const replacements = []

    function collect(pattern, handler) {
        const re = new RegExp(pattern.source,
            pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"
        )
        let match
        while ((match = re.exec(preprocessed)) !== null) {
            replacements.push({
                start: match.index,
                end:   match.index + match[0].length,
                replacement: handler(...match)
            })
        }
    }

    function collectCustom(matcher, handler) {
        let i = 0
        while (i < preprocessed.length) {
            const result = matcher(preprocessed, i)
            if (!result) { i++; continue }

            replacements.push({
                start: result.start,
                end: result.end,
                replacement: handler(result)
            })
            i = result.end
        }
    }

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
    // 

    collect(
        /component\s+([a-zA-Z_$][\w$]*)\s*\{([\s\S]*?)\n\}/g,
        (_, name, body) => {
            const jsxMatch = body.match(/^\s*(<[\s\S]+>[\s\S]*<\/[\s\S]+>|<[^>]+\/>)\s*$/)
            if (jsxMatch) {
                const escaped = jsxMatch[1].trim().replace(/`/g, "\\`")
                return `class ${name} extends Component {
  static render(variables) {
    let HTML = \`${escaped}\`
    Object.keys(variables).forEach(v => {
      HTML = HTML.replaceAll(new RegExp("{" + v + "}", "gm"), variables[v])
    })
    return HTML
  }
}`
            }
            return `class ${name} {${body}\n}`
        }
    )
    collect(
        /struct\s+([A-Z][\w$]*)\s*\{([\s\S]*?)\}/g,
        (_, name, body) => {
            const fields = body
                .split("\n")
                .map(line => line.trim())
                .filter(Boolean)
                .map(line => {
                    const idx = line.indexOf(":")
                    if (idx === -1) return null

                    const field = line.slice(0, idx).trim()
                    const type = line.slice(idx + 1).trim()

                    if (!field || !type) return null

                    return `"${field}": "${type}"`
                })
                .filter(Boolean)
                .join(", ")

            return `__def_struct__("${name}", { ${fields} })`
        }
    )
    collect(
        /enum\s+([A-Z][\w$]*)\s*\{([\s\S]*?)\}/g,
        (_, name, body) => {
            const fields = body
                .split("\n")
                .map(line => line.trim())
                .filter(Boolean)
                .map(line => {
                    const idx = line.indexOf(":")

                    if (idx === -1) {
                        const field = line.trim()
                        return `"${field}": undefined`
                    }
                    const field = line.slice(0, idx).trim()
                    const type = line.slice(idx + 1).trim()

                    if (!field || !type) return null

                    return `"${field}": ${type}`
                })
                .filter(Boolean)
                .join(", ")

            return `__def_enum__("${name}", { ${fields} })`
        }
    )

    // capitalized types (structs/classes)
    collect(
        /\b(let|const|var)\s+([\w$]+)\s*:\s*[A-Z][\w$]*(?:<[A-Z][\w$]*>)?\s*=/g,
        (_, keyword, name) => `${keyword} ${name} =`
    )
    // 

    // decl w/ type
    collectCustom(
        (src, i) => {
            const re = /\b(let|const|var|static)\s+(#?[\w$]+)\s*:\s*([\w$[\]]+(?:<[\w$]+>)?(?:\s*\|\s*[\w$[\]]+(?:<[\w$]+>)?)*)\s*=/y
            re.lastIndex = i
            const m = re.exec(src)
            if (!m) return null
            const { expr, end } = extractExprRaw(src, i + m[0].length)
            return { start: i, end, keyword: m[1], name: m[2], type: m[3], expr }
        },
        ({ keyword, name, type, expr }) =>
            `${keyword} ${name} = __typed_variable__(${expr}, "${type}", "${name}")`
    )

    // reassign typed
    collectCustom(
        (src, i) => {
            const re = /\b([\w$]+)\s*=/y
            re.lastIndex = i
            const m = re.exec(src)
            if (!m) return null
            if ('=+-*/%&|^<>!'.includes(src[m.index + m[0].length])) return null
            const { expr, end } = extractExprRaw(src, i + m[0].length)
            return { start: i, end, name: m[1], expr }
        },
        ({ name, expr }) =>
            `${name} = __typed_variable_check__("${name}", ${expr})`
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
    // 

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
    //

    // functions declaration
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

    // async method: It's the same as the default method, but for async
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

    // default method: indented - class method (bare), unindented - top-level (function)
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
    //

    // arrow functions (=> { ... })
    collect(
        /\b(let|const|var)\s+([\w$]+)\s*=\s*(async\s*)?\(([^)]*)\)\s*=>\s*\{/g,
        (match, keyword, name, asyncKw, args) => {
            const parsed = parseTypedArgs(args)
            const { signature, checks } = buildTypedArgsResult(parsed, name)
            if (!checks) return `${keyword} ${name} = ${asyncKw ?? ""}(${signature}) => {`
            return `${keyword} ${name} = ${asyncKw ?? ""}(${signature}) => {\n    ${checks}`
        }
    )

    // arrow functions (=> x, w/o brackets)
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
    //

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
    //

    replacements.sort((a, b) => a.start - b.start)

    const filtered = []
    let lastEnd = 0

    for (const r of replacements) {
        if (r.start >= lastEnd) {
            filtered.push(r)
            lastEnd = r.end
        }
    }

    for (const { start, end, replacement } of filtered) {
        s.overwrite(start, end, replacement)
    }

    const result = s.toString()
    const map = s.generateMap({
        source: sourceFile,
        includeContent: true,
        hires: true
    })

    return { code: result, map }
}

function extractExpr(str, startPos) {
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

        if (ch === "(" || ch === "[" || ch === "{") {
            depth++
            i++
            continue
        }
        if (ch === ")" || ch === "]" || ch === "}") {
            if (depth === 0) break
            depth--
            i++
            continue
        }

        if (depth === 0) {
            const two = str.slice(i, i + 2)
            if (["==", "!=", ">=", "<=", "&&", "||", "??"].includes(two)) break
            if (["+", "-", "*", "/", "%", "<", ">", "?", ":", ";", ",", "\n"].includes(ch)) break
        }

        i++
    }

    return str.slice(startPos, i).trim()
}

function extractExprRaw(str, startPos) {
    let i = startPos
    while (i < str.length && (str[i] === ' ' || str[i] === '\t')) i++
    const contentStart = i

    let depth = 0
    let ternaryDepth = 0

    while (i < str.length) {
        const ch = str[i]
        const two = str.slice(i, i + 2)

        if (ch === '"' || ch === "'" || ch === '`') {
            const quote = ch
            i++
            while (i < str.length) {
                if (str[i] === '\\') { i += 2; continue }

                if (quote === '`' && str[i] === '$' && str[i+1] === '{') {
                    i += 2; depth++; continue
                }
                if (str[i] === quote) { i++; break }
                i++
            }
            continue
        }

        if (ch === '(' || ch === '[' || ch === '{') { depth++; i++; continue }

        if (ch === ')' || ch === ']' || ch === '}') {
            if (depth === 0) break
            depth--; i++; continue
        }

        if (depth === 0) {
            if (two === '=>') { i += 2; continue }

            if (['==', '!=', '>=', '<=', '&&', '||', '??',
                 '+=', '-=', '*=', '/=', '**'].includes(two)) {
                i += 2; continue
            }

            if ((ch === '-' || ch === '+') && i === contentStart) { i++; continue }

            if ([';', ',', '\n'].includes(ch)) break

            if (ch === '?') { ternaryDepth++; i++; continue }

            if (ch === ':') {
                if (ternaryDepth > 0) { ternaryDepth--; i++; continue }
                break
            }
        }

        i++
    }

    return {
        expr: str.slice(contentStart, i).trim(),
        end: i
    }
}

function replaceOperator(code, keyword, fn) {
    let result = ""
    let i = 0

    while (i < code.length) {
        const slice = code.slice(i)
        const match = slice.match(new RegExp(`^${keyword}\\s+`))

        if (match) {
            const afterKeyword = i + match[0].length
            const expr = extractExpr(code, afterKeyword)
            result += `${fn}(${expr})`
            i = afterKeyword + expr.length
            continue
        }

        result += code[i]
        i++
    }

    return result
}

function parseTypedArgs(argsStr) {
    const args = []
    let depth = 0
    let current = ""

    for (let i = 0; i < argsStr.length; i++) {
        const ch = argsStr[i]
        if (ch === "(" || ch === "[" || ch === "{") { depth++; current += ch; continue }
        if (ch === ")" || ch === "]" || ch === "}") { depth--; current += ch; continue }
        if (ch === "," && depth === 0) {
            args.push(current.trim())
            current = ""
            continue
        }
        current += ch
    }
    if (current.trim()) args.push(current.trim())

    return args.map(arg => {
        const match = arg.match(/^(\w+)(\?)?\s*(?::\s*([\w$]+(?:\s*\|\s*[\w$]+)*))?\s*(?:=\s*(.+))?$/)
        if (!match) return { raw: arg, name: arg, type: null, optional: false, default: null }

        const [, name, optional, type, def] = match
        return {
            raw: arg,
            name,
            type: type ?? null,
            optional: !!optional,
            default: def ?? null
        }
    })
}

function inferDefaultType(def) {
    const trimmed = def.trim()

    if (/^-?\d+$/.test(trimmed)) return "int"
    if (/^-?\d+\.\d+$/.test(trimmed)) return "float"
    if (trimmed === "true" || trimmed === "false") return "bool"
    if (/^(["'`])[\s\S]*\1$/.test(trimmed)) return "string"

    return null
}

function buildTypedArgsResult(parsedArgs, fnName) {
    for (const a of parsedArgs) {
        if (!a.type || a.type === "any" || a.default === null) continue

        const types = a.type.split("|").map(t => t.trim())
        const inferred = inferDefaultType(a.default)

        if (inferred && !types.includes(inferred)) {
            console.error([
                "",
                `TypeError: default value of argument "${a.name}" in "${fnName}" is ${inferred}, but declared type is "${a.type}"`,
                `    ${a.raw}`,
                "",
            ].join("\n"))
            process.exit(1)
        }
    }

    const signature = parsedArgs.map(a => {
        if (a.default !== null) return `${a.name} = ${a.default}`
        return a.name
    }).join(", ")

    const checks = parsedArgs
        .filter(a => a.type && a.type !== "any")
        .map((a, i) => {
            const types = a.type.split("|").map(t => t.trim())
            const mismatch = types.map(t => `type(${a.name}) !== "${t}"`).join(" && ")
            const expected = types.join(" or ")

            if (a.optional) {
                return `if (${a.name} !== undefined && ${a.name} !== null && (${mismatch})) throw new ArgumentDeclarationTypeError(\`${fnName}: argument "${a.name}" expected ${expected}, got \${type(${a.name})}\`)`
            }

            return `if (${mismatch}) throw new ArgumentDeclarationTypeError(\`function "${fnName}": argument<${i}> "${a.name}" expected ${expected}, got \${type(${a.name})}\`)`
        })
        .join("\n    ")

    return { signature, checks }
}