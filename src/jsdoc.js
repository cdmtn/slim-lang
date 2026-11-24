import _traverse from "@babel/traverse"
import * as t from "@babel/types"
import { readType } from "./external/typeSyntax.js"

const traverse = _traverse.default ?? _traverse

const PRIMITIVES = {
    int: "number", float: "number", number: "number",
    string: "string", bool: "boolean", null: "null", undefined: "undefined", void: "void",
    any: "any", object: "object", array: "any[]", enum: "any",
    function: "Function", element: "HTMLElement",
    Html: "{ readonly value: string }", SafeHtml: "{ readonly value: string }"
}

function structType(of) {
    return `{ verify(value: unknown): ${of}; verifySafe(value: unknown): { success: boolean; result: ${of} }; new(values?: Partial<${of}>): ${of} }`
}

function grouped(type) {
    const text = toTS(type)
    return ["union", "intersection", "function", "keyof"].includes(type.kind) ? `(${text})` : text
}

function returnTS(type) {
    return type.kind === "named" && (type.name === "undefined" || type.name === "void") ? "void" : toTS(type)
}

function paramTS(param, index) {
    const name = param.name ?? `arg${index}`
    if (param.rest) return `...${name}: ${toTS(param.type)}`
    return `${name}${param.optional ? "?" : ""}: ${toTS(param.type)}`
}

function toTS(type) {
    switch (type.kind) {
        case "named":
            if (type.name === "Struct") return structType("any")
            return PRIMITIVES[type.name] ?? type.name
        case "keyof": return `keyof ${grouped(type.type)}`
        case "index": return `${grouped(type.object)}[${toTS(type.index)}]`
        case "literal": return typeof type.value === "string" ? JSON.stringify(type.value) : String(type.value)
        case "array": {
            const element = toTS(type.element)
            const list = type.element.kind === "union" || type.element.kind === "intersection" ? `(${element})[]` : `${element}[]`
            return type.readonly ? `readonly ${list}` : list
        }
        case "tuple": return `${type.readonly ? "readonly " : ""}[${type.items.map(toTS).join(", ")}]`
        case "shape": return `{ ${type.fields.map(field => `${JSON.stringify(field.name)}${field.optional ? "?" : ""}: ${toTS(field.type)}`).join(", ")} }`
        case "generic":
            if (type.name === "Struct") return structType(type.args[0] ? toTS(type.args[0]) : "any")
            return `${type.name}<${type.args.map(toTS).join(", ")}>`
        case "enumMember": return "number | string"
        case "function": return `((${type.params.map(paramTS).join(", ")}) => ${returnTS(type.returns)})`
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

function variantUnion(schema) {
    const variants = schema.properties.filter(property => t.isObjectProperty(property)).map(property => {
        const tag = t.isStringLiteral(property.key) ? property.key.value : property.key.name
        const fields = t.isArrayExpression(property.value)
            ? property.value.elements.map(field => `${field.elements[0].value}: ${mapType(field.elements[1].value)}`)
            : []
        return `{ readonly $tag: ${JSON.stringify(tag)}${fields.map(field => `, ${field}`).join("")} }`
    })
    return variants.length ? variants.join(" | ") : "never"
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

function paramName(param) {
    const target = t.isAssignmentPattern(param) ? param.left : t.isRestElement(param) ? param.argument : param
    return t.isIdentifier(target) ? target.name : null
}

function declaredLines(fn, declared) {
    const lines = []
    for (const { name, constraint } of declared.typeParams) {
        lines.push(constraint ? `@template {${mapType(constraint)}} ${name}` : `@template ${name}`)
    }
    fn.params.forEach((param, index) => {
        const name = paramName(param)
        const own = declared.params[index]
        if (!name || !own) return
        const type = own.label ? readType(String(own.label)) : null
        if (own.rest) {
            const element = type?.kind === "array" ? toTS(type.element) : "any"
            lines.push(`@param {...${element}} ${name}`)
            return
        }
        lines.push(`@param {${type ? toTS(type) : "any"}} ${own.optional ? `[${name}]` : name}`)
    })
    if (declared.returns) {
        const returns = returnTS(readType(String(declared.returns)))
        lines.push(`@returns {${fn.async ? `Promise<${returns === "void" ? "void" : returns}>` : returns}}`)
    }
    return lines
}

function declaredSignature(name, fn, declared) {
    const generic = declared.typeParams.length
        ? `<${declared.typeParams.map(param => param.constraint ? `${param.name} extends ${mapType(param.constraint)}` : param.name).join(", ")}>`
        : ""
    const params = fn.params.map((param, index) => {
        const own = declared.params[index]
        const label = own?.label ? toTS(readType(String(own.label))) : null
        const paramText = paramName(param) ?? `arg${index}`
        if (own?.rest) return `...${paramText}: ${label ?? "any[]"}`
        return `${paramText}${own?.optional ? "?" : ""}: ${label ?? "any"}`
    })
    const returns = declared.returns ? returnTS(readType(String(declared.returns))) : "any"
    const result = fn.async ? `Promise<${returns}>` : returns
    return `export declare function ${name}${generic}(${params.join(", ")}): ${result}`
}

function paramLines(fn) {
    if (fn._slimDeclared) return declaredLines(fn, fn._slimDeclared)
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
    if (fn._slimDeclared) return declaredSignature(name, fn, fn._slimDeclared)
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
                } else if (t.isIdentifier(init.callee, { name: "__def_trait__" }) && t.isObjectExpression(init.arguments[1])) {
                    lines.push(`export interface ${name} ${structInterface(init.arguments[1])}`)
                    lines.push(`export declare const ${name}: (value: unknown) => boolean`)
                } else if (t.isIdentifier(init.callee, { name: "__def_variants__" }) && t.isObjectExpression(init.arguments[1])) {
                    const params = stringList(init.arguments[2])
                    lines.push(`export type ${name}${params.length ? `<${params.join(", ")}>` : ""} = ${variantUnion(init.arguments[1])}`)
                    lines.push(`export declare const ${name}: Record<string, any>`)
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

function exportOf(path_) {
    const parent = path_.parentPath
    return parent && (parent.isExportNamedDeclaration() || parent.isExportDefaultDeclaration()) ? parent : path_
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

                if (t.isIdentifier(init.callee, { name: "__def_trait__" }) &&
                    t.isStringLiteral(init.arguments[0]) &&
                    t.isObjectExpression(init.arguments[1])) {
                    typedefs.push(structTypedef(init.arguments[0].value, init.arguments[1]))
                }

                if (t.isIdentifier(init.callee, { name: "__def_variants__" }) &&
                    t.isStringLiteral(init.arguments[0]) &&
                    t.isObjectExpression(init.arguments[1])) {
                    for (const param of stringList(init.arguments[2])) typedefs.push(`@template ${param}`)
                    typedefs.push(`@typedef {${variantUnion(init.arguments[1])}} ${init.arguments[0].value}`)
                }

                if (t.isIdentifier(init.callee, { name: "__typed_variable__" }) &&
                    t.isStringLiteral(init.arguments[1])) {
                    t.addComment(exportOf(path_).node, "leading",
                        jsdocComment([`@type {${mapType(init.arguments[1].value)}}`]), false)
                }
            }
        },

        Function(path_) {
            if (path_.node._slimSignatureOnly) return
            const lines = paramLines(path_.node)
            if (lines.length === 0) return

            const target = !t.isFunctionDeclaration(path_.node) && path_.parentPath.isVariableDeclarator()
                ? path_.parentPath.parentPath
                : path_

            t.addComment(exportOf(target).node, "leading", jsdocComment(lines), false)
        }
    })

    return typedefs
}
