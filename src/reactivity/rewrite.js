import * as t from "@babel/types"
import { SKIP_KEYS, call, done, id, isNode, keyName, thunk } from "./ast.js"
import { importedReactive, reactiveKind } from "./reads.js"
import { innerPath } from "./prepare.js"

const READ_METHODS = new Set([
    "at", "concat", "entries", "every", "filter", "find", "findIndex", "findLast", "findLastIndex", "flat",
    "flatMap", "forEach", "includes", "indexOf", "join", "keys", "lastIndexOf", "map", "reduce", "reduceRight",
    "slice", "some", "values", "with", "get", "charAt", "charCodeAt", "codePointAt", "endsWith", "startsWith",
    "padStart", "padEnd", "repeat", "replace", "replaceAll", "search", "split", "substring", "substr",
    "trim", "trimStart", "trimEnd", "match", "matchAll", "localeCompare", "normalize", "valueOf"
])

function readsOnly(member) {
    const name = !member.computed && t.isIdentifier(member.property) ? member.property.name
        : t.isStringLiteral(member.property) ? member.property.value : null
    if (name === null) return false
    return READ_METHODS.has(name) || /^(get|has|is|to)[A-Z]/.test(name)
}

const COMPARISONS = new Set(["==", "===", "!=", "!=="])

function changesThrough(ref) {
    let top = ref
    while ((top.parentPath.isMemberExpression() || top.parentPath.isOptionalMemberExpression()) &&
        top.parentPath.node.object === top.node) top = top.parentPath
    if (top === ref) return false
    const outer = top.parentPath
    return (outer.isAssignmentExpression() && outer.node.left === top.node) || outer.isUpdateExpression() ||
        outer.isUnaryExpression({ operator: "delete" }) ||
        ((outer.isCallExpression() || outer.isOptionalCallExpression()) && outer.node.callee === top.node && !readsOnly(top.node))
}

function checkAliases(path, fail) {
    path.traverse({
        VariableDeclarator(declarator) {
            const { id: name, init } = declarator.node
            if (!t.isIdentifier(name) || !t.isIdentifier(init) || name._slimReactive) return
            const kind = reactiveKind(declarator.get("init"))
            if (kind !== "signal" && kind !== "computed") return
            const binding = declarator.scope.getBinding(name.name)
            const changed = binding?.referencePaths.find(changesThrough)
            if (changed) {
                fail(changed.node, `"${name.name}" holds the state "${init.name}": a change through "${name.name}" doesn't update the page — change "${init.name}" itself`)
            }
        }
    })
}

const MUTATORS = {
    Object: new Set(["assign", "defineProperty", "defineProperties", "setPrototypeOf"]),
    Reflect: new Set(["set", "deleteProperty", "defineProperty", "setPrototypeOf"])
}

const CHANGING_METHODS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin", "set", "add", "delete", "clear"])

function surelyChanges(outer) {
    if (!outer.isCallExpression() && !outer.isOptionalCallExpression()) return true
    const callee = outer.node.callee
    if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return true
    if (isMutator(outer)) return true
    return !callee.computed && t.isIdentifier(callee.property) && CHANGING_METHODS.has(callee.property.name)
}

function isMutator(call) {
    const callee = call.node.callee
    if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.object) || !t.isIdentifier(callee.property)) return false
    return !!MUTATORS[callee.object.name]?.has(callee.property.name) && !call.scope.getBinding(callee.object.name)
}

export function mutationAt(ref) {
    let top = ref
    let depth = 0
    while ((top.parentPath.isMemberExpression() || top.parentPath.isOptionalMemberExpression()) &&
        top.parentPath.node.object === top.node) {
        top = top.parentPath
        depth++
    }
    const outer = top.parentPath
    if (top !== ref) {
        const changes = (outer.isAssignmentExpression() && outer.node.left === top.node) ||
            outer.isUpdateExpression() ||
            outer.isUnaryExpression({ operator: "delete" }) ||
            ((outer.isCallExpression() || outer.isOptionalCallExpression()) && outer.node.callee === top.node && !readsOnly(top.node))
        if (changes) return { outer, depth }
    }
    if (outer.isCallExpression() && top.listKey === "arguments" && top.key === 0 && isMutator(outer)) return { outer, depth: depth + 1 }
    return null
}

function mapTargets(node, fn) {
    if (t.isIdentifier(node)) return fn(node)
    if (t.isArrayPattern(node)) {
        node.elements = node.elements.map(element => element && mapTargets(element, fn))
    } else if (t.isObjectPattern(node)) {
        for (const property of node.properties) {
            if (t.isRestElement(property)) {
                property.argument = mapTargets(property.argument, fn)
            } else {
                property.value = mapTargets(property.value, fn)
                property.shorthand = false
            }
        }
    } else if (t.isRestElement(node)) {
        node.argument = mapTargets(node.argument, fn)
    } else if (t.isAssignmentPattern(node)) {
        node.left = mapTargets(node.left, fn)
    }
    return node
}

function writableState(scope, node) {
    const binding = scope.getBinding(node.name)
    if (!binding) return importedReactive.get(node.name) === "signal"
    const target = binding.identifier
    return target._slimReactive === "signal" || target._slimPropAlias !== undefined
}

function writesState(pattern, scope) {
    let found = false
    mapTargets(t.cloneNode(pattern, true), node => {
        if (writableState(scope, node)) found = true
        return node
    })
    return found
}

function detachStateWrites(path) {
    path.traverse({
        "ForOfStatement|ForInStatement"(loop) {
            const { left } = loop.node
            if (t.isVariableDeclaration(left) || !writesState(left, loop.scope)) return
            const item = loop.scope.generateUidIdentifier("item")
            loop.node.left = t.variableDeclaration("const", [t.variableDeclarator(item)])
            const body = t.isBlockStatement(loop.node.body) ? loop.node.body : t.blockStatement([loop.node.body])
            body.body.unshift(t.expressionStatement(t.assignmentExpression("=", left, t.cloneNode(item))))
            loop.node.body = body
        }
    })
    path.traverse({
        AssignmentExpression(assign) {
            const { left, right, operator } = assign.node
            if (operator !== "=" || (!t.isArrayPattern(left) && !t.isObjectPattern(left)) || !writesState(left, assign.scope)) return
            const scope = assign.scope
            const temps = []
            const pattern = mapTargets(left, node => {
                if (!writableState(scope, node)) return node
                const temp = scope.generateUidIdentifier(node.name)
                temps.push([temp, node])
                return t.cloneNode(temp)
            })
            const value = scope.generateUidIdentifier("value")
            for (const temp of [value, ...temps.map(([temp]) => temp)]) scope.push({ id: t.cloneNode(temp) })
            assign.replaceWith(t.sequenceExpression([
                t.assignmentExpression("=", t.cloneNode(value), right),
                t.assignmentExpression("=", pattern, t.cloneNode(value)),
                ...temps.map(([temp, target]) => t.assignmentExpression("=", target, t.cloneNode(temp))),
                t.cloneNode(value)
            ]))
        }
    })
}

const ITEM_CALLBACKS = {
    forEach: 0, map: 0, flatMap: 0, filter: 0, some: 0, every: 0, find: 0, findLast: 0, findIndex: 0, findLastIndex: 0,
    reduce: 1, reduceRight: 1
}

const KEEPS_ELEMENTS = new Set([
    "filter", "find", "findLast", "slice", "sort", "toSorted", "reverse", "toReversed", "at", "concat", "flat",
    "values", "splice", "with", "toSpliced", "get"
])

function rootOf(node) {
    let current = node
    while (true) {
        if (t.isMemberExpression(current) || t.isOptionalMemberExpression(current)) {
            current = current.object
        } else if ((t.isCallExpression(current) || t.isOptionalCallExpression(current)) &&
            (t.isMemberExpression(current.callee) || t.isOptionalMemberExpression(current.callee))) {
            const { property, computed } = current.callee
            if (computed || !t.isIdentifier(property) || !KEEPS_ELEMENTS.has(property.name)) return null
            current = current.callee.object
        } else {
            return t.isIdentifier(current) ? current : null
        }
    }
}

function itemSource(scope, node) {
    const root = rootOf(node)
    if (!root) return null
    const binding = scope.getBinding(root.name)
    if (!binding) return importedReactive.get(root.name) === "signal" ? { name: root.name, binding: null } : null
    if (binding.identifier._slimReactive === "signal") return { name: root.name, binding }
    return binding.identifier._slimItemOf ?? null
}

function computedSource(init) {
    if (t.isCallExpression(init) && t.isIdentifier(init.callee, { name: "__computed__" }) && t.isArrowFunctionExpression(init.arguments[0]) &&
        !t.isBlockStatement(init.arguments[0].body)) return init.arguments[0].body
    return init
}

function markItems(path) {
    const mark = (target, source) => {
        for (const node of Object.values(t.getBindingIdentifiers(target))) {
            if (!node._slimReactive || node._slimReactive === "computed") {
                Object.defineProperty(node, "_slimItemOf", { value: source, writable: true, configurable: true, enumerable: false })
            }
        }
    }
    path.traverse({
        VariableDeclarator(declarator) {
            const { id: name, init } = declarator.node
            if (!t.isIdentifier(name) || !init || declarator.parent.kind !== "const") return
            const expression = computedSource(init)
            if (t.isIdentifier(expression)) return
            const source = itemSource(declarator.scope, expression)
            if (source) mark(name, source)
        },
        CallExpression(call) {
            const { callee, arguments: args } = call.node
            if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return
            if (callee.computed || !t.isIdentifier(callee.property) || !Object.hasOwn(ITEM_CALLBACKS, callee.property.name)) return
            const fn = args[0]
            const param = t.isFunction(fn) ? fn.params[ITEM_CALLBACKS[callee.property.name]] : null
            if (!param) return
            const source = itemSource(call.scope, callee.object)
            if (source) mark(param, source)
        },
        ForOfStatement(loop) {
            if (!t.isVariableDeclaration(loop.node.left)) return
            const source = itemSource(loop.scope, loop.node.right)
            if (source) for (const declarator of loop.node.left.declarations) mark(declarator.id, source)
        }
    })
}

export function rewrite(path, fail) {
    const leaves = []
    const mutations = []
    const selections = []

    checkAliases(path, fail)
    detachStateWrites(path)
    path.scope.crawl()
    markItems(path)

    path.traverse({
        Identifier(ref) {
            const node = ref.node
            if (node._slimDone) return
            const binding = ref.scope.getBinding(node.name)
            if (binding?.identifier === node) return
            const kind = reactiveKind(ref)
            if (kind === null && binding?.identifier._slimItemOf && ref.isReferencedIdentifier()) {
                const change = mutationAt(ref)
                const owner = binding.identifier._slimItemOf
                if (change) mutations.push([change.outer, owner.name, null, node, owner.binding && ref.scope.getBinding(owner.name) !== owner.binding ? owner.binding : null])
                return
            }
            if (kind === null || kind === "props" || kind === "hook") return

            const parent = ref.parentPath
            if (parent.isExportSpecifier() || parent.isExportDefaultDeclaration()) return
            const write = (parent.isAssignmentExpression() && parent.node.left === node) || parent.isUpdateExpression()
            if (!write && !ref.isReferencedIdentifier()) return

            if (kind === "alias") {
                if (write) fail(node, `"${node.name}" is a prop and can't be assigned: copy it into a state or a let first`)
                leaves.push([ref, t.memberExpression(done(binding.identifier._slimPropsName ?? "__props__"), id(binding.identifier._slimPropAlias))])
                return
            }

            if (kind === "signal" && parent.isBinaryExpression() && COMPARISONS.has(parent.node.operator) &&
                !selections.some(([comparison]) => comparison.node === parent.node) &&
                !referencesAny(parent.node[ref.key === "left" ? "right" : "left"], new Set([node.name])) &&
                ref.findParent(ancestor => ancestor.node._slimListRow)) {
                selections.push([parent, ref.key === "left" ? "right" : "left", node.name])
                return
            }

            leaves.push([ref, t.memberExpression(done(node.name), id("v"))])
            if (write) return

            const change = mutationAt(ref)
            if (!change) return
            if (kind === "computed") {
                if (!surelyChanges(change.outer)) return
                fail(node, `"${node.name}" is recomputed from a state or props, a change to it is lost on the next update — change what it comes from, or declare it with state`)
            }
            const item = change.depth >= 2 ? ref.parentPath : null
            mutations.push([change.outer, node.name, item && !item.node.optional ? item : null])
        }
    })

    for (const [ref, value] of leaves) {
        const parent = ref.parent
        if (t.isObjectProperty(parent) && parent.shorthand && parent.value === ref.node) parent.shorthand = false
        ref.replaceWith(value)
    }
    for (const [comparison, other, name] of selections) {
        const { operator } = comparison.node
        const test = call("__is__", [done(name), comparison.node[other], t.booleanLiteral(operator.length === 3)])
        comparison.replaceWith(operator[0] === "!" ? t.unaryExpression("!", test) : test)
    }
    mutations.sort((a, b) => b[0].getAncestry().length - a[0].getAncestry().length)
    const hoisted = new Map()
    const sourceOf = (name, shadowed) => {
        if (!shadowed || !shadowed.path.isVariableDeclarator()) return done(name)
        if (!hoisted.has(shadowed)) {
            const local = shadowed.path.scope.generateUid(name)
            const statement = shadowed.path.parentPath.parentPath.isExportNamedDeclaration() ? shadowed.path.parentPath.parentPath : shadowed.path.parentPath
            statement.insertAfter(t.variableDeclaration("const", [t.variableDeclarator(id(local), done(name))]))
            hoisted.set(shadowed, local)
        }
        return done(hoisted.get(shadowed))
    }
    for (const [target, name, item, alias, shadowed] of mutations) {
        if (alias) {
            target.replaceWith(call("__mut_deep__", [sourceOf(name, shadowed), thunk(target.node), t.cloneNode(alias)]))
            continue
        }
        if (!item) {
            target.replaceWith(call("__mut__", [done(name), target.node]))
            continue
        }
        const object = item.node
        item.replaceWith(id("__o__"))
        target.replaceWith(call("__mut_deep__", [done(name), t.arrowFunctionExpression([id("__o__")], target.node), object]))
    }
}

export function propsParameter(path) {
    const outer = path.node
    const param = outer.params[0]
    const target = t.isAssignmentPattern(param) ? param.left : param
    if (!t.isObjectPattern(target)) return

    const name = outer._slimPropsName ?? "__props__"
    const defaults = target.properties
        .filter(property => t.isAssignmentPattern(property.value))
        .map(property => t.objectProperty(t.stringLiteral(keyName(property.key)), thunk(property.value.right)))
    outer.params[0] = t.assignmentPattern(id(name), t.objectExpression([]))
    if (defaults.length === 0) return

    const inner = innerPath(path).node
    inner.body.body.unshift(t.expressionStatement(t.assignmentExpression("=", id(name),
        call("__defaults__", [id(name), t.objectExpression(defaults)]))))
}

export function passRawProps(path) {
    const param = path.node.params[0]
    const target = t.isAssignmentPattern(param) ? param.left : param
    if (!t.isIdentifier(target)) return
    const runner = innerPath(path).parentPath
    if (runner.isCallExpression() && t.isIdentifier(runner.node.callee, { name: "__component__" }) && runner.node.arguments.length === 1) {
        runner.node.arguments.push(id(target.name))
    }
}

function referencesAny(node, names) {
    if (!isNode(node) || t.isFunction(node)) return false
    if (t.isIdentifier(node) && names.has(node.name)) return true
    for (const [key, value] of Object.entries(node)) {
        if (SKIP_KEYS.has(key)) continue
        if (Array.isArray(value) ? value.some(child => referencesAny(child, names)) : referencesAny(value, names)) return true
    }
    return false
}
