import * as t from "@babel/types"
import fs from "node:fs"
import path from "node:path"
import { parseProgram } from "../syntax/index.js"
import { resolveSlimSource } from "../modulePaths.js"
import { traverse } from "./ast.js"
import { importedReactive, importedReaders, reactiveKind, readsReactive, useImported } from "./reads.js"
import { prepareModule } from "./prepare.js"
import { mutationAt } from "./rewrite.js"

const exportsCache = new Map()
const resolvingExports = new Set()

function fileStamp(file) {
    try {
        return fs.statSync(file).mtimeMs
    } catch {
        return null
    }
}

function useSpecifiers(spec, bareIsDefault = true) {
    const trimmed = spec.trim()
    const namespace = /^\*\s+as\s+([\w$]+)$/.exec(trimmed)
    if (namespace) return [{ namespace: namespace[1] }]
    const pair = part => {
        const [imported, local = imported] = part.trim().split(/\s+as\s+/).map(name => name.trim())
        return { imported, local }
    }
    if (trimmed.startsWith("{")) return trimmed.replace(/[{}]/g, "").split(",").filter(part => part.trim()).map(pair)
    if (/\s+as\s+/.test(trimmed)) return [pair(trimmed)]
    return [{ imported: bareIsDefault ? "default" : trimmed, local: trimmed }]
}

export function slimModuleTarget(raw, fromFile) {
    if (!raw.startsWith(".")) return null
    const cut = raw.search(/[?#]/)
    const base = cut === -1 ? raw : raw.slice(0, cut)
    const suffix = cut === -1 ? "" : raw.slice(cut)
    const dir = path.dirname(path.resolve(fromFile))
    const exists = name => fs.existsSync(path.resolve(dir, name))
    const isDirectory = name => {
        try {
            return fs.statSync(path.resolve(dir, name)).isDirectory()
        } catch {
            return false
        }
    }
    let target = null
    if (base.endsWith(".slim")) target = base.slice(0, -".slim".length)
    else if (exists(base + ".slim")) target = base
    else if (isDirectory(base) && exists(path.join(base, "index.slim"))) target = base.replace(/\/+$/, "") + "/index"
    else if (path.extname(base) === "" && !base.endsWith("/")) target = base
    return target === null ? null : { target, suffix }
}

function slimDependency(raw, fromFile) {
    const found = slimModuleTarget(raw, fromFile)
    const source = resolveSlimSource(found ? found.target : raw.replace(/\.js$/, ""), fromFile)
    return source && fs.existsSync(source) ? source : null
}

function dependencyExports(source, stamps) {
    const exported = reactiveExports(source)
    if (stamps) for (const [file, stamp] of latestStamps.get(path.resolve(source)) ?? []) stamps.set(file, stamp)
    return exported
}

export function reactiveImports(uses, sourceFile, { bareIsDefault = true, stamps = null } = {}) {
    const values = new Map()
    const readers = new Set()
    const add = (local, kind) => {
        if (kind === "reads") readers.add(local)
        else values.set(local, kind)
    }
    for (const { spec, raw } of uses) {
        const source = slimDependency(raw, sourceFile)
        if (!source) continue
        const exported = dependencyExports(source, stamps)
        if (!exported.size) continue
        if (spec === null) {
            for (const [name, kind] of exported) if (name !== "default") add(name, kind)
            continue
        }
        for (const specifier of useSpecifiers(spec, bareIsDefault)) {
            if (specifier.namespace) {
                for (const [name, kind] of exported) add(`${specifier.namespace}.${name}`, kind)
            } else {
                if (exported.has(specifier.imported)) add(specifier.local, exported.get(specifier.imported))
                for (const [name, kind] of exported) {
                    if (name.startsWith(`${specifier.imported}.`)) add(specifier.local + name.slice(specifier.imported.length), kind)
                }
            }
        }
    }
    return { values, readers }
}

const isHookName = name => /^use[A-Z]/.test(name)

function writesReactive(fn) {
    let found = false
    fn.traverse({
        Identifier(ref) {
            if (reactiveKind(ref) !== "signal" || ref.scope.getBinding(ref.node.name)?.identifier === ref.node) return
            const parent = ref.parentPath
            const write = (parent.isAssignmentExpression() && parent.node.left === ref.node) || parent.isUpdateExpression()
            if (write || (ref.isReferencedIdentifier() && mutationAt(ref))) {
                found = true
                ref.stop()
            }
        }
    })
    return found
}

function moduleKinds(programPath) {
    const local = new Map()
    const reads = fn => readsReactive(fn, new Set([fn.node])) && !writesReactive(fn)
    for (const statement of programPath.get("body")) {
        const declaration = statement.isExportNamedDeclaration() ? statement.get("declaration") : statement
        if (declaration.isFunctionDeclaration() && declaration.node.id && !isHookName(declaration.node.id.name) && reads(declaration)) {
            local.set(declaration.node.id.name, "reads")
        }
        if (!declaration.isVariableDeclaration()) continue
        for (const declarator of declaration.get("declarations")) {
            const name = declarator.node.id
            if (!t.isIdentifier(name)) continue
            const init = declarator.get("init")
            if (name._slimReactive === "signal" || name._slimReactive === "computed") local.set(name.name, name._slimReactive)
            else if (init.isFunction() && !isHookName(name.name) && reads(init)) local.set(name.name, "reads")
        }
    }
    return local
}

function exportedKinds(programPath, file, stamps) {
    const local = moduleKinds(programPath)
    const exports = new Map()
    const kindOf = name => {
        if (local.has(name)) return local.get(name)
        if (programPath.scope.getBinding(name)) return null
        return importedReactive.get(name) ?? (importedReaders.has(name) ? "reads" : null)
    }
    const fromDependency = raw => {
        const source = slimDependency(raw, file)
        return source ? dependencyExports(source, stamps) : new Map()
    }
    for (const statement of programPath.node.body) {
        if (t.isExportAllDeclaration(statement)) {
            for (const [name, kind] of fromDependency(statement.source.value)) if (name !== "default") exports.set(name, kind)
            continue
        }
        if (t.isExportDefaultDeclaration(statement) && t.isIdentifier(statement.declaration)) {
            const kind = kindOf(statement.declaration.name)
            if (kind) exports.set("default", kind)
            continue
        }
        if (!t.isExportNamedDeclaration(statement)) continue
        if (statement.declaration) {
            for (const name of Object.keys(t.getBindingIdentifiers(statement.declaration))) {
                if (local.has(name)) exports.set(name, local.get(name))
            }
            continue
        }
        const dependency = statement.source ? fromDependency(statement.source.value) : null
        for (const specifier of statement.specifiers) {
            if (t.isExportNamespaceSpecifier(specifier) && dependency) {
                for (const [name, kind] of dependency) if (name !== "default") exports.set(`${specifier.exported.name}.${name}`, kind)
                continue
            }
            if (!t.isExportSpecifier(specifier)) continue
            const exported = specifier.exported.name ?? specifier.exported.value
            const kind = dependency ? dependency.get(specifier.local.name) : kindOf(specifier.local.name)
            if (kind) exports.set(exported, kind)
        }
    }
    return exports
}

function computeExports(file, stamps) {
    let ast
    try {
        ast = parseProgram(fs.readFileSync(file, "utf8"), file)
    } catch {
        return new Map()
    }
    const uses = []
    for (const statement of ast.program.body) {
        if (!t.isExpressionStatement(statement)) continue
        const expression = statement.expression
        if (!t.isCallExpression(expression) || !t.isIdentifier(expression.callee)) continue
        const [first, second] = expression.arguments
        if (expression.callee.name === "__use__" && t.isStringLiteral(first) && t.isStringLiteral(second)) uses.push({ spec: first.value, raw: second.value })
        if (expression.callee.name === "__use_all__" && t.isStringLiteral(first)) uses.push({ spec: null, raw: first.value })
    }
    const { values, readers } = reactiveImports(uses, file, { stamps })

    const saved = useImported(values, readers)
    let exports = new Map()
    try {
        traverse.cache.clear()
        traverse(ast, {
            Program(programPath) {
                prepareModule(programPath)
                exports = exportedKinds(programPath, file, stamps)
                programPath.stop()
            }
        })
    } catch {
        exports = new Map()
    } finally {
        traverse.cache.clear()
        useImported(...saved)
    }
    return exports
}

const latestStamps = new Map()
const partialExports = new Map()
const cycleHits = new Set()
const incomplete = new Set()
const passExports = new Map()

function sameExports(a, b) {
    return a.size === b.size && [...a].every(([name, kind]) => b.get(name) === kind)
}

export function reactiveExports(file) {
    const key = path.resolve(file)
    const cached = exportsCache.get(key)
    if (cached && [...cached.stamps].every(([dep, stamp]) => fileStamp(dep) === stamp)) return cached.exports
    if (resolvingExports.has(key)) {
        cycleHits.add(key)
        let after = false
        for (const other of resolvingExports) {
            if (after) incomplete.add(other)
            if (other === key) after = true
        }
        return partialExports.get(key) ?? new Map()
    }
    if (passExports.has(key)) return passExports.get(key)
    const stamp = fileStamp(key)
    if (stamp === null) return new Map()

    resolvingExports.add(key)
    let exports = new Map()
    let stamps
    try {
        for (let round = 0; round < 8; round++) {
            if (round > 0) passExports.clear()
            cycleHits.delete(key)
            partialExports.set(key, exports)
            stamps = new Map([[key, stamp]])
            const next = computeExports(key, stamps)
            const settled = sameExports(next, exports)
            exports = next
            if (!cycleHits.has(key) || settled) break
        }
    } finally {
        resolvingExports.delete(key)
        partialExports.delete(key)
        cycleHits.delete(key)
    }
    latestStamps.set(key, stamps)
    if (incomplete.has(key)) {
        incomplete.delete(key)
        passExports.set(key, exports)
    } else exportsCache.set(key, { stamps, exports })
    if (resolvingExports.size === 0) passExports.clear()
    return exports
}
