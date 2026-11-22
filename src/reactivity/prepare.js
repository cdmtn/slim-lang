import * as t from "@babel/types"
import { NOT_COMPONENTS, SKIP_KEYS, call, call_, id, isNode, keyName, thunk } from "./ast.js"
import { importedReactive, importedReaders, readsReactive } from "./reads.js"

export function innerPath(path) {
    const body = path.get("body")
    if (!body.isBlockStatement()) return body.get("arguments.0")
    const statement = body.get("body").find(item => item.isReturnStatement() && t.isCallExpression(item.node.argument))
    return statement.get("argument.arguments.0")
}

function expandPattern(declarator) {
    const { id: pattern, init } = declarator.node
    const source = declarator.scope.generateUidIdentifier("derived")
    const names = Object.keys(t.getBindingIdentifiers(pattern))
    const reads = names.map(name => {
        const local = t.identifier(name)
        local._slimReactive = "computed"
        const taken = t.variableDeclaration("const", [t.variableDeclarator(t.cloneNode(pattern), t.memberExpression(t.cloneNode(source), t.identifier("v")))])
        const read = t.arrowFunctionExpression([], t.blockStatement([taken, t.returnStatement(t.identifier(name))]))
        return t.variableDeclarator(local, call("__computed__", [thunk(t.callExpression(read, []))]))
    })
    declarator.replaceWithMultiple([t.variableDeclarator(source, call("__computed__", [thunk(init)])), ...reads])
}

const isHookCall = init => t.isCallExpression(init) && t.isIdentifier(init.callee) && /^use[A-Z]/.test(init.callee.name)

function suspends(node) {
    if (Array.isArray(node)) return node.some(suspends)
    if (!isNode(node) || t.isFunction(node) || t.isClassProperty(node) || t.isClassPrivateProperty(node)) return false
    if (t.isAwaitExpression(node) || t.isYieldExpression(node)) return true
    return Object.entries(node).some(([key, value]) => !SKIP_KEYS.has(key) && suspends(value))
}

function takeEquals(declarator) {
    let holder = declarator
    let key = "init"
    while (t.isCallExpression(holder[key]) && t.isIdentifier(holder[key].callee) && /^__typed_|^__lock_object__$/.test(holder[key].callee.name)) {
        holder = holder[key].arguments
        key = 0
    }
    const node = holder[key]
    if (!t.isSequenceExpression(node) || node.expressions.length !== 2) return null
    const [marker, value] = node.expressions
    if (!t.isCallExpression(marker) || !t.isIdentifier(marker.callee, { name: "__state_equals__" })) return null
    holder[key] = value
    return marker.arguments[0] ?? null
}

export function prepareDeclarations(statements) {
    const declarationOf = statement => statement.isExportNamedDeclaration() ? statement.get("declaration") : statement

    for (const statement of statements) {
        const declaration = declarationOf(statement)
        if (!declaration.node?.slimState) continue
        const [declarator] = declaration.node.declarations
        declarator.id._slimReactive = "signal"
        const equals = takeEquals(declarator)
        declarator.init = call("__signal__", equals ? [declarator.init, equals] : [declarator.init])
    }

    for (const statement of statements) {
        const declaration = declarationOf(statement)
        if (!declaration.isVariableDeclaration({ kind: "const" }) || declaration.node.slimState) continue
        let expanded = false
        for (const declarator of declaration.get("declarations")) {
            const { id: name, init } = declarator.node
            const injected = t.isCallExpression(init) && t.isIdentifier(init.callee, { name: "inject" })
            if (suspends(init)) continue
            if ((t.isObjectPattern(name) || t.isArrayPattern(name)) && init && (injected || readsReactive(declarator.get("init")))) {
                expandPattern(declarator)
                expanded = true
                continue
            }
            if (!t.isIdentifier(name) || name.name.startsWith("__") || !init) continue
            if (isHookCall(init)) {
                name._slimReactive = "hook"
                continue
            }
            if (init._slimMarkup) continue
            if (!injected && !readsReactive(declarator.get("init"))) continue
            name._slimReactive = "computed"
            declarator.node.init = call("__computed__", [thunk(init)])
        }
        if (expanded) declaration.scope.crawl()
    }
}

export function prepare(path, compiler) {
    const outer = path.node
    const inner = innerPath(path)

    const param = outer.params[0]
    const target = t.isAssignmentPattern(param) ? param.left : param
    const enclosing = path.findParent(parent => parent.node._slimComponent)
    outer._slimPropsName = enclosing ? path.scope.generateUid("props") : "__props__"
    if (t.isIdentifier(target)) target._slimProps = true
    if (t.isObjectPattern(target)) {
        for (const property of target.properties) {
            const value = t.isAssignmentPattern(property.value) ? property.value.left : property.value
            value._slimPropAlias = keyName(property.key)
            value._slimPropsName = outer._slimPropsName
        }
    }

    prepareDeclarations(inner.get("body.body"))

    const ctx = { scope: outer._slimComponent.bem, svg: false }
    inner.node.body = compiler.nested(inner.node.body, ctx)
}

export function passGetters(path) {
    path.traverse({
        CallExpression(call) {
            const callee = call.node.callee
            if (t.isIdentifier(callee, { name: "provide" }) && call.node.arguments.length === 2) {
                const value = call.get("arguments.1")
                if (!value.isFunction() && readsReactive(value)) value.replaceWith(call_("__live__", [thunk(value.node)]))
                return
            }
            if (!t.isIdentifier(callee) || !/^[A-Z]/.test(callee.name) || NOT_COMPONENTS.has(callee.name)) return
            const first = call.get("arguments.0")
            const hasChildren = first?.node && first.isCallExpression() && t.isIdentifier(first.node.callee, { name: "__lazy_children__" })
            const argument = hasChildren ? first.get("arguments.0") : first
            if (!argument?.node || !argument.isObjectExpression()) return
            for (const property of argument.get("properties")) {
                if (!property.isObjectProperty()) continue
                const value = property.get("value")
                if (value.isFunction() || !readsReactive(value)) continue
                const { key, computed } = property.node
                property.replaceWith(t.objectMethod("get", key, [], t.blockStatement([t.returnStatement(value.node)]), computed))
            }
        }
    })
}

function namespaceReads(programPath) {
    const names = [...importedReactive.keys(), ...importedReaders].filter(name => name.includes("."))
    const namespaces = new Set(names.map(name => name.split(".")[0]))
    if (namespaces.size === 0) return
    const isNamespace = (path, node) => t.isIdentifier(node) && namespaces.has(node.name) && !path.scope.getBinding(node.name)
    const read = (namespace, key) => {
        const name = `${namespace}.${key}`
        return importedReactive.has(name) || importedReaders.has(name) ? id(name) : t.memberExpression(id(namespace), t.stringLiteral(key), true)
    }
    programPath.traverse({
        VariableDeclarator(declarator) {
            const { id: pattern, init } = declarator.node
            if (!t.isObjectPattern(pattern) || !isNamespace(declarator, init)) return
            const reactive = property => t.isObjectProperty(property) && importedReactive.has(`${init.name}.${keyName(property.key)}`)
            if (!pattern.properties.some(reactive)) return
            const pieces = []
            for (const property of pattern.properties) {
                const key = t.isObjectProperty(property) && !property.computed ? keyName(property.key) : null
                if (key === null) return
                const value = property.value
                if (t.isIdentifier(value)) {
                    pieces.push(t.variableDeclarator(value, read(init.name, key)))
                } else if (t.isAssignmentPattern(value) && t.isIdentifier(value.left)) {
                    const given = id("__value__")
                    const fallback = t.conditionalExpression(t.binaryExpression("===", given, id("undefined")), value.right, t.cloneNode(given))
                    pieces.push(t.variableDeclarator(value.left, t.callExpression(t.arrowFunctionExpression([t.cloneNode(given)], fallback), [read(init.name, key)])))
                } else {
                    return
                }
            }
            declarator.replaceWithMultiple(pieces)
        },
        MemberExpression(member) {
            const { object, property, computed } = member.node
            if (member.node._slimNamespace || !isNamespace(member, object)) return
            const key = computed ? (t.isStringLiteral(property) ? property.value : null) : property.name
            if (key === null) {
                const reactive = names.filter(name => name.startsWith(`${object.name}.`) && importedReactive.has(name)).map(name => name.slice(object.name.length + 1))
                const parent = member.parentPath
                const written = (parent.isAssignmentExpression() && parent.node.left === member.node) || parent.isUpdateExpression()
                if (reactive.length === 0 || written) return
                const given = id("__key__")
                const lookup = () => {
                    const node = t.memberExpression(t.cloneNode(object), t.cloneNode(given), true)
                    node._slimNamespace = true
                    return node
                }
                const test = t.callExpression(t.memberExpression(t.arrayExpression(reactive.map(name => t.stringLiteral(name))), id("includes")), [t.cloneNode(given)])
                member.replaceWith(t.callExpression(t.arrowFunctionExpression([given],
                    t.conditionalExpression(test, t.memberExpression(lookup(), id("v")), lookup())), [property]))
                return
            }
            const name = `${object.name}.${key}`
            if (importedReactive.has(name) || importedReaders.has(name)) member.replaceWith(id(name))
        }
    })
}

export function prepareModule(programPath) {
    namespaceReads(programPath)
    const moduleStates = programPath.node.body.some(statement => (statement.declaration ?? statement).slimState)
    if (moduleStates || importedReactive.size > 0 || importedReaders.size > 0) prepareDeclarations(programPath.get("body"))
}
