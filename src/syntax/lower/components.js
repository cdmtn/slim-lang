import * as t from "@babel/types"
import _generate from "@babel/generator"
import { babel } from "../plugin.js"
import { readConfig } from "../../modulePaths.js"
import { call, forgetLoc, id, isNode, str } from "./helpers.js"

const generate = _generate.default ?? _generate

let bemCache = null
function useBEMClasses() {
    if (bemCache !== null) return bemCache
    bemCache = readConfig().components?.useBEMClasses === true
    return bemCache
}

function kebabCase(name) {
    return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[_\s]+/g, "-").toLowerCase()
}

function elementTag(node, lowering) {
    if (!node.tag) return `slim-${kebabCase(node.id.name)}`
    if (!node.tag.includes("-")) {
        lowering.fail(node, `Component "${node.id.name}": a custom element tag must contain a hyphen, got "${node.tag}"`)
    }
    return node.tag
}

function parseTemplate(code) {
    const program = babel.parse(code, { sourceType: "module", allowReturnOutsideFunction: true }).program
    forgetLoc(program)
    return program.body
}

function fill(node, slots) {
    if (Array.isArray(node)) {
        return node.flatMap(child => {
            if (t.isExpressionStatement(child) && t.isIdentifier(child.expression) && child.expression.name in slots) {
                return slots[child.expression.name]
            }
            return [fill(child, slots)]
        })
    }
    if (!isNode(node)) return node
    if (t.isIdentifier(node) && node.name in slots) return slots[node.name]
    for (const [key, value] of Object.entries(node)) {
        if (Array.isArray(value) || isNode(value)) node[key] = fill(value, slots)
    }
    return node
}

const HOOKS = `const __mounts__ = [];
    const __connects__ = [];
    const __unmounts__ = [];
    let __exposed__ = 0;
    let __target__ = null;
    let __life__ = null;
    let __kept__ = false;
    const expose = api => __target__ ? Object.defineProperties(__target__, Object.getOwnPropertyDescriptors(api)) : __mounts__.splice(__exposed__++, 0, el => Object.defineProperties(el, Object.getOwnPropertyDescriptors(api)));
    const onMount = fn => __target__ ? fn(__target__) : __mounts__.push(fn);
    const onConnect = fn => __life__ ? __life__.connect(fn) : __connects__.push(fn);
    const onUnmount = fn => __life__ ? __life__.unmount(fn) : __unmounts__.push(fn);
    const keepAlive = () => __life__ ? __life__.keep() : (__kept__ = true);`

const MOUNT = target => `__upgrade__(${target});
    __target__ = ${target};
    for (const fn of __mounts__.splice(0)) fn(${target});`

function usesFreely(nodes, name) {
    let used = false
    let declared = false
    const visit = (node, parent, key) => {
        if (!isNode(node)) return
        if (t.isIdentifier(node) && node.name === name) {
            const member = (t.isMemberExpression(parent) || t.isOptionalMemberExpression(parent)) && key === "property" && !parent.computed
            const propertyKey = (t.isObjectProperty(parent) || t.isObjectMethod(parent) || t.isClassMethod(parent) || t.isClassProperty(parent)) && key === "key" && !parent.computed
            const declares = (t.isVariableDeclarator(parent) && key === "id") || (t.isFunction(parent) && (key === "id" || key === "params"))
            if (declares) declared = true
            else if (!member && !propertyKey) used = true
        }
        for (const [childKey, value] of Object.entries(node)) {
            if (Array.isArray(value)) for (const item of value) visit(item, node, childKey)
            else if (isNode(value)) visit(value, node, childKey)
        }
    }
    for (const node of nodes) visit(node, null, null)
    return used && !declared
}

function ownListener(statements, params) {
    if (params.items.some(item => item.name?.name === "listen")) return []
    return usesFreely(statements, "listen") ? parseTemplate("const listen = __listener__(() => __life__);") : []
}

function componentBinding(params) {
    if (params.items.length === 0) return null
    if (!params.pattern) return id(params.items[0].name.name)

    return t.objectPattern(params.items.map(item => {
        const value = item.value ? t.assignmentPattern(id(item.name.name), item.value) : id(item.name.name)
        return t.objectProperty(id(item.name.name), value, false, true)
    }))
}

export function componentProps(node, lowering) {
    const { items, pattern } = node.params
    if (!pattern) {
        const [item] = items
        return item?.typeAnnotation ? { type: lowering.label(item.typeAnnotation) } : null
    }
    return {
        fields: items.map(item => ({
            name: item.name.name,
            type: item.typeAnnotation ? lowering.label(item.typeAnnotation) : null,
            optional: !!item.optional || !!item.value || !item.typeAnnotation
        }))
    }
}

function componentChecks(node, lowering) {
    return node.params.items.flatMap((item, index) => {
        if (!item.typeAnnotation) return []
        const label = lowering.label(item.typeAnnotation)
        if (label === "any") return []
        return [lowering.typedParameter(item.name.name, label, item.optional, index, node.id.name)]
    })
}

function elementExpression(markup, name) {
    const vdom = call("htmlToVdom", [markup])
    if (!useBEMClasses()) return t.callExpression(t.memberExpression(vdom, id("toElement")), [])

    const [statement] = parseTemplate(`(() => {
        const __v__ = __SLIM_VDOM__;
        __resolve_bem__(__v__, ${JSON.stringify(kebabCase(name))});
        return __v__.toElement();
    })()`)
    return fill(statement, { __SLIM_VDOM__: vdom }).expression
}

function componentFunction(node) {
    if (!isNode(node)) return null
    if (t.isArrowFunctionExpression(node) && t.isCallExpression(node.body) && t.isIdentifier(node.body.callee, { name: "__component__" })) {
        return node
    }
    for (const value of Object.values(node)) {
        const found = Array.isArray(value) ? value.map(componentFunction).find(Boolean) : componentFunction(value)
        if (found) return found
    }
    return null
}

function rootTag(markup) {
    const first = markup._slimQuasis?.[0] ?? markup.quasi?.quasis?.[0]?.value?.raw ?? ""
    return first.trimStart().match(/^<([A-Za-z][\w-]*)/)?.[1] ?? null
}

export function buildComponent(node, lowering) {
    const name = node.id.name
    const origin = lowering.script ? "" : `${name}.__module__ = import.meta.url;`
    const statements = node.body.body
    const returnIndex = statements.findIndex(statement => t.isReturnStatement(statement))
    if (returnIndex === -1 || !statements[returnIndex].argument) lowering.fail(node, `Component "${name}" must contain return`)
    const after = statements.slice(returnIndex + 1).find(statement => !t.isFunctionDeclaration(statement))
    if (after) lowering.fail(after, `Component "${name}": code after return never runs — move it above the return`)

    for (const statement of statements) {
        if (!statement.slimState) continue
        if (node.modifier === "isolated") lowering.fail(statement, "An isolated component can't have state")
        statement._slimStateOk = true
    }

    const before = [...statements.slice(0, returnIndex), ...statements.slice(returnIndex + 1)]
    const returned = statements[returnIndex].argument
    const markup = returned._slimMarkup
        ? returned
        : t.taggedTemplateExpression(id("__html__"), t.templateLiteral(
            [t.templateElement({ raw: "", cooked: "" }), t.templateElement({ raw: "", cooked: "" }, true)],
            [returned]
        ))
    if (!returned._slimMarkup) {
        markup._slimMarkup = true
        markup._slimQuasis = ["", ""]
    }
    const hosted = rootTag(markup) === "host"
    if (hosted && node.modifier !== "element") lowering.fail(returned, `<host> stands for the element of an element component: "${name}" is not one, so it has no element to put attributes on`)
    const element = elementExpression(markup, name)
    element._slimRoot = markup
    const checks = componentChecks(node, lowering)
    const binding = componentBinding(node.params)
    const fallback = !node.params.pattern && node.params.items[0]?.value
    const withFallback = param => {
        if (fallback && param?.type === "AssignmentPattern") param.right = t.cloneNode(fallback, true)
    }
    const info = { name, bem: useBEMClasses() ? kebabCase(name) : null }

    if (node.modifier === "isolated") {
        const tail = fill(parseTemplate(`const __el__ = __SLIM_ELEMENT__;
            ${MOUNT("__el__")}
            __life__ = __lifecycle__(__el__, __connects__, __unmounts__);
            if (__kept__) __life__.keep();
            return __el__;`), { __SLIM_ELEMENT__: element })
        const bindingCode = binding ? generate(binding).code : ""
        const inner = t.functionExpression(null, binding ? [binding] : [], t.blockStatement([...checks, ...parseTemplate(HOOKS), ...before, ...tail]))

        const [statement] = parseTemplate(`(() => {
            const ${name} = (__props__ = {}) => {
                return new Function(${JSON.stringify(bindingCode)}, __SLIM_BODY__)(__props__);
            };
            ${name}.__component__ = true;
            ${origin}
            return ${name};
        })()`)
        const expression = fill(statement, { __SLIM_BODY__: call("__isolated_body__", [inner, str(name)]) }).expression
        withFallback(expression.callee.body.body[0].declarations[0].init.params[0])
        return expression
    }

    const body = [...ownListener(before, node.params), ...checks, ...before]

    if (node.modifier === "element") {
        const tag = JSON.stringify(elementTag(node, lowering))
        const build = hosted ? `__with_host__(__host__ ?? __create_host__(${tag}), () => __SLIM_ELEMENT__)` : "__SLIM_ELEMENT__"
        const [statement] = parseTemplate(`(() => {
            const ${name} = (__props__ = {}) => __element_host__(${tag}, __props__) ?? ${name}.__render__(__props__);
            ${name}.__component__ = true;
            ${origin}
            ${name}.tag = ${tag};
            ${name}.__render__ = (__SLIM_PARAM__ = {}, __host__ = null) => __component__(() => {
                ${HOOKS}
                __SLIM_BODY__;
                const __el__ = ${build};
                if (!__host__) {
                    ${MOUNT("__el__")}
                    __life__ = __lifecycle__(__el__, __connects__, __unmounts__);
                    if (__kept__) __life__.keep();
                    return __el__;
                }
                __adopt_into__(__host__, __el__);
                ${MOUNT("__host__")}
                __life__ = __element_life__(__host__, __connects__, __unmounts__);
                if (__kept__) __life__.keep();
                return __life__;
            });
            __define_element__(${tag}, ${name}.__render__);
            return ${name};
        })()`)
        const expression = fill(statement, {
            __SLIM_PARAM__: binding ?? id("__unused__"),
            __SLIM_BODY__: body,
            __SLIM_ELEMENT__: element
        }).expression
        const render = componentFunction(expression)
        render._slimComponent = info
        withFallback(render.params[0])
        withFallback(expression.callee.body.body[0].declarations[0].init.params[0])
        return expression
    }

    const [statement] = parseTemplate(`(() => {
        const ${name} = (__SLIM_PARAM__ = {}) => __component__(() => {
            ${HOOKS}
            __SLIM_BODY__;
            const __el__ = __SLIM_ELEMENT__;
            ${MOUNT("__el__")}
            __life__ = __lifecycle__(__el__, __connects__, __unmounts__);
            if (__kept__) __life__.keep();
            return __el__;
        });
        ${name}.__component__ = true;
        ${origin}
        return ${name};
    })()`)

    const expression = fill(statement, { __SLIM_BODY__: body, __SLIM_ELEMENT__: element }).expression
    const inner = expression.callee.body.body[0].declarations[0].init
    if (binding) inner.params[0].left = binding
    else inner.params = []
    withFallback(inner.params[0])
    inner._slimComponent = info
    return expression
}
