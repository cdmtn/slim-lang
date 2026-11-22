
export const ANY = Object.freeze({ kind: "any" })

export const named = name => name === "any" ? ANY : { kind: "named", name }
export const literal = value => ({ kind: "literal", value })
export const arrayOf = element => ({ kind: "array", element })
export const tupleOf = items => ({ kind: "tuple", items })
export const genericOf = (name, args) => name === "Array" && args.length === 1 ? arrayOf(args[0]) : { kind: "generic", name, args }
export const enumMember = (name, member) => ({ kind: "enumMember", name, member })
export const functionOf = (params, returns) => ({ kind: "function", params, returns })
export const shapeOf = fields => ({ kind: "shape", fields })
export const keyofOf = type => ({ kind: "keyof", type })
export const indexOf = (object, index) => ({ kind: "index", object, index })
export const readonlyOf = type => type.kind === "array" || type.kind === "tuple" ? { ...type, readonly: true } : type
const keepReadonly = (type, result) => type.readonly ? readonlyOf(result) : result

const isNever = type => type.kind === "named" && type.name === "never"

function flatten(kind, types) {
    return types.flatMap(type => type.kind === kind ? type.types : [type])
}

export function unionOf(types) {
    const unique = []
    const seen = new Set()
    const all = flatten("union", types)
    const present = all.some(type => !isNever(type)) ? all.filter(type => !isNever(type)) : all
    for (const type of present) {
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

        if (text.startsWith("...", i)) { tokens.push({ kind: "..." }); i += 3; continue }
        const pair = text.slice(i, i + 2)
        if (pair === "::" || pair === "[]" || pair === "=>") { tokens.push({ kind: pair }); i += 2; continue }
        if ("|&[]()<>,?:{};".includes(c)) { tokens.push({ kind: c }); i++; continue }

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
        const next = this.tokens[this.pos + 1]
        if (this.tokens[this.pos]?.kind === "name" && this.tokens[this.pos].value === "readonly" && (next?.kind === "name" || next?.kind === "[" || next?.kind === "(")) {
            this.pos++
            return readonlyOf(this.postfix())
        }
        if (this.tokens[this.pos]?.kind === "name" && this.tokens[this.pos].value === "keyof" && (next?.kind === "name" || next?.kind === "(" || next?.kind === "{")) {
            this.pos++
            return keyofOf(this.postfix())
        }
        let type = this.primary()
        for (;;) {
            if (this.eat("[]")) type = arrayOf(type)
            else if (this.eat("[")) {
                type = indexOf(type, this.union())
                this.expect("]")
            }
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
                const rest = this.eat("...")
                const optional = !rest && this.tokens[this.pos]?.kind === "name" && this.tokens[this.pos + 1]?.kind === "?" && this.tokens[this.pos + 2]?.kind === ":"
                if (optional || (this.tokens[this.pos]?.kind === "name" && this.tokens[this.pos + 1]?.kind === ":")) {
                    name = this.tokens[this.pos].value
                    this.pos += optional ? 3 : 2
                }
                const type = this.union()
                params.push(rest ? { name, type, rest } : optional ? { name, type, optional } : { name, type })
                if (rest && !this.peek(")")) throw new SyntaxError(`a rest parameter must come last in type "${this.text}"`)
            } while (this.eat(","))
            this.expect(")")
        }
        this.expect("=>")
        return functionOf(params, this.union())
    }

    shape() {
        const fields = []
        while (!this.eat("}")) {
            const token = this.tokens[this.pos++]
            if (token?.kind !== "name" && token?.kind !== "string") throw new SyntaxError(`expected a field name in type "${this.text}"`)
            const name = token.kind === "string" ? readString(token.value) : token.value
            const optional = this.eat("?")
            this.expect(":")
            fields.push({ name, type: this.union(), optional })
            if (!this.eat(",") && !this.eat(";") && !this.peek("}")) throw new SyntaxError(`expected "," in type "${this.text}"`)
        }
        return shapeOf(fields)
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
            case "{": return this.shape()
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
    return type.kind === "union" || type.kind === "intersection" || type.kind === "function" || type.kind === "keyof" || text.endsWith("?") ? `(${text})` : text
}

export function formatType(type) {
    switch (type.kind) {
        case "any": return "any"
        case "named": return type.name
        case "literal": return typeof type.value === "string" ? JSON.stringify(type.value) : String(type.value)
        case "array": return `${type.readonly ? "readonly " : ""}${wrap(type.element)}[]`
        case "tuple": return `${type.readonly ? "readonly " : ""}[${type.items.map(formatType).join(", ")}]`
        case "generic": return `${type.name}<${type.args.map(formatType).join(", ")}>`
        case "enumMember": return `${type.name}::${type.member}`
        case "shape": {
            if (type.fields.length === 0) return "{}"
            const fields = type.fields.map(field => {
                const name = /^[A-Za-z_$][\w$]*$/.test(field.name) ? field.name : JSON.stringify(field.name)
                return `${name}${field.optional ? "?" : ""}: ${formatType(field.type)}`
            })
            return `{ ${fields.join(", ")} }`
        }
        case "intersection": return type.types.map(wrap).join(" & ")
        case "keyof": return `keyof ${wrap(type.type)}`
        case "index": return `${wrap(type.object)}[${formatType(type.index)}]`
        case "function": {
            const params = type.params.map(param => (param.rest ? "..." : "") + (param.name ? `${param.name}${param.optional ? "?" : ""}: ${formatType(param.type)}` : formatType(param.type)))
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
        case "array": return keepReadonly(type, arrayOf(substituteType(type.element, bound)))
        case "tuple": return keepReadonly(type, tupleOf(type.items.map(item => substituteType(item, bound))))
        case "generic": return genericOf(type.name, type.args.map(arg => substituteType(arg, bound)))
        case "union": return unionOf(type.types.map(part => substituteType(part, bound)))
        case "intersection": return intersectionOf(type.types.map(part => substituteType(part, bound)))
        case "shape": return shapeOf(type.fields.map(field => ({ ...field, type: substituteType(field.type, bound) })))
        case "function":
            return functionOf(type.params.map(param => ({ ...param, type: substituteType(param.type, bound) })), substituteType(type.returns, bound))
        case "keyof": return keyofOf(substituteType(type.type, bound))
        case "index": return indexOf(substituteType(type.object, bound), substituteType(type.index, bound))
    }
    return type
}

export function referenceName(type) {
    if (type.kind === "named" || type.kind === "generic" || type.kind === "enumMember") return type.name
    if (type.kind === "array") return referenceName(type.element)
    if (type.kind === "index") return referenceName(type.object)
    if (type.kind === "keyof") return referenceName(type.type)
    return null
}

export function renameTypes(type, renames) {
    const rename = name => renames.get(name) ?? name
    switch (type.kind) {
        case "named": return renames.has(type.name) ? { ...type, name: rename(type.name) } : type
        case "enumMember": return renames.has(type.name) ? { ...type, name: rename(type.name) } : type
        case "generic": return { ...type, name: rename(type.name), args: type.args.map(arg => renameTypes(arg, renames)) }
        case "array": return { ...type, element: renameTypes(type.element, renames) }
        case "tuple": return { ...type, items: type.items.map(item => renameTypes(item, renames)) }
        case "union":
        case "intersection": return { ...type, types: type.types.map(part => renameTypes(part, renames)) }
        case "shape": return { ...type, fields: type.fields.map(field => ({ ...field, type: renameTypes(field.type, renames) })) }
        case "function": return { ...type, params: type.params.map(param => ({ ...param, type: renameTypes(param.type, renames) })), returns: renameTypes(type.returns, renames) }
        case "keyof": return { ...type, type: renameTypes(type.type, renames) }
        case "index": return { ...type, object: renameTypes(type.object, renames), index: renameTypes(type.index, renames) }
    }
    return type
}

export function namesInType(type, found = new Set()) {
    switch (type.kind) {
        case "named":
        case "enumMember":
            found.add(type.name)
            break
        case "generic":
            found.add(type.name)
            type.args.forEach(arg => namesInType(arg, found))
            break
        case "array":
            namesInType(type.element, found)
            break
        case "tuple":
            type.items.forEach(item => namesInType(item, found))
            break
        case "union":
        case "intersection":
            type.types.forEach(part => namesInType(part, found))
            break
        case "shape":
            type.fields.forEach(field => namesInType(field.type, found))
            break
        case "function":
            type.params.forEach(param => namesInType(param.type, found))
            namesInType(type.returns, found)
            break
        case "keyof":
            namesInType(type.type, found)
            break
        case "index":
            namesInType(type.object, found)
            namesInType(type.index, found)
    }
    return found
}
