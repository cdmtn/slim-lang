import _traverse from "@babel/traverse"
import { readType, formatType, namesInType, referenceName } from "../external/typeSyntax.js"
import * as t from "@babel/types"

const traverse = _traverse.default ?? _traverse

export function isRuntimeCall(node, name) {
    return t.isCallExpression(node) && t.isIdentifier(node.callee, { name })
}

export const TEST_NAMES = ["test", "describe", "assert", "assertEqual", "assertDeepEqual", "assertThrows", "assertRejects", "beforeEach", "afterEach", "beforeAll", "afterAll", "mock", "spyOn"]

const BUILTIN_TYPE_NAMES = new Set([
    "int", "float", "number", "string", "bool", "null", "undefined",
    "object", "array", "function", "any", "element", "bigint", "symbol", "never"
])

const DEFINITIONS = new Set(["__def_struct__", "__def_enum__", "__def_variants__"])

function thisResolver(path_) {
    const owner = path_.find(parent => parent.isClassMethod() || parent.isClassPrivateMethod() || parent.isClassProperty() ||
        parent.isClassPrivateProperty() || (parent.isCallExpression() && t.isIdentifier(parent.node.callee) &&
            (DEFINITIONS.has(parent.node.callee.name) || parent.node.callee.name === "__def_trait__")))
    if (!owner) return null
    if (owner.isCallExpression()) {
        const [name] = owner.node.arguments
        if (owner.node.callee.name === "__def_trait__" || !t.isStringLiteral(name)) return null
        return t.identifier(name.value)
    }
    if (owner.node.static) return null
    return t.memberExpression(t.thisExpression(), t.identifier("constructor"))
}

export function buildTypeSpec(typeText, path_, importedNames = new Set()) {
    const type = readType(typeText)
    const parts = type.kind === "union" || type.kind === "intersection" ? type.types : [type]

    const refs = parts.map(part => {
        const name = referenceName(part)
        if (name === "this") {
            const resolver = thisResolver(path_)
            if (!resolver) return t.callExpression(t.identifier("__type_ref__"), [t.stringLiteral("any")])
            return t.callExpression(t.identifier("__type_ref__"), [t.stringLiteral(formatType(part)), t.arrowFunctionExpression([], resolver)])
        }
        const binding = name ? path_.scope.getBinding(name) : null
        const args = [t.stringLiteral(formatType(part))]

        if ((binding || importedNames.has(name)) && !BUILTIN_TYPE_NAMES.has(name)) {
            args.push(t.arrowFunctionExpression([], t.identifier(name)))
        }
        const nested = [...namesInType(part)].filter(other => other !== name && other !== "this" && !BUILTIN_TYPE_NAMES.has(other) &&
            (path_.scope.getBinding(other) || importedNames.has(other)))
        if (nested.length) {
            if (args.length === 1) args.push(t.nullLiteral())
            args.push(t.arrowFunctionExpression([], t.objectExpression(nested.map(other => t.objectProperty(t.identifier(other), t.identifier(other), false, true)))))
        }

        return t.callExpression(t.identifier("__type_ref__"), args)
    })

    const combinator = type.kind === "intersection" ? "__type_spec_all__" : "__type_spec__"
    return t.callExpression(t.identifier(combinator), refs)
}

export function typeLabelFromArgument(node) {
    return t.isStringLiteral(node) ? node.value : null
}

export function buildTypedCheck(binding, value) {
    return t.callExpression(t.identifier("__typed_variable_check__"), [
        t.cloneNode(binding.slot),
        value,
        t.stringLiteral(binding.name)
    ])
}

export function getMemberName(member) {
    if (t.isPrivateName(member.property)) return `#${member.property.id.name}`
    if (!member.computed && t.isIdentifier(member.property)) return member.property.name
    if (member.computed && t.isStringLiteral(member.property)) return member.property.value
    return null
}

const NOT_STRUCT_LABELS = new Set(["any", "object"])

export function structAssignments(ast) {
    const labels = new Map()
    const note = (path_, name, label) => {
        const binding = path_.scope.getBinding(name)
        if (binding && t.isStringLiteral(label) && !NOT_STRUCT_LABELS.has(label.value)) labels.set(binding, label.value)
    }
    traverse(ast, {
        VariableDeclarator(path_) {
            const { id, init } = path_.node
            if (t.isIdentifier(id) && isRuntimeCall(init, "__typed_variable__")) note(path_, id.name, init.arguments[1])
        },
        CallExpression(path_) {
            const [value, label] = path_.node.arguments
            if (isRuntimeCall(path_.node, "__typed_parameter__") && t.isIdentifier(value)) note(path_, value.name, label)
        }
    })
    if (labels.size === 0) return
    traverse(ast, {
        AssignmentExpression(path_) {
            const { left, right, operator } = path_.node
            if (operator !== "=" || !t.isIdentifier(left)) return
            const label = labels.get(path_.scope.getBinding(left.name))
            const literal = t.isObjectExpression(right) || (t.isArrayExpression(right) && right.elements.some(element => t.isObjectExpression(element)))
            if (!label || !literal) return
            path_.node.right = t.callExpression(t.identifier("__as_struct__"), [right, t.stringLiteral(label)])
        }
    })
}

export const TYPED_RETURNS = {
    Function(inner) { inner.skip() },
    ReturnStatement(statement, { specification, fnName, label, primitiveTest }) {
        const value = statement.node.argument
        if (value?._slimProven) return
        const checked = t.callExpression(t.identifier("__typed_return__"), [
            value ?? t.identifier("undefined"),
            t.cloneNode(specification),
            t.stringLiteral(fnName)
        ])
        const test = t.isIdentifier(value) && value.name !== "undefined" ? primitiveTest(label, value) : null
        statement.node.argument = test ? t.conditionalExpression(test, t.cloneNode(value), checked) : checked
    }
}

const UNDEFINED_TYPES = new Set(["void", "any", "unknown", "undefined", "null"])

export function allowsUndefined(type) {
    if (type.kind === "union") return type.types.some(allowsUndefined)
    return type.kind === "named" && UNDEFINED_TYPES.has(type.name)
}

export function identifierNames(node, names = new Set()) {
    if (!node || typeof node !== "object") return names
    if (Array.isArray(node)) {
        for (const child of node) identifierNames(child, names)
        return names
    }
    if (node.type === "Identifier") names.add(node.name)
    for (const key in node) {
        if (key === "loc" || key === "extra") continue
        const value = node[key]
        if (value && typeof value === "object") identifierNames(value, names)
    }
    return names
}
