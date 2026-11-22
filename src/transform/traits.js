import _traverse from "@babel/traverse"
import * as t from "@babel/types"
import { isRuntimeCall } from "./typeSpecs.js"
import { wordsOf } from "./host.js"

const traverse = _traverse.default ?? _traverse

function traitDefinition(statement) {
    const declaration = t.isExportNamedDeclaration(statement) ? statement.declaration : statement
    if (!t.isVariableDeclaration(declaration) || declaration.declarations.length !== 1) return null
    const [declarator] = declaration.declarations
    if (!t.isIdentifier(declarator.id)) return null
    const alias = isRuntimeCall(declarator.init, "__type_def__")
    if (!alias && !isRuntimeCall(declarator.init, "__def_trait__")) return null
    return { statement, declarator, name: declarator.id.name, alias }
}

const SKIPPED = new Set(["loc", "extra", "leadingComments", "trailingComments", "innerComments"])

function walk(node, visit, seen = new WeakSet()) {
    if (!node || typeof node !== "object" || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
        for (const child of node) walk(child, visit, seen)
        return
    }
    if (visit(node) === false) return
    for (const key in node) {
        if (SKIPPED.has(key) || key.startsWith("_")) continue
        const value = node[key]
        if (value && typeof value === "object") walk(value, visit, seen)
    }
}

function stringWords(node, into = new Set()) {
    walk(node, child => {
        if (child.type === "StringLiteral") wordsOf(child.value, into)
        else if (child.type === "TemplateElement") wordsOf(child.value.cooked ?? child.value.raw, into)
    })
    return into
}

function labelWords(node, into) {
    walk(node, child => {
        if (!t.isCallExpression(child) || !t.isIdentifier(child.callee) || !/^__\w+__$/.test(child.callee.name)) return
        stringWords(child.arguments, into)
        return false
    })
    return into
}

const SPEC_CALLS = new Set(["__type_spec__", "__type_spec_all__", "__type_ref__"])

function markSpecsPure(node) {
    walk(node, child => {
        if (t.isFunction(child)) return false
        if (t.isCallExpression(child) && t.isIdentifier(child.callee) && SPEC_CALLS.has(child.callee.name)) t.addComment(child, "leading", "#__PURE__")
    })
}

const lazyList = names => t.arrowFunctionExpression([], t.arrayExpression(names.map(name => t.identifier(name))))

export function shareTraits(ast, importedNames) {
    let bindings = {}
    traverse(ast, {
        Program(path_) {
            path_.scope.crawl()
            bindings = path_.scope.bindings
            path_.stop()
        }
    })
    const body = ast.program.body
    const definitions = body.map(traitDefinition).filter(Boolean)
    const traits = new Set(definitions.map(definition => definition.name).filter(name => Object.hasOwn(bindings, name)))
    const available = name => traits.has(name) || importedNames.has(name)

    for (const definition of definitions) {
        if (definition.alias) {
            markSpecsPure(definition.declarator.init.arguments)
            t.addComment(definition.declarator.init, "leading", "#__PURE__")
            definition.statement._slimPureDefinition = true
            continue
        }
        const words = stringWords(definition.declarator.init.arguments)
        words.delete(definition.name)
        const args = definition.declarator.init.arguments
        while (args.length < 5) args.push(t.nullLiteral())
        args[5] = lazyList([...words].filter(available).sort())
        t.addComment(definition.declarator.init, "leading", "#__PURE__")
        definition.statement._slimPureDefinition = true
    }

    const used = new Set()
    for (const statement of body) if (!statement._slimPureDefinition) labelWords(statement, used)
    const names = [...used].filter(available).sort()
    if (names.length) body.push(t.expressionStatement(t.callExpression(t.identifier("__uses__"), [lazyList(names)])))
}
