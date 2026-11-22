import fs from "node:fs"
import path from "node:path"
import * as t from "@babel/types"
import { ANY, arrayOf, named, shapeOf, unionOf } from "../external/typeSyntax.js"

const cache = new Map()

function merge(types) {
    const shapes = types.filter(type => type.kind === "shape")
    if (shapes.length < 2) return unionOf(types)
    const names = []
    const found = new Map()
    for (const shape of shapes) {
        for (const field of shape.fields) {
            if (!found.has(field.name)) {
                names.push(field.name)
                found.set(field.name, [])
            }
            found.get(field.name).push(field.type)
        }
    }
    const fields = names.map(name => ({
        name,
        type: merge(found.get(name)),
        optional: found.get(name).length < shapes.length
    }))
    return unionOf([...types.filter(type => type.kind !== "shape"), shapeOf(fields)])
}

export function jsonType(value, depth = 0) {
    if (depth > 16) return ANY
    if (value === null) return named("null")
    if (typeof value === "string") return named("string")
    if (typeof value === "boolean") return named("bool")
    if (typeof value === "number") return named(Number.isInteger(value) ? "int" : "float")
    if (Array.isArray(value)) {
        if (value.length === 0) return arrayOf(ANY)
        return arrayOf(merge(value.map(item => jsonType(item, depth + 1))))
    }
    if (typeof value === "object") {
        return shapeOf(Object.entries(value).map(([name, item]) => ({ name, type: jsonType(item, depth + 1), optional: false })))
    }
    return ANY
}

function readJsonType(file) {
    let stamp
    try {
        stamp = fs.statSync(file).mtimeMs
    } catch {
        return null
    }
    const cached = cache.get(file)
    if (cached?.stamp === stamp) return cached.type
    let type = null
    try {
        type = jsonType(JSON.parse(fs.readFileSync(file, "utf8")))
    } catch {
        type = null
    }
    cache.set(file, { stamp, type })
    return type
}

export function collectJsonImport(path_, env) {
    const source = path_.node.source.value
    if (!source.endsWith(".json") || !source.startsWith(".") || !env.sourceFile) return
    const specifier = path_.node.specifiers.find(item => t.isImportDefaultSpecifier(item))
    if (!specifier) return
    const binding = path_.scope.getBinding(specifier.local.name)
    if (!binding) return
    const type = readJsonType(path.resolve(path.dirname(path.resolve(env.sourceFile)), source))
    if (type) env.bindings.set(binding, type)
}
