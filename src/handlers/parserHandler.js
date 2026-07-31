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
            const mismatch = types.map(t => `__argument_typed__(${a.name}, "${t}", "${a.name}") == false`).join(" && ")
            const expected = types.join(" or ")

            if (a.optional) {
                return `if (${a.name} !== undefined && ${a.name} !== null && (${mismatch})) throw new ArgumentDeclarationTypeError(\`${fnName}: argument "${a.name}" expected ${expected}, got \${type(${a.name})}\`)`
            }

            return `if (${mismatch}) throw new ArgumentDeclarationTypeError(\`function "${fnName}": argument<${i}> "${a.name}" expected ${expected}, got \${type(${a.name})}\`)`
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

function parseTypes(code) {
    let result = "";
    let i = 0;

    while (i < code.length) {
        if (!code.startsWith("type", i)) {
            result += code[i++];
            continue;
        }

        const start = i;
        i += 4;

        while (/\s/.test(code[i])) i++;

        const nameStart = i;
        while (/[A-Za-z0-9_$]/.test(code[i])) i++;

        const typeName = code.slice(nameStart, i);

        while (/\s/.test(code[i])) i++;

        // default
        if (code[i] === "=") {
            i++;

            let { expr, end } = extractExprForward(code, i);

            if(expr.startsWith("typeof")) expr = expr.split("typeof")[1].trim()

            result += `__type_def__("${typeName}", ${expr}, { type: "one-line-expr" })`;

            i = end;
            continue;
        }

        // func-like
        if (code[i] === "(") {
            const args = readBalanced(code, i, "(", ")");
            i = args.end;

            while (/\s/.test(code[i])) i++;

            const body = readBalanced(code, i, "{", "}");
            i = body.end;

            result += `__type_def__("${typeName}", (${args.content}) => {${body.content}})`;

            continue;
        }

        result += code[start];
        i = start + 1;
    }

    return result;
}

function readBalanced(code, start, open, close) {
    let depth = 0;
    let i = start;

    do {
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
    } while (depth > 0);

    return {
        content: code.slice(start + 1, i - 1),
        end: i
    };
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
    readBalanced
}