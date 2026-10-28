
export const ANY = Object.freeze({ kind: "any" })

export const named = name => name === "any" ? ANY : { kind: "named", name }
export const literal = value => ({ kind: "literal", value })
export const arrayOf = element => ({ kind: "array", element })
export const tupleOf = items => ({ kind: "tuple", items })
export const genericOf = (name, args) => name === "Array" && args.length === 1 ? arrayOf(args[0]) : { kind: "generic", name, args }
export const enumMember = (name, member) => ({ kind: "enumMember", name, member })
export const functionOf = (params, returns) => ({ kind: "function", params, returns })

function flatten(kind, types) {
    return types.flatMap(type => type.kind === kind ? type.types : [type])
}

export function unionOf(types) {
    const unique = []
    const seen = new Set()
    for (const type of flatten("union", types)) {
        if (type.kind === "any") return ANY
        const key = formatType(type)
        if (!seen.has(key)) { seen.add(key); unique.push(type) }
    }
    return unique.length === 1 ? unique[0] : { kind: "union", types: unique }
}

export function intersectionOf(types) {
    const all = flatten("intersection", types)
    return all.length === 1 ? all[0] : { kind: "intersection", types: all }
}

export const nullable = type => unionOf([type, named("null"), named("undefined")])

function tokenize(text) {
    const tokens = []
    let i = 0

    while (i < text.length) {
        const c = text[i]
        if (/\s/.test(c)) { i++; continue }

        if (c === '"' || c === "'") {
            let j = i + 1
            while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1
            if (j >= text.length) throw new SyntaxError(`unterminated string in type "${text}"`)
            tokens.push({ kind: "string", value: text.slice(i, j + 1) })
            i = j + 1
            continue
        }

        const number = /^-?\d+(?:\.\d+)?/.exec(text.slice(i))
        if (number && (c !== "-" || /\d/.test(text[i + 1]))) {
            tokens.push({ kind: "number", value: number[0] })
            i += number[0].length
            continue
        }

        const word = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/.exec(text.slice(i))
        if (word) {
            tokens.push({ kind: "name", value: word[0] })
            i += word[0].length
            continue
        }

        const pair = text.slice(i, i + 2)
        if (pair === "::" || pair === "[]" || pair === "=>") { tokens.push({ kind: pair }); i += 2; continue }
        if ("|&[]()<>,?:".includes(c)) { tokens.push({ kind: c }); i++; continue }

        throw new SyntaxError(`unexpected "${c}" in type "${text}"`)
    }
    return tokens
}

function readString(raw) {
    if (raw[0] === '"') {
        try { return JSON.parse(raw) } catch {   }
    }
    return raw.slice(1, -1).replace(/\\(.)/g, "$1")
}

class TypeParser {
    constructor(text) {
        this.text = text
        this.tokens = tokenize(text)
        this.pos = 0
    }

    peek(kind) { return this.tokens[this.pos]?.kind === kind }

    eat(kind) {
        if (!this.peek(kind)) return false
        this.pos++
        return true
    }

    expect(kind) {
        if (!this.eat(kind)) throw new SyntaxError(`expected "${kind}" in type "${this.text}"`)
    }

    parse() {
        const type = this.union()
        if (this.pos < this.tokens.length) throw new SyntaxError(`unexpected "${this.tokens[this.pos].value ?? this.tokens[this.pos].kind}" in type "${this.text}"`)
        return type
    }

    union() {
        this.eat("|")
        const types = [this.intersection()]
        while (this.eat("|")) types.push(this.intersection())
        return types.length === 1 ? types[0] : unionOf(types)
    }

    intersection() {
        const types = [this.postfix()]
        while (this.eat("&")) types.push(this.postfix())
        return intersectionOf(types)
    }

    postfix() {
        let type = this.primary()
        for (;;) {
            if (this.eat("[]")) type = arrayOf(type)
            else if (this.eat("?")) type = nullable(type)
            else return type
        }
    }

    list(close) {
        const items = []
        if (this.eat(close)) return items
        do items.push(this.union())
        while (this.eat(","))
        this.expect(close)
        return items
    }

    functionType() {
        const params = []
        if (!this.eat(")")) {
            do {
                let name = null
                if (this.tokens[this.pos]?.kind === "name" && this.tokens[this.pos + 1]?.kind === ":") {
                    name = this.tokens[this.pos].value
                    this.pos += 2
                }
                params.push({ name, type: this.union() })
            } while (this.eat(","))
            this.expect(")")
        }
        this.expect("=>")
        return functionOf(params, this.union())
    }

    primary() {
        const token = this.tokens[this.pos++]
        if (!token) throw new SyntaxError(`type "${this.text}" ends unexpectedly`)

        switch (token.kind) {
            case "(": {
                const start = this.pos
                try {
                    return this.functionType()
                } catch {
                    this.pos = start
                }
                const inner = this.union()
                this.expect(")")
                return inner
            }
            case "[": return tupleOf(this.list("]"))
            case "string": return literal(readString(token.value))
            case "number": return literal(Number(token.value))
            case "name":
                if (token.value === "true" || token.value === "false") return literal(token.value === "true")
                if (this.eat("::")) {
                    const member = this.tokens[this.pos++]
                    if (member?.kind !== "name") throw new SyntaxError(`expected an enum member in type "${this.text}"`)
                    return enumMember(token.value, member.value)
                }
                if (this.eat("<")) return genericOf(token.value, this.list(">"))
                return named(token.value)
        }
        throw new SyntaxError(`unexpected "${token.kind}" in type "${this.text}"`)
    }
}

const parsed = new Map()

export function parseType(label) {
    let type = parsed.get(label)
    if (!type) {
        type = label.trim() === "" ? ANY : new TypeParser(label).parse()
        parsed.set(label, type)
    }
    return type
}

export function readType(label) {
    try {
        return parseType(label)
    } catch {
        return named(label.trim())
    }
}

function isNullish(type) {
    return type.kind === "named" && (type.name === "null" || type.name === "undefined")
}

function wrap(type) {
    const text = formatType(type)
    return type.kind === "union" || type.kind === "intersection" || type.kind === "function" || text.endsWith("?") ? `(${text})` : text
}

export function formatType(type) {
    switch (type.kind) {
        case "any": return "any"
        case "named": return type.name
        case "literal": return typeof type.value === "string" ? JSON.stringify(type.value) : String(type.value)
        case "array": return `${wrap(type.element)}[]`
        case "tuple": return `[${type.items.map(formatType).join(", ")}]`
        case "generic": return `${type.name}<${type.args.map(formatType).join(", ")}>`
        case "enumMember": return `${type.name}::${type.member}`
        case "intersection": return type.types.map(wrap).join(" & ")
        case "function": {
            const params = type.params.map(param => param.name ? `${param.name}: ${formatType(param.type)}` : formatType(param.type))
            return `(${params.join(", ")}) => ${formatType(type.returns)}`
        }
        case "union": {
            const rest = type.types.filter(part => !isNullish(part))
            const optional = rest.length === 1 && type.types.length === 3 &&
                type.types.some(part => part.name === "null") && type.types.some(part => part.name === "undefined")
            if (optional) return `${wrap(rest[0])}?`
            return type.types.map(part => part.kind === "intersection" || part.kind === "function" ? `(${formatType(part)})` : formatType(part)).join(" | ")
        }
    }
    return "any"
}

export function substituteType(type, bound) {
    switch (type.kind) {
        case "named": return bound.get(type.name) ?? type
        case "array": return arrayOf(substituteType(type.element, bound))
        case "tuple": return tupleOf(type.items.map(item => substituteType(item, bound)))
        case "generic": return genericOf(type.name, type.args.map(arg => substituteType(arg, bound)))
        case "union": return unionOf(type.types.map(part => substituteType(part, bound)))
        case "intersection": return intersectionOf(type.types.map(part => substituteType(part, bound)))
        case "function":
            return functionOf(type.params.map(param => ({ ...param, type: substituteType(param.type, bound) })), substituteType(type.returns, bound))
    }
    return type
}

export function referenceName(type) {
    if (type.kind === "named" || type.kind === "generic" || type.kind === "enumMember") return type.name
    if (type.kind === "array") return referenceName(type.element)
    return null
}
