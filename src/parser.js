import MagicString from "magic-string"

import {
    extractExpr,
    extractExprBackward,
    extractExprRaw,
    parseTypedArgs,
    isInsideString,
    replaceBinaryOperator,
    replaceOperator,
    parseTypes,
    buildTypedArgsResult
} from "./handlers/parserHandler.js"

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

function runStage(text, register) {
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

    replacements.sort((a, b) => a.start - b.start)

    const filtered = []
    let lastEnd = 0
    for (const r of replacements) {
        if (r.start >= lastEnd) {
            filtered.push(r)
            lastEnd = r.end
        }
    }

    const s = new MagicString(text)
    for (const { start, end, replacement } of filtered) {
        s.overwrite(start, end, replacement)
    }

    return s.toString()
}

export function preprocess(code, sourceFile = "input.ps") {
    let preprocessed = stripComments(code)
    preprocessed = replaceOperator(preprocessed, "sizeof", "__sizeof__")
    preprocessed = replaceOperator(preprocessed, "kindof", "type")
    preprocessed = replaceOperator(preprocessed, "empty", "__is_empty__")
    preprocessed = replaceOperator(preprocessed, "copyof", "__copyof__")
    preprocessed = replaceBinaryOperator(preprocessed, "~/", "__intdiv__")
    preprocessed = parseTypes(preprocessed)

    // functions/methods/arrows
    preprocessed = runStage(preprocessed, (collect, collectCustom) => {
        // type def
        collect(
            /^type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)\s*\{([\s\S]*?)^\}/gm,
            (_, typeName, typeValue) => {
                return ``
            }
        )
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
    })

    // struct/component/decl w/ type/lock
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

    // component
    collect(
        /component\s+([a-zA-Z_$][\w$]*)\s*\{([\s\S]*?)\n\}/g,
        (_, name, body) => {
            const jsxMatch = body.match(/^\s*(<[\s\S]+>[\s\S]*<\/[\s\S]+>|<[^>]+\/>)\s*$/)
            if (jsxMatch) {
                const escaped = jsxMatch[1].trim().replace(/`/g, "\\`")
                return `class ${name} extends Component {
  static render(variables) {
    let HTML = \`${escaped}\`
    if(variables != undefined) {
        Object.keys(variables).forEach(v => {
        HTML = HTML.replaceAll(new RegExp("{" + v + "}", "gm"), variables[v])
        })
    }
    return HTML
  }
}`
            }
            return `class ${name} {${body}\n}`
        }
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
            if (isInsideString(src, i)) return null;

            const re = /\b([\w$]+)\s*=/y
            re.lastIndex = i
            const m = re.exec(src)
            if (!m) return null
            if ('=+-*/%&|^<>!'.includes(src[m.index + m[0].length])) return null

            let j = i - 1
            while (j >= 0 && /\s/.test(src[j])) j--
            if (src[j] === ':') return null

            if (/\b(let|const|var)\s*$/.test(src.slice(Math.max(0, i - 8), i))) return null

            {
                let depth = 0
                let k = i - 1
                while (k >= 0) {
                    const c = src[k]
                    if (c === ';' || c === '{' || c === '}') break
                    if (c === ')') depth++
                    else if (c === '(') {
                        if (depth === 0) return null
                        depth--
                    }
                    k--
                }
            }

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