// Optional struct validator generator, enabled with SLIM_CODEGEN=1.
//
// The closure path in core.js reads every field through a computed key, which
// keeps those property loads megamorphic. Generating one function per struct
// turns field names into constants. Only field names (JSON-quoted) and field
// positions reach the generated source; types never do.
//
// Every inline check is optimistic: it can accept a value on its own, but a
// miss always defers to the compiled closure for that field, so the result is
// the same as the closure path for every input.

const FAST = {
    "string": x => `typeof ${x} === "string"`,
    "int": x => `typeof ${x} === "number" && Number.isInteger(${x})`,
    "float": x => `typeof ${x} === "number" && !Number.isInteger(${x}) && ${x} === ${x}`,
    "number": x => `typeof ${x} === "number" && ${x} === ${x}`,
    "bool": x => `typeof ${x} === "boolean"`,
    "any": () => "true",
    "string[]": x => `Array.isArray(${x}) && ${x}.length !== 0 && allStrings(${x})`,
    "int[]": x => `Array.isArray(${x}) && ${x}.length !== 0 && allInts(${x})`
}

export function isInlineKind(label) {
    return Object.hasOwn(FAST, label)
}

const allStrings = items => {
    for (let i = 0; i < items.length; i++) if (typeof items[i] !== "string") return false
    return true
}

const allInts = items => {
    for (let i = 0; i < items.length; i++) {
        if (typeof items[i] !== "number" || !Number.isInteger(items[i])) return false
    }
    return true
}

// fields: [{ name, optional, kind, test }], schema: the struct scheme object.
export function generateStructValidator(fields, schema) {
    const names = fields.map(field => JSON.stringify(field.name))
    const lines = [
        `if (typeof value !== "object" || value === null || Array.isArray(value)) return false`,
        `const keys = Object.keys(value)`,
        `for (let i = 0; i < keys.length; i++) {`,
        `  switch (keys[i]) {`,
        names.length ? `    case ${names.join(": case ")}: break` : "",
        `    default: if (!(keys[i] in schema)) return false`,
        `  }`,
        `}`,
        `let x`
    ]

    fields.forEach((field, index) => {
        const key = names[index]
        const check = FAST[field.kind]
        const slow = `if (!tests[${index}](x)) return false`
        const body = check ? `if (!(${check("x")})) { ${slow} }` : slow

        lines.push(`x = value[${key}]`)
        if (field.optional) {
            lines.push(`if (x !== undefined || ${key} in value) { ${body} }`)
        } else {
            lines.push(`if (x === undefined && !(${key} in value)) return false`)
            lines.push(body)
        }
    })

    lines.push("return true")

    const factory = new Function("schema", "tests", "allStrings", "allInts", `return function (value) {\n${lines.join("\n")}\n}`)
    return factory(schema, fields.map(field => field.test), allStrings, allInts)
}
