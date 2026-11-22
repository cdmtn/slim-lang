import _traverse from "@babel/traverse"
import * as t from "@babel/types"
import { parseMarkup } from "../syntax/markup.js"
import { exits } from "./narrowing.js"
import { atoms, isMarkupType, isNamed } from "./core.js"
import { elementType, infer } from "./infer.js"
import { stateParamVisitor } from "./stateParams.js"

const traverse = _traverse.default ?? _traverse

const TYPE_PROPERTIES = ["_slimType", "_slimCatchType"]
const NAME = /[A-Za-z_$][\w$]*/g

function markupTags(node, found) {
    const visit = element => {
        if (element.type !== "element") return
        found.add(element.tag.split(".")[0])
        element.children.forEach(visit)
    }
    try {
        parseMarkup(node._slimQuasis, message => { throw new Error(message) }).forEach(visit)
    } catch {
    }
}

function typeWords(text, found) {
    for (const word of text.match(NAME) ?? []) found.add(word)
}

function runtimeCallName(path_) {
    const call = path_.findParent(parent => parent.isCallExpression() && t.isIdentifier(parent.node.callee) && parent.node.callee.name.startsWith("__"))
    return call?.node.callee.name ?? null
}

function usedNamesVisitor(free) {
    return {
        Identifier(path_) {
            if (path_.isReferencedIdentifier() && !path_.scope.getBinding(path_.node.name)) free.add(path_.node.name)
            for (const property of TYPE_PROPERTIES) if (typeof path_.node[property] === "string") typeWords(path_.node[property], free)
        },
        VariableDeclarator(path_) {
            for (const property of TYPE_PROPERTIES) if (typeof path_.node[property] === "string") typeWords(path_.node[property], free)
            const props = path_.node.init?._slimComponentProps
            if (props?.type) typeWords(props.type, free)
            for (const field of props?.fields ?? []) if (field.type) typeWords(field.type, free)
        },
        StringLiteral(path_) {
            if (runtimeCallName(path_)) typeWords(path_.node.value, free)
        },
        Function(path_) {
            const signature = path_.node._slimSignature
            if (!signature) return
            for (const label of [...signature.params, signature.returns, ...Object.values(signature.constraints ?? {})]) if (label) typeWords(label, free)
        },
        TaggedTemplateExpression(path_) {
            if (path_.node._slimQuasis) markupTags(path_.node, free)
        }
    }
}

function markupParts(node, path_, env) {
    const type = infer(node, path_, env)
    const all = type ? atoms(type, env) : []
    return all.length > 0 && all.every(atom => isMarkupType(atom) || isNamed(atom, "undefined") || isNamed(atom, "null")) && all.some(isMarkupType)
}

function markupVisitor(env, warn) {
    return {
        BinaryExpression(path_) {
            const { node } = path_
            if (node.operator !== "+") return
            const left = markupParts(node.left, path_, env)
            const right = markupParts(node.right, path_, env)
            if (!left && !right) return
            const other = left ? node.right : node.left
            const otherType = infer(other, path_, env)
            const stringy = !otherType || atoms(otherType, env).some(atom => isNamed(atom, "string") || (atom.kind === "literal" && typeof atom.value === "string") || isMarkupType(atom))
            if (!stringy) return
            warn(node, `"+" turns markup into a plain string that is escaped when shown: put both parts in one markup, <span>\${a}\${b}</span>, or use raw.join([a, b], "")`)
        },
        CallExpression(path_) {
            const callee = path_.node.callee
            if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.property, { name: "join" })) return
            const list = infer(callee.object, path_, env)
            const element = list && atoms(list, env).every(atom => atom.kind === "array" || atom.kind === "tuple") ? elementType(list, env) : null
            if (!element || !atoms(element, env).some(isMarkupType)) return
            warn(path_.node, `".join" turns markup into a plain string that is escaped when shown: put the list in markup as \${list}, or use raw.join(list, separator)`)
        }
    }
}

function isDefinition(init) {
    if (init?._slimComponentProps !== undefined) return true
    return t.isCallExpression(init) && t.isIdentifier(init.callee) && (init.callee.name.startsWith("__def") || init.callee.name === "__type_def__")
}

function unusedBinding(name, binding, path_, used, warn) {
    if (binding.scope !== path_.scope || name.startsWith("_") || used.has(name)) return
    if (binding.referenced || binding.constantViolations.length > 0) return
    const declaration = binding.path
    const node = declaration.node
    if (typeof node?.start !== "number") return
    if (binding.kind === "param" || binding.kind === "module" || binding.kind === "local") return
    if (declaration.parentPath?.parentPath?.isExportNamedDeclaration() || declaration.parentPath?.isExportNamedDeclaration()) return
    if (declaration.isFunctionDeclaration()) {
        warn(node.id ?? node, `function "${name}" is declared but never used`)
        return
    }
    if (!declaration.isVariableDeclarator() || !t.isIdentifier(node.id) || isDefinition(node.init)) return
    if (path_.isProgram() && node.init && !t.isFunction(node.init) && !t.isLiteral(node.init)) return
    warn(node.id, `"${name}" is declared but never used`)
}

function unusedBindings(scopes, used, warn) {
    for (const path_ of scopes) {
        for (const [name, binding] of Object.entries(path_.scope.bindings)) unusedBinding(name, binding, path_, used, warn)
    }
}

function unreachableVisitor(warn) {
    return {
        "BlockStatement|Program"(path_) {
            const body = path_.node.body
            const end = body.findIndex(statement => exits(statement))
            if (end === -1) return
            const next = body.slice(end + 1).find(statement => !t.isFunctionDeclaration(statement) && typeof statement.start === "number")
            if (!next) return
            const exit = body[end]
            const word = t.isReturnStatement(exit) ? "return" : t.isThrowStatement(exit) ? "throw" : t.isBreakStatement(exit) ? "break" : t.isContinueStatement(exit) ? "continue" : "this point"
            warn(next, `unreachable code: nothing after ${word} runs`)
        }
    }
}

export function checkWarnings(ast, env, warn, useLocations) {
    const used = new Set()
    const scopes = []
    traverse(ast, traverse.visitors.merge([
        usedNamesVisitor(used),
        unreachableVisitor(warn),
        markupVisitor(env, warn),
        stateParamVisitor(warn),
        { Scope(path_) { scopes.push(path_) } }
    ]))
    unusedBindings(scopes, used, warn)
    for (const { names, start } of useLocations) {
        for (const name of names) {
            if (!used.has(name)) warn({ start }, `"${name}" is imported but never used`)
        }
    }
}
