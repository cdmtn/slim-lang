import * as t from "@babel/types"
import { slimSyntaxError } from "./plugin.js"
import { typeFromAST } from "./types.js"
import { ANY, formatType, substituteType } from "../external/typeSyntax.js"
import { expressionLowering } from "./lower/expressions.js"
import { matchLowering } from "./lower/match.js"
import { functionLowering } from "./lower/functions.js"
import { declarationLowering } from "./lower/declarations.js"
import { FUNCTION_TYPES, SKIP_KEYS, hookBodies, id, isNode, typeParamNodes } from "./lower/helpers.js"
import { stripTypes } from "./lower/types.js"

class Lowering {
    constructor(code, sourceFile, options = {}) {
        this.code = code
        this.sourceFile = sourceFile
        this.script = options.script === true
        this.typeParams = []
        this.stateDeclarations = []
        this.functions = []
    }

    fail(node, message) {
        throw slimSyntaxError(this.code, node.start ?? 0, message)
    }

    type(annotation, { keepTypeParams = false } = {}) {
        const type = typeFromAST(annotation, (node, message) => this.fail(node, message))
        if (keepTypeParams || this.typeParams.length === 0) return type
        return substituteType(type, new Map(this.typeParams.map(param => [param.name, param.constraint])))
    }

    label(annotation, options) {
        return formatType(this.type(annotation, options))
    }

    typeParamEntries(node) {
        const params = typeParamNodes(node)
        const names = params.map(param => typeof param.name === "string" ? param.name : param.name?.name)
        const own = new Set(names.filter(Boolean))
        const entries = []
        params.forEach((param, index) => {
            const name = names[index]
            if (!name) return
            const fallback = param.default ? formatType(this.type(param.default, { keepTypeParams: true })) : null
            if (!param.constraint) {
                entries.push({ name, constraint: ANY, label: null, fallback })
                return
            }
            const written = this.type(param.constraint, { keepTypeParams: true })
            const bound = new Map(this.typeParams.filter(entry => !own.has(entry.name)).map(entry => [entry.name, entry.constraint]))
            for (const other of own) bound.set(other, ANY)
            for (const entry of entries) bound.set(entry.name, entry.constraint)
            entries.push({ name, constraint: substituteType(written, bound), label: formatType(written), fallback })
        })
        return entries
    }

    typeDefaults(node) {
        return Object.fromEntries(this.typeParamEntries(node).filter(param => param.fallback).map(param => [param.name, param.fallback]))
    }

    aliasProperties(node, extra = {}) {
        const params = this.typeParamEntries(node)
        if (params.length === 0) return { type: "one-line-expr", ...extra }
        const defaults = this.typeDefaults(node)
        return {
            type: "one-line-expr",
            ...extra,
            params: params.map(param => param.name).join(","),
            generic: this.label(node.typeAnnotation, { keepTypeParams: true }),
            ...(Object.keys(defaults).length ? { defaults: JSON.stringify(defaults) } : {})
        }
    }

    visit(node, parent) {
        const typeParams = this.typeParamEntries(node)
        const isFunction = FUNCTION_TYPES.has(node.type)
        this.typeParams.push(...typeParams)
        if (isFunction) this.functions.push({ tries: false })
        try {
            return this.visitChildren(node, parent)
        } finally {
            this.typeParams.length -= typeParams.length
            if (isFunction) this.functions.pop()
        }
    }

    visitChildren(node, parent) {
        for (const key of Object.keys(node)) {
            if (SKIP_KEYS.has(key)) continue
            const value = node[key]
            if (Array.isArray(value)) {
                node[key] = value.flatMap(child => {
                    if (!isNode(child)) return [child]
                    const lowered = this.visit(child, node)
                    return lowered === null ? [] : [lowered]
                })
            } else if (isNode(value)) {
                node[key] = this.visit(value, node)
            }
        }

        const handler = this[node.type]
        return typeof handler === "function" ? handler.call(this, node, parent) : node
    }

    Program(node) {
        node.body = node.body.flatMap(statement => {
            if (statement.type !== "ExportDefaultDeclaration" || statement.declaration.type !== "VariableDeclaration") {
                return [statement]
            }
            const declaration = statement.declaration
            const [first] = declaration.declarations
            if (declaration.declarations.length !== 1 || first.id.type !== "Identifier") {
                this.fail(statement, "export default needs a single named declaration")
            }
            return [declaration, t.exportNamedDeclaration(null, [t.exportSpecifier(id(first.id.name), id("default"))])]
        })
        for (const statement of node.body) {
            const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
            if (declaration?.slimState) declaration._slimStateOk = true
            for (const body of hookBodies(declaration)) {
                for (const item of body.body) if (item.slimState) item._slimStateOk = true
            }
        }
        const stray = this.stateDeclarations.find(declaration => !declaration._slimStateOk)
        if (stray) this.fail(stray, "state can only be declared at the top of a component body, a use... function or a module")
        return node
    }
}

Object.assign(Lowering.prototype, expressionLowering, matchLowering, functionLowering, declarationLowering)

export function lowerSlim(file, code, sourceFile, options = {}) {
    const lowering = new Lowering(code, sourceFile, options)
    file.program = lowering.visit(file.program, file)
    stripTypes(file.program, lowering)
    return file
}
