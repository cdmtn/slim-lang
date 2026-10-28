import * as t from "@babel/types"
import _traverse from "@babel/traverse"
import { parseMarkup } from "./syntax/markup.js"
import fs from "node:fs"
import { parseSlim, slimSyntaxError } from "./syntax/plugin.js"

const traverse = _traverse.default ?? _traverse

const SKIP_KEYS = new Set(["loc", "start", "end", "extra", "leadingComments", "trailingComments", "innerComments"])

const isNode = value => !!value && typeof value === "object" && typeof value.type === "string"
const isMarkup = node => node?.type === "TaggedTemplateExpression" && node._slimMarkup === true
const id = name => t.identifier(name)
const call = (name, args) => t.callExpression(id(name), args)
const call_ = call
const thunk = body => t.arrowFunctionExpression([], body)

function done(name) {
    const node = id(name)
    node._slimDone = true
    return node
}

const SVG_ONLY = new Set([
    "g", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "tspan", "defs", "use",
    "symbol", "clipPath", "mask", "pattern", "linearGradient", "radialGradient", "stop", "filter", "marker", "text"
])

const NOT_COMPONENTS = new Set([
    "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Date", "Error", "TypeError",
    "RangeError", "SyntaxError", "Promise", "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "Proxy", "Reflect",
    "JSON", "Math", "Intl", "URL", "URLSearchParams", "Response", "Request", "Headers", "Blob", "File",
    "FormData", "Event", "CustomEvent", "AbortController", "RegExp"
])

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


const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" }

function cook(raw) {
    return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (_, escape) => {
        if (escape[0] === "u" && escape.length > 1) {
            return String.fromCodePoint(parseInt(escape[1] === "{" ? escape.slice(2, -1) : escape.slice(1), 16))
        }
        if (escape[0] === "x" && escape.length === 3) return String.fromCharCode(parseInt(escape.slice(1), 16))
        if (escape === "\n" || escape === "\r\n" || escape === "\r") return ""
        return ESCAPES[escape] ?? escape
    })
}

function staticText(node) {
    if (t.isStringLiteral(node)) return node.value
    if (t.isNumericLiteral(node)) return String(node.value)
    if (t.isNullLiteral(node) || t.isBooleanLiteral(node) || t.isIdentifier(node, { name: "undefined" })) return ""
    if (t.isTemplateLiteral(node) && node.expressions.length === 0) return node.quasis[0].value.cooked
    return null
}

function containsMarkup(node) {
    if (isMarkup(node)) return true
    if (t.isConditionalExpression(node)) return containsMarkup(node.consequent) || containsMarkup(node.alternate)
    if (t.isLogicalExpression(node)) return containsMarkup(node.right)
    return false
}

function returnedMarkup(fn) {
    if (isMarkup(fn.body)) return { get: () => fn.body, set: value => { fn.body = value } }
    if (!t.isBlockStatement(fn.body)) return null
    const returns = []
    const find = node => {
        if (!isNode(node) || (node !== fn.body && t.isFunction(node))) return
        if (t.isReturnStatement(node)) returns.push(node)
        for (const [key, value] of Object.entries(node)) {
            if (SKIP_KEYS.has(key)) continue
            if (Array.isArray(value)) value.forEach(find)
            else find(value)
        }
    }
    find(fn.body)
    const last = fn.body.body.at(-1)
    if (returns.length !== 1 || returns[0] !== last || !isMarkup(last.argument)) return null
    return { get: () => last.argument, set: value => { last.argument = value } }
}

function returnedComponent(fn) {
    const isComponent = node => t.isCallExpression(node) && t.isIdentifier(node.callee) && /^[A-Z]/.test(node.callee.name) &&
        !NOT_COMPONENTS.has(node.callee.name)
    if (isComponent(fn.body)) return { get: () => fn.body, set: value => { fn.body = value }, component: true }
    return null
}

function listOf(node) {
    if (!t.isCallExpression(node) || node.arguments.length !== 1) return null
    const callee = node.callee
    if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.property, { name: "map" })) return null
    const fn = node.arguments[0]
    if (!t.isArrowFunctionExpression(fn) && !t.isFunctionExpression(fn)) return null
    if (fn.params.length === 0 || fn.params.length > 2 || !fn.params.every(param => t.isIdentifier(param))) return null
    const row = returnedMarkup(fn) ?? returnedComponent(fn)
    return row ? { source: callee.object, fn, row } : null
}

const isComponentTag = node => node.type === "element" && /^[A-Z]/.test(node.tag.split(".").at(-1)) && !node.tag.includes("-")

const KEEPS_WHITESPACE = new Set(["pre", "textarea", "script", "style"])

function collapseText(text) {
    if (!/[\r\n]/.test(text)) return text
    const lines = text.split(/\r\n|\n|\r/)
    let out = ""
    lines.forEach((line, index) => {
        let part = line
        if (index > 0) part = part.replace(/^[ \t]+/, "")
        if (index < lines.length - 1) part = part.replace(/[ \t]+$/, "")
        if (part) out += (out ? " " : "") + part
    })
    return out
}

function collapseWhitespace(nodes) {
    const out = []
    for (const node of nodes) {
        if (node.type === "text") {
            const value = collapseText(node.value)
            if (value) out.push({ ...node, value })
        } else if (node.type === "element") {
            out.push(KEEPS_WHITESPACE.has(node.tag.toLowerCase()) ? node : { ...node, children: collapseWhitespace(node.children) })
        } else {
            out.push(node)
        }
    }
    return out
}


class MarkupCompiler {
    constructor(program) {
        this.program = program
    }

    fail(node, message) {
        return this.program.fail(node, message)
    }

    nested(node, ctx) {
        if (!isNode(node)) return node
        if (node._slimComponent) return node
        if (isMarkup(node)) return this.markup(node, ctx)
        if (node._slimRoot) return this.markup(node._slimRoot, ctx, { root: true })
        for (const [key, value] of Object.entries(node)) {
            if (SKIP_KEYS.has(key)) continue
            if (Array.isArray(value)) node[key] = value.map(child => this.nested(child, ctx))
            else if (isNode(value)) node[key] = this.nested(value, ctx)
        }
        return node
    }

    markup(node, ctx, options = {}) {
        const tree = collapseWhitespace(parseMarkup(node._slimQuasis.map(cook), message => this.fail(node, message)))
        return this.fromTree(tree, node, node.quasi.expressions, ctx, options)
    }

    fromTree(tree, node, expressions, ctx, { root = false, onKey = null } = {}) {
        const roots = tree.filter(child => !(child.type === "text" && child.value.trim() === ""))

        if (roots.length === 1 && roots[0].type === "hole") {
            const expression = expressions[roots[0].index]
            const text = staticText(expression)
            if (text === null || root) {
                return call("__root__", [this.valueOf(expression, ctx)])
            }
        }

        const state = { markup: node, expressions, bindings: [], refs: new Map(), declarations: [], count: 0 }
        const svg = ctx.svg || (roots[0]?.type === "element" && SVG_ONLY.has(roots[0].tag))
        const rootCtx = { ...ctx, svg }

        if (onKey && roots.length === 1 && roots[0].type === "element") {
            const index = roots[0].attrs.findIndex(attr => attr.name === "key")
            if (index !== -1) {
                const [key] = roots[0].attrs.splice(index, 1)
                if (key.parts) {
                    const value = this.attributeValue(key, state, rootCtx)
                    rootCtx.rowKey = t.cloneNode(value, true)
                    onKey(value)
                }
            }
        }

        if (roots.length === 1 && isComponentTag(roots[0])) {
            return call("__root__", [thunk(this.component(roots[0], state, rootCtx))])
        }

        const template = roots.length === 1 && roots[0].type === "element"
            ? [this.element(roots[0], [], rootCtx, state)]
            : this.children(roots, [], rootCtx, state)
        const name = this.program.template(template, svg)
        if (state.bindings.length === 0) return call(name, [])

        const statements = [
            t.variableDeclaration("const", [t.variableDeclarator(id("__r__"), call(name, []))]),
            ...state.declarations,
            ...state.bindings.map(binding => t.expressionStatement(binding)),
            t.returnStatement(id("__r__"))
        ]
        return t.callExpression(thunk(t.blockStatement(statements)), [])
    }

    ref(path, state) {
        if (path.length === 0) return id("__r__")
        const key = path.join(".")
        const known = state.refs.get(key)
        if (known) return id(known)

        const parent = path.slice(0, -1)
        const index = path[path.length - 1]
        let expression = null
        for (let j = index - 1; j >= 0; j--) {
            const sibling = state.refs.get([...parent, j].join("."))
            if (!sibling) continue
            expression = call("__next__", [id(sibling), t.numericLiteral(index - j)])
            break
        }
        if (!expression) expression = call("__child__", [this.ref(parent, state), t.numericLiteral(index)])
        const name = `__n${++state.count}__`
        state.declarations.push(t.variableDeclaration("const", [t.variableDeclarator(id(name), expression)]))
        state.refs.set(key, name)
        return id(name)
    }

    children(nodes, path, ctx, state) {
        const out = []
        for (const node of nodes) {
            const here = [...path, out.length]
            if (node.type === "text") {
                out.push(node.value)
            } else if (node.type === "comment") {
                out.push(["#comment", node.value])
            } else if (node.type === "hole") {
                const expression = state.expressions[node.index]
                const text = staticText(expression)
                if (text !== null) {
                    if (text !== "") out.push(text)
                    continue
                }
                out.push("")
                state.bindings.push(this.childBinding(() => this.ref(here, state), expression, ctx))
            } else if (isComponentTag(node)) {
                out.push("")
                state.bindings.push(call("__insert__", [this.ref(here, state), thunk(this.component(node, state, ctx))]))
            } else {
                out.push(this.element(node, here, ctx, state))
            }
        }
        return out
    }

    element(node, path, ctx, state) {
        const attrs = {}
        let childScope = ctx.scope
        const svg = ctx.svg || node.tag === "svg"
        const el = () => this.ref(path, state)

        for (const attr of node.attrs) {
            if (attr.spread !== undefined) {
                state.bindings.push(call("__spread__", [el(), thunk(this.hole(state.expressions[attr.spread], ctx))]))
            } else if (attr.event !== undefined) {
                state.bindings.push(call("__on__", [el(), t.stringLiteral(attr.event), this.hole(state.expressions[attr.hole], ctx)]))
            } else if (attr.parts && attr.name.startsWith("bind:")) {
                state.bindings.push(...this.twoWay(node, attr, el, state, ctx))
            } else if (attr.parts) {
                if (attr.name === "key") continue
                if (attr.name === "class" && ctx.scope !== null) {
                    attr.parts = attr.parts.map(part => typeof part === "string" ? part.replaceAll("&", ctx.scope) : part)
                    if (typeof attr.parts[0] === "string" && attr.parts[0].trim()) childScope = attr.parts[0].trim().split(/\s+/)[0]
                }
                const value = this.attributeValue(attr, state, ctx)
                if (ctx.rowKey && t.isNodesEquivalent(value, ctx.rowKey)) {
                    state.bindings.push(call("__set__", [el(), t.stringLiteral(attr.name), value]))
                } else {
                    state.bindings.push(call("__attr__", [el(), t.stringLiteral(attr.name), thunk(value)]))
                }
            } else if (attr.name === "move" && (attr.value === true || typeof attr.value === "string")) {
                state.bindings.push(call_("__move__", [el(), attr.value === true ? t.numericLiteral(200) : t.stringLiteral(attr.value)]))
            } else if ((attr.name === "enter" || attr.name === "leave") && typeof attr.value === "string") {
                state.bindings.push(call_(`__${attr.name}__`, [el(), t.stringLiteral(attr.value)]))
            } else {
                if (attr.name === "key") continue
                let value = attr.value
                if (attr.name === "class" && ctx.scope !== null && typeof value === "string") {
                    value = value.replaceAll("&", ctx.scope)
                    childScope = value.trim().split(/\s+/)[0] || ctx.scope
                }
                attrs[attr.name] = value
            }
        }

        const childCtx = { ...ctx, scope: childScope, svg: svg && node.tag !== "foreignObject" }
        const children = this.children(node.children, path, childCtx, state)
        return [node.tag, Object.keys(attrs).length ? attrs : 0, ...children]
    }

    twoWay(node, attr, el, state, ctx) {
        const property = attr.name.slice("bind:".length)
        const [part] = attr.parts
        const markup = state.markup
        if (attr.parts.length !== 1 || typeof part === "string") {
            this.fail(markup, `${attr.name} takes a value to keep in sync: ${attr.name}=\${name}`)
        }
        if (property !== "value" && property !== "checked") {
            this.fail(markup, `"${attr.name}" is not supported: use bind:value or bind:checked`)
        }
        const target = this.nested(state.expressions[part.hole], ctx)
        if (!t.isIdentifier(target) && !t.isMemberExpression(target)) {
            this.fail(target, `${attr.name} needs something it can assign to, like a state or a field: ${attr.name}=\${name}`)
        }

        const type = node.attrs.find(other => other.name === "type" && typeof other.value === "string")?.value.toLowerCase()
        const tag = node.tag.toLowerCase()
        const event = property === "checked" || tag === "select" || type === "checkbox" || type === "radio" ? "change" : "input"
        const read = t.memberExpression(t.memberExpression(id("__e__"), id("target")),
            id(property === "checked" ? "checked" : type === "number" || type === "range" ? "valueAsNumber" : "value"))
        const write = t.arrowFunctionExpression([id("__e__")], t.assignmentExpression("=", t.cloneNode(target, true), read))
        return [
            call("__attr__", [el(), t.stringLiteral(property), thunk(target)]),
            call("__on__", [el(), t.stringLiteral(event), write])
        ]
    }

    attributeValue(attr, state, ctx) {
        const parts = attr.parts.map(part => typeof part === "string" ? part : this.hole(state.expressions[part.hole], ctx))
        if (!attr.quoted && parts.length === 1) return parts[0]
        let value = null
        for (const part of parts) {
            const piece = typeof part === "string" ? t.stringLiteral(part) : call("__s__", [part])
            value = value ? t.binaryExpression("+", value, piece) : piece
        }
        return typeof parts[0] === "string" ? value : t.binaryExpression("+", t.stringLiteral(""), value)
    }

    hole(expression, ctx) {
        return this.nested(expression, ctx)
    }

    childBinding(anchor, expression, ctx) {
        const list = listOf(expression)
        if (list) {
            list.fn._slimListRow = true
            let key = null
            if (!list.row.component) list.row.set(this.markup(list.row.get(), ctx, { onKey: value => { key = value } }))
            list.fn.body = this.nested(list.fn.body, ctx)
            for (const param of list.fn.params) param._slimReactive = "signal"
            const args = [anchor(), thunk(this.nested(list.source, ctx)), list.fn]
            const withIndex = list.fn.params.length > 1
            if (key || withIndex) args.push(key ? t.arrowFunctionExpression(list.fn.params.map(param => id(param.name)), key) : t.nullLiteral())
            if (withIndex) args.push(t.booleanLiteral(true))
            return call("__list__", args)
        }

        if (ctx.rowKey && t.isNodesEquivalent(expression, ctx.rowKey)) return call("__once__", [anchor(), this.nested(expression, ctx)])
        return call("__insert__", [anchor(), this.valueOf(expression, ctx)])
    }

    component(node, state, ctx) {
        const properties = []
        const prop = (name, value) => t.objectProperty(t.isValidIdentifier(name) ? id(name) : t.stringLiteral(name), value)
        for (const attr of node.attrs) {
            if (attr.spread !== undefined) {
                properties.push(t.spreadElement(this.hole(state.expressions[attr.spread], ctx)))
            } else if (attr.event !== undefined) {
                properties.push(prop(attr.name, this.hole(state.expressions[attr.hole], ctx)))
            } else if (attr.name === "key") {
                continue
            } else if (attr.name.startsWith("bind:")) {
                this.fail(state.markup, `${attr.name} works on inputs, not on the component <${node.tag}>: pass the value and a callback as props`)
            } else if (attr.parts) {
                properties.push(prop(attr.name, this.attributeValue(attr, state, ctx)))
            } else {
                properties.push(prop(attr.name, attr.value === true ? t.booleanLiteral(true) : t.stringLiteral(attr.value)))
            }
        }
        if (node.children.some(child => !(child.type === "text" && child.value.trim() === ""))) {
            properties.push(prop("children", this.fromTree(node.children, state.markup, state.expressions, ctx)))
        }
        const callee = node.tag.split(".").map(id).reduce((object, property) => t.memberExpression(object, property))
        return t.callExpression(callee, [t.objectExpression(properties)])
    }

    valueOf(expression, ctx) {
        if (t.isConditionalExpression(expression) && containsMarkup(expression)) {
            return call("__branch__", [
                thunk(this.nested(expression.test, ctx)),
                thunk(this.nested(expression.consequent, ctx)),
                thunk(this.nested(expression.alternate, ctx))
            ])
        }
        if (t.isLogicalExpression(expression, { operator: "&&" }) && containsMarkup(expression)) {
            return call("__branch__", [thunk(this.nested(expression.left, ctx)), thunk(this.nested(expression.right, ctx)), t.nullLiteral()])
        }
        return thunk(this.nested(expression, ctx))
    }
}


let importedReactive = new Map()

function reactiveKind(path) {
    const binding = path.scope.getBinding(path.node.name)
    if (!binding) return importedReactive.get(path.node.name) ?? null
    const node = binding.identifier
    if (node._slimReactive) return node._slimReactive
    if (node._slimProps) return "props"
    if (node._slimPropAlias !== undefined) return "alias"
    return null
}

function readsReactive(path) {
    if (path.isIdentifier()) return reactiveKind(path) !== null
    if (path.isFunction()) return false
    let found = false
    path.traverse({
        Function(inner) { inner.skip() },
        Identifier(inner) {
            if (!inner.isReferencedIdentifier()) return
            if (reactiveKind(inner) !== null) {
                found = true
                inner.stop()
            }
        }
    })
    return found
}

function keyName(key) {
    if (t.isIdentifier(key)) return key.name
    if (t.isStringLiteral(key)) return key.value
    return null
}

function innerPath(path) {
    const body = path.get("body")
    if (!body.isBlockStatement()) return body.get("arguments.0")
    const statement = body.get("body").find(item => item.isReturnStatement() && t.isCallExpression(item.node.argument))
    return statement.get("argument.arguments.0")
}

function prepareDeclarations(statements) {
    const declarationOf = statement => statement.isExportNamedDeclaration() ? statement.get("declaration") : statement

    for (const statement of statements) {
        const declaration = declarationOf(statement)
        if (!declaration.node?.slimState) continue
        const [declarator] = declaration.node.declarations
        declarator.id._slimReactive = "signal"
        declarator.init = call("__signal__", [declarator.init])
    }

    for (const statement of statements) {
        const declaration = declarationOf(statement)
        if (!declaration.isVariableDeclaration({ kind: "const" }) || declaration.node.slimState) continue
        for (const declarator of declaration.get("declarations")) {
            const { id: name, init } = declarator.node
            if (!t.isIdentifier(name) || name.name.startsWith("__") || !init) continue
            const injected = t.isCallExpression(init) && t.isIdentifier(init.callee, { name: "inject" })
            if (!injected && !readsReactive(declarator.get("init"))) continue
            name._slimReactive = "computed"
            declarator.node.init = call("__computed__", [thunk(init)])
        }
    }
}

function prepare(path, compiler) {
    const outer = path.node
    const inner = innerPath(path)

    const param = outer.params[0]
    const target = t.isAssignmentPattern(param) ? param.left : param
    if (t.isIdentifier(target)) target._slimProps = true
    if (t.isObjectPattern(target)) {
        for (const property of target.properties) {
            const value = t.isAssignmentPattern(property.value) ? property.value.left : property.value
            value._slimPropAlias = keyName(property.key)
        }
    }

    prepareDeclarations(inner.get("body.body"))

    const ctx = { scope: outer._slimComponent.bem, svg: false }
    inner.node.body = compiler.nested(inner.node.body, ctx)
}

function passGetters(path) {
    path.traverse({
        CallExpression(call) {
            const callee = call.node.callee
            if (t.isIdentifier(callee, { name: "provide" }) && call.node.arguments.length === 2) {
                const value = call.get("arguments.1")
                if (!value.isFunction() && readsReactive(value)) value.replaceWith(call_("__live__", [thunk(value.node)]))
                return
            }
            if (!t.isIdentifier(callee) || !/^[A-Z]/.test(callee.name) || NOT_COMPONENTS.has(callee.name)) return
            const argument = call.get("arguments.0")
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

function rewrite(path, fail) {
    const leaves = []
    const mutations = []
    const selections = []

    checkAliases(path, fail)

    path.traverse({
        Identifier(ref) {
            const node = ref.node
            if (node._slimDone) return
            const binding = ref.scope.getBinding(node.name)
            if (binding?.identifier === node) return
            const kind = reactiveKind(ref)
            if (kind === null || kind === "props") return

            const parent = ref.parentPath
            if (parent.isExportSpecifier()) return
            const write = (parent.isAssignmentExpression() && parent.node.left === node) || parent.isUpdateExpression()
            if (!write && !ref.isReferencedIdentifier()) return

            if (kind === "alias") {
                if (write) fail(node, `"${node.name}" is a prop and can't be assigned: copy it into a state or a let first`)
                leaves.push([ref, t.memberExpression(done("__props__"), id(binding.identifier._slimPropAlias))])
                return
            }

            if (kind === "signal" && parent.isBinaryExpression() && COMPARISONS.has(parent.node.operator) &&
                !referencesAny(parent.node[ref.key === "left" ? "right" : "left"], new Set([node.name])) &&
                ref.findParent(ancestor => ancestor.node._slimListRow)) {
                selections.push([parent, ref.key === "left" ? "right" : "left", node.name])
                return
            }

            leaves.push([ref, t.memberExpression(done(node.name), id("v"))])
            if (write) return

            let top = ref
            let depth = 0
            while ((top.parentPath.isMemberExpression() || top.parentPath.isOptionalMemberExpression()) &&
                top.parentPath.node.object === top.node) {
                top = top.parentPath
                depth++
            }
            if (top === ref) return
            const outer = top.parentPath
            const changes = (outer.isAssignmentExpression() && outer.node.left === top.node) ||
                (outer.isUpdateExpression()) ||
                (outer.isUnaryExpression({ operator: "delete" })) ||
                ((outer.isCallExpression() || outer.isOptionalCallExpression()) && outer.node.callee === top.node && !readsOnly(top.node))
            if (changes && kind === "computed") {
                fail(node, `"${node.name}" is recomputed from a state or props, a change to it is lost on the next update — change what it comes from, or declare it with state`)
            }
            if (changes) mutations.push([outer, node.name, depth >= 2 ? ref.parentPath : null])
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
    for (const [target, name, item] of mutations) {
        if (!item) {
            target.replaceWith(call("__mut__", [done(name), target.node]))
            continue
        }
        const object = item.node
        item.replaceWith(id("__o__"))
        target.replaceWith(call("__mut_deep__", [done(name), t.arrowFunctionExpression([id("__o__")], target.node), object]))
    }
}

function propsParameter(path) {
    const outer = path.node
    const param = outer.params[0]
    const target = t.isAssignmentPattern(param) ? param.left : param
    if (!t.isObjectPattern(target)) return

    const defaults = target.properties
        .filter(property => t.isAssignmentPattern(property.value))
        .map(property => t.objectProperty(t.stringLiteral(keyName(property.key)), thunk(property.value.right)))
    outer.params[0] = t.assignmentPattern(id("__props__"), t.objectExpression([]))
    if (defaults.length === 0) return

    const inner = innerPath(path).node
    inner.body.body.unshift(t.expressionStatement(t.assignmentExpression("=", id("__props__"),
        call("__defaults__", [id("__props__"), t.objectExpression(defaults)]))))
}


const exportsCache = new Map()

function referencesAny(node, names) {
    if (!isNode(node) || t.isFunction(node)) return false
    if (t.isIdentifier(node) && names.has(node.name)) return true
    for (const [key, value] of Object.entries(node)) {
        if (SKIP_KEYS.has(key)) continue
        if (Array.isArray(value) ? value.some(child => referencesAny(child, names)) : referencesAny(value, names)) return true
    }
    return false
}

export function reactiveExports(file) {
    let stat
    try {
        stat = fs.statSync(file)
    } catch {
        return new Map()
    }
    const cached = exportsCache.get(file)
    if (cached && cached.mtime === stat.mtimeMs) return cached.exports

    const exports = new Map()
    let program
    try {
        program = parseSlim(fs.readFileSync(file, "utf8"), file).program
    } catch {
        exportsCache.set(file, { mtime: stat.mtimeMs, exports })
        return exports
    }

    const local = new Map()
    for (const statement of program.body) {
        const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
        if (declaration?.type !== "VariableDeclaration") continue
        for (const declarator of declaration.declarations) {
            if (declarator.id.type !== "Identifier") continue
            const name = declarator.id.name
            if (declaration.slimState) local.set(name, "signal")
            else if (declaration.kind === "const" && referencesAny(declarator.init, local)) local.set(name, "computed")
            else continue
            if (statement.type === "ExportNamedDeclaration") exports.set(name, local.get(name))
        }
    }
    for (const statement of program.body) {
        if (statement.type !== "ExportNamedDeclaration" || statement.declaration || statement.source) continue
        for (const specifier of statement.specifiers) {
            const exported = specifier.exported.name ?? specifier.exported.value
            if (local.has(specifier.local.name)) exports.set(exported, local.get(specifier.local.name))
        }
    }

    exportsCache.set(file, { mtime: stat.mtimeMs, exports })
    return exports
}

export function compileReactivity(ast, code, { importedReactive: imported = new Map() } = {}) {
    const fail = (node, message) => { throw slimSyntaxError(code, node.start ?? 0, message) }
    const templates = []
    const program = {
        fail,
        template(roots, svg) {
            const name = `__tpl${templates.length + 1}__`
            const args = [t.valueToNode(roots)]
            if (svg) args.push(t.booleanLiteral(true))
            const declaration = t.variableDeclaration("const", [t.variableDeclarator(id(name), call("__template__", args))])
            declaration._slimTypeSlots = true
            templates.push(declaration)
            return name
        }
    }
    const compiler = new MarkupCompiler(program)
    importedReactive = imported

    const pass = visit => {
        traverse.cache.clear()
        traverse(ast, { Program: visit })
    }
    const components = programPath => {
        const found = []
        programPath.traverse({
            Function(path) {
                if (!path.node._slimComponent) return
                found.push(path)
                path.skip()
            }
        })
        return found
    }

    const moduleStates = ast.program.body.some(statement => (statement.declaration ?? statement).slimState)
    let found = moduleStates || importedReactive.size > 0
    pass(programPath => {
        if (moduleStates) prepareDeclarations(programPath.get("body"))
        for (const path of components(programPath)) {
            found = true
            prepare(path, compiler)
        }
    })
    if (!found) return

    pass(passGetters)
    pass(programPath => {
        rewrite(programPath, fail)
        for (const path of components(programPath)) {
            propsParameter(path)
            for (const statement of innerPath(path).node.body.body) {
                if (statement.slimState) statement.kind = "const"
            }
        }
        for (const statement of ast.program.body) {
            const declaration = statement.declaration ?? statement
            if (declaration.slimState) declaration.kind = "const"
        }
    })
    traverse.cache.clear()
    importedReactive = new Map()

    ast.program.body.unshift(...templates)
}
