import * as t from "@babel/types"
import { parseMarkup } from "../syntax/markup.js"
import { NOT_COMPONENTS, SKIP_KEYS, call, call_, id, isMarkup, isNode, thunk } from "./ast.js"
import { hoistFields, takeKeep } from "./fields.js"

const SVG_ONLY = new Set([
    "g", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "tspan", "defs", "use",
    "symbol", "clipPath", "mask", "pattern", "linearGradient", "radialGradient", "stop", "filter", "marker", "text"
])

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

function namesIn(node, names = new Set()) {
    if (!isNode(node)) return names
    if (t.isIdentifier(node)) names.add(node.name)
    for (const [key, value] of Object.entries(node)) {
        if (SKIP_KEYS.has(key)) continue
        if (Array.isArray(value)) value.forEach(child => namesIn(child, names))
        else namesIn(value, names)
    }
    return names
}

function rowKey(fn, key) {
    if (!t.isBlockStatement(fn.body)) return key
    const needed = namesIn(key)
    const setup = []
    for (const statement of [...fn.body.body].reverse()) {
        if (!t.isVariableDeclaration(statement)) continue
        const declared = Object.keys(t.getBindingIdentifiers(statement))
        if (!declared.some(name => needed.has(name))) continue
        setup.unshift(t.cloneNode(statement, true))
        namesIn(statement, needed)
    }
    return setup.length ? t.blockStatement([...setup, t.returnStatement(key)]) : key
}

const isComponentTag = node => node.type === "element" && (node.dynamic !== undefined || (/^[A-Z]/.test(node.tag.split(".").at(-1)) && !node.tag.includes("-")))

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

export class MarkupCompiler {
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
        const tree = collapseWhitespace(parseMarkup(node._slimQuasis, message => this.fail(node, message)))
        return this.fromTree(tree, node, node.quasi.expressions, ctx, options)
    }

    fromTree(tree, node, expressions, ctx, { root = false, onKey = null, onKeep = null } = {}) {
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
            const keep = takeKeep(roots[0], attr => this.attributeValue(attr, state, rootCtx))
            if (keep) onKeep?.(keep)
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
                state.bindings.push(this.childBinding(() => this.ref(here, state), expression, ctx, state))
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
                const args = [el(), t.stringLiteral(attr.event), this.hole(state.expressions[attr.hole], ctx)]
                if (attr.modifiers?.length) args.push(t.objectExpression(attr.modifiers.map(modifier => t.objectProperty(id(modifier), t.booleanLiteral(true)))))
                state.bindings.push(call("__on__", args))
            } else if (attr.parts && attr.name.startsWith("bind:")) {
                state.bindings.push(...this.twoWay(node, attr, el, state, ctx))
            } else if (attr.parts && attr.name === "ref") {
                state.bindings.push(this.elementRef(attr, el, state, ctx))
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
                    state.bindings.push(call("__attr__", [el(), t.stringLiteral(attr.name), thunk(hoistFields(value, ctx, state))]))
                }
            } else if (attr.name === "move" && (attr.value === true || typeof attr.value === "string")) {
                state.bindings.push(call_("__move__", [el(), attr.value === true ? t.numericLiteral(200) : t.stringLiteral(attr.value)]))
            } else if ((attr.name === "enter" || attr.name === "leave") && typeof attr.value === "string") {
                state.bindings.push(call_(`__${attr.name}__`, [el(), t.stringLiteral(attr.value)]))
            } else {
                if (attr.name === "key") continue
                if (attr.name === "ref") this.fail(state.markup, "ref takes a variable or a function: ref=${name}")
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

    elementRef(attr, el, state, ctx) {
        const [part] = attr.parts
        if (attr.parts.length !== 1 || typeof part === "string") {
            this.fail(state.markup, "ref takes a variable or a function: ref=${name}")
        }
        const target = this.nested(state.expressions[part.hole], ctx)
        const receiver = t.isIdentifier(target) || t.isMemberExpression(target)
            ? t.arrowFunctionExpression([id("__node__")], t.assignmentExpression("=", t.cloneNode(target, true), id("__node__")))
            : target
        return call("__ref__", [el(), receiver])
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

    childBinding(anchor, expression, ctx, state) {
        const list = listOf(expression)
        if (list) {
            list.fn._slimListRow = true
            let key = null
            let keep = null
            const rowCtx = { ...ctx, rowItems: [...(ctx.rowItems ?? []), list.fn.params[0].name] }
            if (!list.row.component) list.row.set(this.markup(list.row.get(), rowCtx, { onKey: value => { key = rowKey(list.fn, value) }, onKeep: value => { keep = value } }))
            list.fn.body = this.nested(list.fn.body, rowCtx)
            for (const param of list.fn.params) param._slimReactive = "signal"
            const args = [anchor(), thunk(this.nested(list.source, ctx)), list.fn]
            const withIndex = list.fn.params.length > 1
            if (key || withIndex) args.push(key ? t.arrowFunctionExpression(list.fn.params.map(param => id(param.name)), key) : t.nullLiteral())
            if (withIndex) args.push(t.booleanLiteral(true))
            if (keep) args.push(...(args.length === 3 ? [t.nullLiteral(), t.booleanLiteral(false)] : args.length === 4 ? [t.booleanLiteral(false)] : []), keep)
            return call("__list__", args)
        }

        if (ctx.rowKey && t.isNodesEquivalent(expression, ctx.rowKey)) return call("__once__", [anchor(), this.nested(expression, ctx)])
        return call("__insert__", [anchor(), this.valueOf(state ? hoistFields(expression, ctx, state) : expression, ctx)])
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
        const props = t.objectExpression(properties)
        const hasChildren = node.children.some(child => !(child.type === "text" && child.value.trim() === ""))
        const callee = node.dynamic !== undefined
            ? call("__dynamic__", [this.hole(state.expressions[node.dynamic], ctx)])
            : node.tag.split(".").map(id).reduce((object, property) => t.memberExpression(object, property))
        if (!hasChildren) return t.callExpression(callee, [props])
        const children = thunk(this.fromTree(node.children, state.markup, state.expressions, ctx))
        return t.callExpression(callee, [call("__lazy_children__", [props, children])])
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
