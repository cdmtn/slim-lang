import { TypeDefError } from "../external/classErrors.js"

const LEADING_STATEMENT_KEYWORDS = new Set([
    "return", "throw", "yield", "case", "do", "else",
    "in", "of", "instanceof"
])

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

                if (quote === '`' && str[i] === '$' && str[i + 1] === '{') {
                    i += 2
                    let interpDepth = 1
                    while (i < str.length && interpDepth > 0) {
                        const c = str[i]
                        if (c === '\\') { i += 2; continue }

                        if (c === '"' || c === "'" || c === '`') {
                            const innerQuote = c
                            i++
                            while (i < str.length) {
                                if (str[i] === '\\') { i += 2; continue }
                                if (str[i] === innerQuote) { i++; break }
                                i++
                            }
                            continue
                        }

                        if (c === '{') { interpDepth++; i++; continue }
                        if (c === '}') { interpDepth--; i++; continue }
                        i++
                    }
                    continue
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
        const match = arg.match(/^([$A-Z_a-z][$\w]*)(\?)?\s*(?::\s*([\w$]+(?:::[\w$]+)?(?:<[^<>]+>)?(?:\[\])?(?:\s*\|\s*[\w$]+(?:::[\w$]+)?(?:<[^<>]+>)?(?:\[\])?)*))?\s*(?:=\s*([\s\S]+))?$/)
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
    const signature = parsedArgs.map(a => {
        if (a.default !== null) return `${a.name} = ${a.default}`
        return a.name
    }).join(", ")

    const checks = parsedArgs
        .filter(a => a.type && a.type !== "any")
        .map((a, i) => {
            const expected = a.type.split("|").map(t => t.trim()).join(" or ")
            const message = a.optional
                ? `${fnName}: argument "${a.name}" expected ${expected}`
                : `function "${fnName}": argument<${i}> "${a.name}" expected ${expected}`

            return `__typed_parameter__(${a.name}, "${a.type}", "${a.name}", ${a.optional}, \`${message}, got \${type(${a.name})}\`)`
        })
        .join("\n    ")

    return { signature, checks }
}

function isInsideString(src, index) {
    let quote = null;

    for (let i = 0; i < index; i++) {
        const c = src[i];

        if (c === "\\" && quote) {
            i++;
            continue;
        }

        if (!quote) {
            if (c === '"' || c === "'" || c === "`") {
                quote = c;
            }
        } else if (c === quote) {
            quote = null;
        }
    }

    return quote !== null;
}

function extractExprBackward(str, endPosExclusive) {
    let i = endPosExclusive
    while (i > 0 && /\s/.test(str[i - 1])) i--
    const contentEnd = i

    let depth = 0

    while (i > 0) {
        const ch = str[i - 1]

        if (ch === '"' || ch === "'" || ch === "`") break

        if (ch === ")" || ch === "]" || ch === "}") { depth++; i--; continue }
        if (ch === "(" || ch === "[" || ch === "{") {
            if (depth === 0) break
            depth--; i--; continue
        }

        if (depth === 0) {
            const two = str.slice(Math.max(0, i - 2), i)
            if (["==", "!=", ">=", "<=", "&&", "||", "??", "=>"].includes(two)) break
            if (["+", "-", "*", "/", "%", "<", ">", "=", "?", ":", ";", ",", "\n"].includes(ch)) break
        }

        i--
    }

    let start = i
    while (start < contentEnd && /\s/.test(str[start])) start++

    for (;;) {
        const m = str.slice(start, contentEnd).match(/^([A-Za-z$_][\w$]*)\s+/)
        if (!m || !LEADING_STATEMENT_KEYWORDS.has(m[1])) break
        start += m[0].length
    }

    return { expr: str.slice(start, contentEnd).trim(), start }
}

function extractExprForward(str, startPos) {
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

function replaceBinaryOperator(code, token, fn) {
    let result = code
    let searchFrom = result.length

    while (searchFrom >= 0) {
        const idx = result.lastIndexOf(token, searchFrom)
        if (idx === -1) break
        searchFrom = idx - 1

        if (isInsideString(result, idx)) continue

        const { expr: left, start: leftStart } = extractExprBackward(result, idx)
        const { expr: right, end: rightEnd } = extractExprForward(result, idx + token.length)

        if (!left || !right) continue

        result = result.slice(0, leftStart) + `${fn}(${left}, ${right})` + result.slice(rightEnd)
    }

    return result
}

function readTypeExtends(code, i) {
    while (/\s/.test(code[i])) i++;

    if (!code.startsWith("extends", i)) {
        return {
            end: i,
            extends: null
        };
    }

    i += "extends".length;

    while (/\s/.test(code[i])) i++;

    const start = i;

    while (/[A-Za-z0-9_$]/.test(code[i])) i++;

    return {
        end: i,
        extends: code.slice(start, i)
    };
}

function parseTypesEdits(code) {
    const edits = [];
    let i = 0;
    const isIdentifierPart = char => !!char && /[A-Za-z0-9_$]/.test(char)

    while (i < code.length) {
        if (
            !code.startsWith("type", i) ||
            isIdentifierPart(code[i - 1]) ||
            isIdentifierPart(code[i + 4])
        ) {
            i++;
            continue;
        }

        const start = i;
        i += 4;

        while (/\s/.test(code[i])) i++;

        const nameStart = i;
        while (isIdentifierPart(code[i])) i++;

        const typeName = code.slice(nameStart, i);

        if (!typeName) {
            i = start + 1;
            continue;
        }

        while (/\s/.test(code[i])) i++;

        // default
        if (code[i] === "=") {
            i++;

            let { expr, end } = extractExprForward(code, i);

            const finalArgs = {}

            if(expr.startsWith("typeof")) expr = expr.split("typeof")[1].trim()
            if(expr.startsWith("extends")) {
                const extendsObj = expr.split("extends")[1]

                finalArgs["extends"] = extendsObj.trim()
                expr = `"${extendsObj.trim()}"`
            }

            finalArgs["type"] = "one-line-expr"

            edits.push({
                start,
                end,
                replacement: `const ${typeName} = __type_def__("${typeName}", ${expr}, ${Object.keys(finalArgs).length > 0 ? JSON.stringify(finalArgs) : ""})`
            });

            i = end;
            continue;
        }

        // func-like
        if (code[i] === "(") {
            const args = readBalanced(code, i, "(", ")");
            i = args.end;

            const ext = readTypeExtends(code, i);
            i = ext.end;

            const finalArgs = {}

            if(ext.extends) {
                finalArgs["extends"] = ext.extends
            }

            while (/\s/.test(code[i])) i++;

            const body = readBalanced(code, i, "{", "}");
            i = body.end;

            let bodyContent = body.content.trim()

            const normalizedBody = bodyContent.replace(/;\s*$/, "").trim()
            if (!/^return(?:\s+[\s\S]+)?$/.test(normalizedBody)) {
                throw new TypeDefError(`The "${typeName}" type body must contain exactly one return statement`)
            }

            if (normalizedBody === "return") bodyContent = "return true"

            edits.push({
                start,
                end: i,
                replacement: `const ${typeName} = __type_def__("${typeName}", (${args.content}) => {${bodyContent}}, ${Object.keys(finalArgs).length > 0 ? JSON.stringify(finalArgs) : "{}"})`
            });

            continue;
        }

        i = start + 1;
    }

    return edits;
}

function applyStringEdits(code, edits) {
    let out = "";
    let cursor = 0;
    for (const { start, end, replacement } of edits) {
        out += code.slice(cursor, start) + replacement;
        cursor = end;
    }
    return out + code.slice(cursor);
}

function parseTypes(code) {
    return applyStringEdits(code, parseTypesEdits(code));
}

function readBalanced(code, start, open, close) {
    let depth = 0;
    let i = start;

    while (i < code.length) {
        const ch = code[i];

        if (ch === '"' || ch === "'" || ch === "`") {
            const quote = ch;
            i++;

            while (i < code.length) {
                if (code[i] === "\\") {
                    i += 2;
                    continue;
                }

                if (code[i] === quote) {
                    break;
                }

                i++;
            }
        }

        if (code[i] === open) depth++;
        if (code[i] === close) depth--;

        i++;
        if (depth === 0) break
    }

    if (depth !== 0) {
        throw new TypeDefError(`Unclosed "${open}" in type declaration`)
    }

    return {
        content: code.slice(start + 1, i - 1),
        end: i
    };
}

function replaceCondOperator(code, operator, replacement) {
    let out = ""
    let state = "code"
    let depth = 0

    const isWord = c => c && /[A-Za-z0-9_$]/.test(c)

    for (let i = 0; i < code.length; i++) {
        const c = code[i]
        const n = code[i + 1]

        if (state === "code") {
            if (c === "'") {
                state = "single"
                out += c
                continue
            }

            if (c === '"') {
                state = "double"
                out += c
                continue
            }

            if (c === "`") {
                state = "template"
                out += c
                continue
            }

            if (c === "/" && n === "/") {
                state = "lineComment"
                out += "//"
                i++
                continue
            }

            if (c === "/" && n === "*") {
                state = "blockComment"
                out += "/*"
                i++
                continue
            }

            if (
                code.startsWith(operator, i) &&
                !isWord(code[i - 1]) &&
                !isWord(code[i + operator.length])
            ) {
                out += replacement
                i += operator.length - 1
                continue
            }

            out += c
            continue
        }

        if (state === "single") {
            out += c
            if (c === "\\" && n) {
                out += n
                i++
            } else if (c === "'") {
                state = "code"
            }
            continue
        }

        if (state === "double") {
            out += c
            if (c === "\\" && n) {
                out += n
                i++
            } else if (c === '"') {
                state = "code"
            }
            continue
        }

        if (state === "template") {
            if (c === "$" && n === "{") {
                state = "templateExpr"
                depth = 1
                out += "${"
                i++
                continue
            }

            out += c

            if (c === "\\" && n) {
                out += n
                i++
            } else if (c === "`") {
                state = "code"
            }

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
                out += replacement
                i += operator.length - 1
                continue
            }

            out += c

            if (depth === 0)
                state = "template"

            continue
        }

        if (state === "lineComment") {
            out += c
            if (c === "\n")
                state = "code"
            continue
        }

        if (state === "blockComment") {
            out += c
            if (c === "*" && n === "/") {
                out += "/"
                i++
                state = "code"
            }
        }
    }

    return out
}

export {
    extractExpr,
    extractExprRaw,
    extractExprBackward,
    replaceBinaryOperator,
    replaceOperator,
    parseTypedArgs,
    buildTypedArgsResult,
    inferDefaultType,
    isInsideString,
    parseTypes,
    parseTypesEdits,
    readBalanced,
    replaceCondOperator
}
