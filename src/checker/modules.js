import _traverse from "@babel/traverse"
import * as t from "@babel/types"
import path from "node:path"
import { formatType, readType, renameTypes } from "../external/typeSyntax.js"
import { resolveStruct } from "./core.js"
import { inferReturn } from "./infer.js"

const traverse = _traverse.default ?? _traverse
export const moduleTypes = new Map()

function encode(value) {
    if (value instanceof Map) return { $map: [...value].map(([key, item]) => [key, encode(item)]) }
    if (value instanceof Set) return { $set: [...value] }
    if (Array.isArray(value)) return value.map(encode)
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "node").map(([key, item]) => [key, encode(item)]))
}

function decode(value) {
    if (Array.isArray(value)) return value.map(decode)
    if (!value || typeof value !== "object") return value
    if (value.$map) return new Map(value.$map.map(([key, item]) => [key, decode(item)]))
    if (value.$set) return new Set(value.$set)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]))
}

export function exportModuleTypes(sourceFile) {
    const record = moduleTypes.get(path.resolve(sourceFile))
    return record ? JSON.stringify(encode(record)) : null
}

export function importModuleTypes(sourceFile, saved) {
    if (saved) moduleTypes.set(path.resolve(sourceFile), decode(JSON.parse(saved)))
}

function exportedNames(ast) {
    const names = new Map()

    traverse(ast, {
        ExportAllDeclaration() {
            names.open = true
        },
        ExportDefaultDeclaration() {
            names.set("default", "default")
        },
        ExportNamedDeclaration(path_) {
            const declaration = path_.node.declaration

            if (t.isVariableDeclaration(declaration)) {
                for (const declarator of declaration.declarations) {
                    for (const name of Object.keys(t.getBindingIdentifiers(declarator.id))) names.set(name, name)
                }
            } else if ((t.isFunctionDeclaration(declaration) || t.isClassDeclaration(declaration)) && declaration.id) {
                names.set(declaration.id.name, declaration.id.name)
            }

            for (const specifier of path_.node.specifiers ?? []) {
                if (t.isExportNamespaceSpecifier(specifier)) {
                    names.set(specifier.exported.name, specifier.exported.name)
                    continue
                }
                if (!t.isExportSpecifier(specifier)) continue
                const exported = t.isIdentifier(specifier.exported)
                    ? specifier.exported.name
                    : specifier.exported.value
                names.set(exported, specifier.local.name)
            }
        }
    })

    return names
}

function settle(signature, env) {
    if (!signature || signature.returns || "inferred" in signature) return signature
    return { ...signature, inferred: inferReturn(signature.node, env) }
}

export function buildModuleTypes(ast, env) {
    const record = {
        structs: new Map(),
        enums: new Map(),
        customTypes: new Set(),
        customPredicates: new Map(),
        functions: new Map(),
        values: new Map(),
        aliases: new Map(),
        genericAliases: new Map(),
        classes: new Map(),
        declared: env.declaredValues,
        declaredConstants: env.declaredConstants,
        ambient: { structs: new Map(), enums: new Map(), customTypes: new Set(), customPredicates: new Map(), aliases: new Map(), genericAliases: new Map(), classes: new Map() }
    }

    for (const name of env.structs.keys()) {
        const resolved = resolveStruct(name, env)
        if (!resolved) continue
        const methods = new Map([...resolved.methods].map(([method, signature]) => [method, settle(signature, env)]))
        record.ambient.structs.set(name, { ...resolved, methods })
    }
    for (const [name, definition] of env.classDefs) {
        const methods = new Map([...definition.methods].map(([method, signature]) => [method, settle(signature, env)]))
        const statics = new Map([...definition.statics].map(([member, info]) => [member, info.signature ? { ...info, signature: settle(info.signature, env) } : info]))
        record.ambient.classes.set(name, { ...definition, methods, statics })
    }
    for (const [name, definition] of env.enums) record.ambient.enums.set(name, definition)
    for (const name of env.customTypes) record.ambient.customTypes.add(name)
    for (const [name, predicate] of env.customPredicates) record.ambient.customPredicates.set(name, predicate)
    for (const [name, type] of env.aliases) record.ambient.aliases.set(name, type)
    for (const [name, generic] of env.genericAliases) record.ambient.genericAliases.set(name, generic)

    const names = exportedNames(ast)
    record.exports = names.open ? null : [...names.keys()]
    const typed = typedTopLevel(env)
    for (const [exported, local] of names) {
        const struct = record.ambient.structs.get(local)
        if (struct) record.structs.set(exported, struct)
        if (env.enums.has(local)) record.enums.set(exported, env.enums.get(local))
        if (env.customTypes.has(local)) record.customTypes.add(exported)
        if (env.customPredicates.has(local)) record.customPredicates.set(exported, env.customPredicates.get(local))
        if (env.aliases.has(local)) record.aliases.set(exported, env.aliases.get(local))
        if (env.genericAliases.has(local)) record.genericAliases.set(exported, env.genericAliases.get(local))
        if (env.functionsByName.has(local)) record.functions.set(exported, settle(env.functionsByName.get(local), env))
        if (record.ambient.classes.has(local)) record.classes.set(exported, record.ambient.classes.get(local))
        if (typed.has(local)) record.values.set(exported, typed.get(local))
    }

    return record
}

function typedTopLevel(env) {
    const typed = new Map()
    for (const [binding, type] of env.bindings) {
        if (binding.kind === "param" || !binding.scope?.path?.isProgram?.()) continue
        typed.set(binding.identifier.name, type)
    }
    return typed
}

const DEFINERS = new Set(["__def_struct__", "__def_trait__", "__def_enum__", "__def_variants__", "__type_def__"])
const TYPE_KINDS = new Set(["any", "named", "literal", "array", "tuple", "generic", "enumMember", "function", "shape", "union", "intersection", "keyof", "index"])

export function localTypeNames(ast) {
    const names = new Set()
    traverse(ast, {
        CallExpression(path_) {
            const { callee, arguments: args } = path_.node
            if (t.isIdentifier(callee) && DEFINERS.has(callee.name) && t.isStringLiteral(args[0])) names.add(args[0].value)
        },
        Class(path_) {
            const name = path_.node.id?.name ?? (path_.parentPath.isVariableDeclarator() && t.isIdentifier(path_.parent.id) ? path_.parent.id.name : null)
            if (name) names.add(name)
        }
    })
    return names
}

function qualifyValue(value, renames, key = null, copies = renames.copies) {
    if (!value || typeof value !== "object") return key === "parent" && typeof value === "string" ? renames.get(value) ?? value : value
    if (copies.has(value)) return copies.get(value)
    const result = qualifyFresh(value, renames, key)
    copies.set(value, result)
    return result
}

function qualifyFresh(value, renames, key) {
    if (value instanceof Map) return new Map([...value].map(([name, item]) => [name, qualifyValue(item, renames)]))
    if (value instanceof Set) return key === "ancestors" ? new Set([...value].map(name => renames.get(name) ?? name)) : value
    if (Array.isArray(value)) {
        if (key === "traits") return value.map(label => typeof label === "string" ? formatType(renameTypes(readType(label), renames)) : label)
        return value.map(item => qualifyValue(item, renames))
    }
    if (typeof value.kind === "string" && TYPE_KINDS.has(value.kind)) return renameTypes(value, renames)
    const copy = {}
    for (const [name, item] of Object.entries(value)) copy[name] = name === "node" ? item : qualifyValue(item, renames, name)
    return copy
}

const qualifiedNames = new Map()

function qualifiedName(source, name) {
    const base = path.basename(source).replace(/\.[^.]*$/, "").replace(/[^\w$]/g, "_") || "module"
    let owners = qualifiedNames.get(base)
    if (!owners) qualifiedNames.set(base, owners = [])
    if (!owners.includes(source)) owners.push(source)
    const index = owners.indexOf(source)
    return `${/^[A-Za-z_$]/.test(base) ? base : "_" + base}${index ? index + 1 : ""}.${name}`
}

function scoped(record, source, taken) {
    if (!taken?.size) return record
    const ambient = record.ambient
    const renames = new Map()
    renames.copies = new WeakMap()
    const all = [ambient.structs.keys(), ambient.enums.keys(), ambient.classes?.keys() ?? [], ambient.aliases.keys(), ambient.customTypes]
    for (const names of all) {
        for (const name of names) if (taken.has(name)) renames.set(name, qualifiedName(source, name))
    }
    if (renames.size === 0) return record
    const renameKeys = map => new Map([...map].map(([name, item]) => [renames.get(name) ?? name, qualifyValue(item, renames)]))
    return {
        ...record,
        structs: qualifyValue(record.structs, renames),
        enums: qualifyValue(record.enums, renames),
        functions: qualifyValue(record.functions, renames),
        values: qualifyValue(record.values ?? new Map(), renames),
        aliases: qualifyValue(record.aliases, renames),
        genericAliases: qualifyValue(record.genericAliases, renames),
        classes: qualifyValue(record.classes, renames),
        declared: qualifyValue(record.declared, renames),
        ambient: {
            structs: renameKeys(ambient.structs),
            enums: renameKeys(ambient.enums),
            classes: renameKeys(ambient.classes ?? new Map()),
            aliases: renameKeys(ambient.aliases),
            genericAliases: renameKeys(ambient.genericAliases ?? new Map()),
            customTypes: new Set([...ambient.customTypes].map(name => renames.get(name) ?? name)),
            customPredicates: new Map([...(ambient.customPredicates ?? [])].map(([name, predicate]) => [renames.get(name) ?? name, predicate]))
        }
    }
}

function seedAmbient(env, record, hidden = false) {
    const hide = (name, definition) => {
        if (hidden) env.ambientNames.set(name, definition)
    }
    for (const [name, definition] of record.ambient.structs) {
        if (!env.structs.has(name)) {
            env.structs.set(name, definition)
            hide(name, definition)
        }
    }
    for (const [name, definition] of record.ambient.enums) {
        if (!env.enums.has(name) && !definition.builtin) {
            env.enums.set(name, definition)
            hide(name, definition)
        }
    }
    for (const [name, definition] of record.ambient.classes ?? []) {
        if (!env.classDefs.has(name)) {
            env.classDefs.set(name, definition)
            hide(name, definition)
        }
    }
    for (const name of record.ambient.customTypes) env.customTypes.add(name)
    for (const [name, predicate] of record.ambient.customPredicates ?? []) {
        if (!env.customPredicates.has(name)) env.customPredicates.set(name, predicate)
    }
    for (const [name, type] of record.ambient.aliases) {
        if (!env.aliases.has(name)) {
            env.aliases.set(name, type)
            hide(name, type)
            if (record.ambient.genericAliases?.has(name)) env.genericAliases.set(name, record.ambient.genericAliases.get(name))
        }
    }
}

export function seedHost(env, source, taken = null) {
    const found = moduleTypes.get(source)
    if (!found) return
    const record = scoped(found, source, taken)
    seedAmbient(env, record)
    for (const [name, type] of record.declared) {
        env.declaredValues.set(name, type)
        env.importedLocals.add(name)
    }
    for (const name of record.declaredConstants ?? []) env.declaredConstants.add(name)
}

export function seedImports(env, imports, wildcards, taken = null) {
    const merge = (record, name, local) => {
        env.ambientNames.delete(local)
        if (record.structs.has(name)) env.structs.set(local, record.structs.get(name))
        if (record.enums.has(name)) env.enums.set(local, record.enums.get(name))
        if (record.customTypes.has(name)) env.customTypes.add(local)
        if (record.customPredicates?.has(name)) env.customPredicates.set(local, record.customPredicates.get(name))
        if (record.aliases.has(name)) env.aliases.set(local, record.aliases.get(name))
        if (record.genericAliases?.has(name)) env.genericAliases.set(local, record.genericAliases.get(name))
        if (record.functions.has(name)) env.importedFunctions.set(local, record.functions.get(name))
        if (record.values?.has(name)) env.importedValues.set(local, record.values.get(name))
        if (record.classes?.has(name)) {
            env.classDefs.set(local, record.classes.get(name))
            env.classes.add(local)
            if (env.enums.get(local)?.builtin) env.enums.delete(local)
        }
    }

    const sources = new Set([...wildcards, ...imports.map(entry => entry.source)])
    const records = new Map()
    const recordOf = source => {
        if (!records.has(source)) {
            const found = moduleTypes.get(source)
            records.set(source, found ? scoped(found, source, taken) : null)
        }
        return records.get(source)
    }

    for (const source of sources) {
        const record = recordOf(source)
        if (record) seedAmbient(env, record, true)
    }

    for (const source of wildcards) {
        const record = recordOf(source)
        if (!record) continue
        for (const name of record.structs.keys()) merge(record, name, name)
        for (const name of record.enums.keys()) merge(record, name, name)
        for (const name of record.customTypes) merge(record, name, name)
        for (const name of record.aliases.keys()) merge(record, name, name)
        for (const name of record.functions.keys()) merge(record, name, name)
        for (const name of record.values?.keys() ?? []) merge(record, name, name)
        for (const name of record.classes?.keys() ?? []) merge(record, name, name)
    }

    for (const { local, imported, source } of imports) {
        const record = recordOf(source)
        if (record) merge(record, imported, local)
    }
}

export function missingImports(imports) {
    return imports.filter(({ imported, source }) => {
        const exports = moduleTypes.get(source)?.exports
        return Array.isArray(exports) && !exports.includes(imported)
    }).map(entry => ({ ...entry, available: moduleTypes.get(entry.source).exports }))
}
