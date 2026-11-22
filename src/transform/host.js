import fs from "node:fs"
import path from "node:path"
import _traverse from "@babel/traverse"
import * as t from "@babel/types"
import { parseProgram } from "../syntax/index.js"
import { resolveSlimSource } from "../modulePaths.js"

const traverse = _traverse.default ?? _traverse

const TYPE_DEFINITIONS = new Set(["__def_trait__", "__type_def__"])
const NOTES = new Set(["__declare_value__", "__use__"])

function definesType(declaration, file, exported, names) {
    if (!t.isVariableDeclaration(declaration)) return false
    return declaration.declarations.every(declarator => {
        const init = declarator.init
        if (!t.isCallExpression(init) || !t.isIdentifier(init.callee) || !TYPE_DEFINITIONS.has(init.callee.name)) return false
        const [name] = init.arguments
        if (t.isStringLiteral(name) && !names.has(name.value)) {
            names.set(name.value, exported && t.isIdentifier(declarator.id, { name: name.value }) ? file : null)
        }
        return true
    })
}

function readStatement(statement, file, names, sources) {
    if (t.isEmptyStatement(statement) || t.isFunctionDeclaration(statement)) return true
    if (t.isExpressionStatement(statement)) {
        const call = statement.expression
        if (!t.isCallExpression(call) || !t.isIdentifier(call.callee) || !NOTES.has(call.callee.name)) return false
        if (call.callee.name === "__use__" && t.isStringLiteral(call.arguments[1])) sources.push(call.arguments[1].value)
        return true
    }
    if (t.isImportDeclaration(statement) || t.isExportAllDeclaration(statement)) {
        sources.push(statement.source.value)
        return true
    }
    if (t.isExportNamedDeclaration(statement)) {
        if (statement.source) sources.push(statement.source.value)
        return !statement.declaration || t.isFunctionDeclaration(statement.declaration) || definesType(statement.declaration, file, true, names)
    }
    if (t.isExportDefaultDeclaration(statement)) return t.isFunctionDeclaration(statement.declaration)
    return definesType(statement, file, false, names)
}

function readModule(file, names, files) {
    if (files.has(file)) return true
    files.add(file)
    let ast
    try {
        ast = parseProgram(fs.readFileSync(file, "utf8"), file)
    } catch {
        return false
    }
    const sources = []
    for (const statement of ast.program.body) {
        if (!readStatement(statement, file, names, sources)) return false
    }
    for (const raw of sources) {
        const target = resolveSlimSource(raw.replace(/\.js$/, ""), file)
        if (!target || !fs.existsSync(target) || !readModule(target, names, files)) return false
    }
    return true
}

const cache = new Map()

function stampOf(files) {
    return [...files].map(file => fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? -1).join(",")
}

export function hostTypes(host) {
    const cached = cache.get(host)
    if (cached && stampOf(cached.files) === cached.stamp) return cached.result
    const names = new Map()
    const files = new Set()
    const result = readModule(host, names, files) ? names : null
    cache.set(host, { files, stamp: stampOf(files), result })
    return result
}

export function wordsOf(text, into = new Set()) {
    for (const [word] of text.matchAll(/[A-Za-z_$][\w$]*/g)) into.add(word)
    return into
}

export function mentionedNames(ast, candidates, taken = new Set()) {
    const found = new Set()
    if (candidates.size === 0) return found
    let local = {}
    const note = word => {
        if (candidates.has(word) && !taken.has(word) && !Object.hasOwn(local, word)) found.add(word)
    }
    traverse(ast, {
        Program(path_) {
            path_.scope.crawl()
            local = path_.scope.bindings
        },
        StringLiteral(path_) {
            wordsOf(path_.node.value).forEach(note)
        },
        TemplateElement(path_) {
            wordsOf(path_.node.value.cooked ?? path_.node.value.raw).forEach(note)
        },
        ReferencedIdentifier(path_) {
            if (!path_.scope.getBinding(path_.node.name)) note(path_.node.name)
        }
    })
    return found
}

export function hostImports(ast, host, sourceFile, taken) {
    const names = hostTypes(host)
    if (names === null) return null
    const self = path.resolve(sourceFile)
    const byFile = new Map()
    for (const name of [...mentionedNames(ast, new Set(names.keys()), taken)].sort()) {
        const file = names.get(name)
        if (file === null) return null
        if (path.resolve(file) === self) continue
        const list = byFile.get(file) ?? []
        list.push(name)
        byFile.set(file, list)
    }
    return byFile
}
