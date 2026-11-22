import _traverse from "@babel/traverse"
import _generate from "@babel/generator"
import * as t from "@babel/types"
import { identifierNames, isRuntimeCall } from "./typeSpecs.js"

const traverse = _traverse.default ?? _traverse
const generate = _generate.default ?? _generate

const typeOf = (value, name) => t.binaryExpression("===", t.unaryExpression("typeof", t.cloneNode(value)), t.stringLiteral(name))

const PRIMITIVE_TESTS = {
    number: value => t.logicalExpression("&&", typeOf(value, "number"), t.binaryExpression("===", t.cloneNode(value), t.cloneNode(value))),
    int: value => t.callExpression(t.memberExpression(t.identifier("Number"), t.identifier("isSafeInteger")), [t.cloneNode(value)]),
    string: value => typeOf(value, "string"),
    bool: value => typeOf(value, "boolean")
}
PRIMITIVE_TESTS.float = PRIMITIVE_TESTS.number

export function primitiveTest(label, value, optional = false) {
    const build = Object.hasOwn(PRIMITIVE_TESTS, label) ? PRIMITIVE_TESTS[label] : null
    if (!build) return null
    const test = build(value)
    return optional ? t.logicalExpression("||", t.binaryExpression("==", t.cloneNode(value), t.nullLiteral()), test) : test
}

const SPECS = new Set(["__type_spec__", "__type_spec_all__"])

function insideIsolatedBody(path_) {
    return !!path_.findParent(parent => isRuntimeCall(parent.node, "__isolated_body__"))
}

function moduleLevel(path_, spec, importedNames) {
    let level = "eager"
    path_.traverse({
        ArrowFunctionExpression(inner) {
            const body = inner.node.body
            if (!t.isIdentifier(body)) {
                level = false
                inner.stop()
                return
            }
            const binding = inner.scope.getBinding(body.name)
            if (binding ? !binding.scope.path.isProgram() : !importedNames.has(body.name)) {
                level = false
                inner.stop()
            } else if (binding) {
                level = "lazy"
            }
            inner.skip()
        },
        Function(inner) {
            if (inner.isArrowFunctionExpression()) return
            level = false
            inner.stop()
        }
    })
    return spec.arguments.every(argument => isRuntimeCall(argument, "__type_ref__")) ? level : false
}

export function hoistTypeSpecs(ast, importedNames) {
    const taken = identifierNames(ast.program)
    const hoisted = new Map()
    let count = 0
    const nameFor = key => {
        let id = hoisted.get(key)?.id
        if (id) return id
        let name
        do name = `_slimSpec${count++}`
        while (taken.has(name))
        taken.add(name)
        return t.identifier(name)
    }

    traverse(ast, {
        CallExpression(path_) {
            const { node } = path_
            if (!t.isIdentifier(node.callee) || !SPECS.has(node.callee.name) || node._slimHoisted) return
            path_.skip()
            node._slimHoisted = true
            if (path_.scope.path.isProgram() || insideIsolatedBody(path_)) return
            const level = moduleLevel(path_, node, importedNames)
            if (!level) return
            const key = generate(node, { compact: true }).code
            const id = nameFor(key)
            if (!hoisted.has(key)) hoisted.set(key, { id, init: level === "eager" ? node : null })
            path_.replaceWith(level === "eager"
                ? t.cloneNode(id)
                : t.logicalExpression("||", t.cloneNode(id), t.assignmentExpression("=", t.cloneNode(id), node)))
        }
    })

    const eager = [...hoisted.values()].filter(entry => entry.init)
    const lazy = [...hoisted.values()].filter(entry => !entry.init)
    const declarations = []
    if (eager.length) declarations.push(t.variableDeclaration("const", eager.map(({ id, init }) => t.variableDeclarator(t.cloneNode(id), init))))
    if (lazy.length) declarations.push(t.variableDeclaration("let", lazy.map(({ id }) => t.variableDeclarator(t.cloneNode(id)))))
    for (const declaration of declarations) declaration._slimTypeSlots = true
    ast.program.body.unshift(...declarations)
}
