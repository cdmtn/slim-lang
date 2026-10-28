import _traverse from "@babel/traverse"
import * as t from "@babel/types"
import { readType } from "./external/typeSyntax.js"

const traverse = _traverse.default ?? _traverse

const PRIMITIVES = {
    int: "number", float: "number", number: "number",
    string: "string", bool: "boolean", null: "null",
    any: "any", object: "object", array: "any[]",
    function: "Function", element: "HTMLElement"
}

function toTS(type) {
    switch (type.kind) {
        case "named": return PRIMITIVES[type.name] ?? type.name
        case "literal": return typeof type.value === "string" ? JSON.stringify(type.value) : String(type.value)
        case "array": {
            const element = toTS(type.element)
            return type.element.kind === "union" || type.element.kind === "intersection" ? `(${element})[]` : `${element}[]`
        }
        case "tuple": return `[${type.items.map(toTS).join(", ")}]`
        case "generic": return `${type.name}<${type.args.map(toTS).join(", ")}>`
        case "enumMember": return "number | string"
        case "function": return `((${type.params.map((param, index) => `${param.name ?? `arg${index}`}: ${toTS(param.type)}`).join(", ")}) => ${toTS(type.returns)})`
        case "union": return [...new Set(type.types.map(toTS))].join(" | ")
        case "intersection": return [...new Set(type.types.map(toTS))].join(" & ")
    }
    return "any"
}

function mapType(label) {
    return toTS(readType(String(label)))
}

export function jsdocComment(lines) {
    return "*\n" + lines.map(line => ` * ${line}`).join("\n") + "\n "
}

function enumTypedef(name, schema) {
    const types = new Set()

    for (const property of schema.properties) {
        if (!t.isObjectProperty(property)) continue
        if (t.isStringLiteral(property.value)) types.add("string")
        else types.add("number")
    }

    const type = types.size ? [...types].join(" | ") : "number | string"
    return `@typedef {${type}} ${name}`
}

function stringList(node) {
    return t.isArrayExpression(node)
        ? node.elements.filter(element => t.isStringLiteral(element)).map(element => element.value)
        : []
}

function structTypedef(name, schema) {
    const fields = []

    for (const property of schema.properties) {
        if (!t.isObjectProperty(property) || !t.isStringLiteral(property.value)) continue

        const rawKey = t.isStringLiteral(property.key)
            ? property.key.value
            : t.isIdentifier(property.key)
                ? property.key.name
                : null
        if (rawKey === null) continue

        const optional = rawKey.startsWith("*")
        const field = optional ? rawKey.slice(1).trim() : rawKey
        fields.push(`${field}${optional ? "?" : ""}: ${mapType(property.value.value)}`)
    }

    return `@typedef {{ ${fields.join(", ")} }} ${name}`
}

function returnLabel(fn) {
    if (!t.isBlockStatement(fn.body)) return null

    for (const statement of fn.body.body) {
        if (!t.isExpressionStatement(statement)) continue
        const call = statement.expression
        if (!t.isCallExpression(call) || !t.isIdentifier(call.callee, { name: "__declare_return__" })) continue
        if (t.isStringLiteral(call.arguments[0])) return call.arguments[0].value
    }
    return null
}

function paramLines(fn) {
    if (!t.isBlockStatement(fn.body)) return []

    const lines = []
    for (const statement of fn.body.body) {
        if (!t.isExpressionStatement(statement)) continue
        const call = statement.expression
        if (!t.isCallExpression(call) || !t.isIdentifier(call.callee, { name: "__typed_parameter__" })) continue

        const [value, typeArg] = call.arguments
        if (!t.isIdentifier(value) || !t.isStringLiteral(typeArg)) continue

        lines.push(`@param {${mapType(typeArg.value)}} ${value.name}`)
    }

    const returns = returnLabel(fn)
    if (returns) {
        const asyncReturn = fn.async ? `Promise<${mapType(returns)}>` : mapType(returns)
        lines.push(`@returns {${asyncReturn}}`)
    }

    return lines
}

function structInterface(schema, readonly = []) {
    const fields = []

    for (const property of schema.properties) {
        if (!t.isObjectProperty(property) || !t.isStringLiteral(property.value)) continue

        const rawKey = t.isStringLiteral(property.key)
            ? property.key.value
            : t.isIdentifier(property.key)
                ? property.key.name
                : null
        if (rawKey === null) continue

        const optional = rawKey.startsWith("*")
        const field = optional ? rawKey.slice(1).trim() : rawKey
        const modifier = readonly.includes(field) ? "readonly " : ""
        fields.push(`${modifier}${field}${optional ? "?" : ""}: ${mapType(property.value.value)}`)
    }

    return `{ ${fields.join("; ")} }`
}

function enumValueType(schema) {
    const types = new Set()
    for (const property of schema.properties) {
        if (!t.isObjectProperty(property)) continue
        types.add(t.isStringLiteral(property.value) ? "string" : "number")
    }
    return types.size ? [...types].join(" | ") : "number | string"
}

function paramTypes(fn) {
    const types = new Map()
    if (!t.isBlockStatement(fn.body)) return types

    for (const statement of fn.body.body) {
        if (!t.isExpressionStatement(statement)) continue
        const call = statement.expression
        if (!t.isCallExpression(call) || !t.isIdentifier(call.callee, { name: "__typed_parameter__" })) continue

        const [value, typeArg] = call.arguments
        if (t.isIdentifier(value) && t.isStringLiteral(typeArg)) types.set(value.name, typeArg.value)
    }
    return types
}

function functionSignature(name, fn) {
    const types = paramTypes(fn)

    const params = fn.params.map(param => {
        if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
            const label = types.get(param.left.name)
            return `${param.left.name}?: ${label ? mapType(label) : "any"}`
        }
        if (t.isRestElement(param) && t.isIdentifier(param.argument)) {
            return `...${param.argument.name}: any[]`
        }
        if (t.isIdentifier(param)) {
            const label = types.get(param.name)
            return `${param.name}: ${label ? mapType(label) : "any"}`
        }
        return "arg: any"
    })

    const returns = returnLabel(fn)
    const result = returns
        ? (fn.async ? `Promise<${mapType(returns)}>` : mapType(returns))
        : "any"

    return `export declare function ${name}(${params.join(", ")}): ${result}`
}

export function emitDeclarations(ast) {
    const lines = []
    let usesStruct = false

    traverse(ast, {
        ExportNamedDeclaration(path_) {
            const decl = path_.node.declaration
            if (!decl) return

            if (t.isFunctionDeclaration(decl) && decl.id) {
                lines.push(functionSignature(decl.id.name, decl))
                return
            }

            if (!t.isVariableDeclaration(decl)) return

            for (const declarator of decl.declarations) {
                if (!t.isIdentifier(declarator.id)) continue
                const name = declarator.id.name
                const init = declarator.init

                if (t.isArrowFunctionExpression(init) || t.isFunctionExpression(init)) {
                    lines.push(functionSignature(name, init))
                    continue
                }

                if (!t.isCallExpression(init)) continue

                if (t.isIdentifier(init.callee, { name: "__def_struct__" }) && t.isObjectExpression(init.arguments[1])) {
                    usesStruct = true
                    const params = stringList(init.arguments[6])
                    const generic = params.length ? `<${params.join(", ")}>` : ""
                    const anyArgs = params.length ? `<${params.map(() => "any").join(", ")}>` : ""
                    lines.push(`export interface ${name}${generic} ${structInterface(init.arguments[1], stringList(init.arguments[7]))}`)
                    lines.push(`export declare const ${name}: SlimStruct<${name}${anyArgs}>`)
                } else if (t.isIdentifier(init.callee, { name: "__def_enum__" }) && t.isObjectExpression(init.arguments[1])) {
                    lines.push(`export type ${name} = ${enumValueType(init.arguments[1])}`)
                    lines.push(`export declare const ${name}: Record<string, any>`)
                } else if (t.isIdentifier(init.callee, { name: "__type_def__" })) {
                    lines.push(`export type ${name} = any`)
                    lines.push(`export declare const ${name}: (value: unknown) => boolean`)
                }
            }
        }
    })

    if (lines.length === 0) return null

    const header = usesStruct
        ? "type SlimStruct<T> = { verify(value: unknown): T; verifySafe(value: unknown): { success: boolean; result: T }; new(values?: Partial<T>): T }\n\n"
        : ""

    return header + lines.join("\n") + "\n"
}

export function emitJsDoc(ast) {
    const typedefs = []

    traverse(ast, {
        VariableDeclaration(path_) {
            for (const declarator of path_.node.declarations) {
                const init = declarator.init
                if (!t.isCallExpression(init)) continue

                if (t.isIdentifier(init.callee, { name: "__def_struct__" }) &&
                    t.isStringLiteral(init.arguments[0]) &&
                    t.isObjectExpression(init.arguments[1])) {
                    for (const param of stringList(init.arguments[6])) typedefs.push(`@template ${param}`)
                    typedefs.push(structTypedef(init.arguments[0].value, init.arguments[1]))
                }

                if (t.isIdentifier(init.callee, { name: "__def_enum__" }) &&
                    t.isStringLiteral(init.arguments[0]) &&
                    t.isObjectExpression(init.arguments[1])) {
                    typedefs.push(enumTypedef(init.arguments[0].value, init.arguments[1]))
                }

                if (t.isIdentifier(init.callee, { name: "__type_def__" }) &&
                    t.isStringLiteral(init.arguments[0])) {
                    typedefs.push(`@typedef {any} ${init.arguments[0].value}`)
                }

                if (t.isIdentifier(init.callee, { name: "__typed_variable__" }) &&
                    t.isStringLiteral(init.arguments[1])) {
                    t.addComment(path_.node, "leading",
                        jsdocComment([`@type {${mapType(init.arguments[1].value)}}`]), false)
                }
            }
        },

        Function(path_) {
            const lines = paramLines(path_.node)
            if (lines.length === 0) return

            const target = t.isFunctionDeclaration(path_.node)
                ? path_.node
                : path_.parentPath.isVariableDeclarator()
                    ? path_.parentPath.parentPath.node
                    : path_.node

            t.addComment(target, "leading", jsdocComment(lines), false)
        }
    })

    return typedefs
}
