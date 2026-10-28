import * as t from "@babel/types"
import _generate from "@babel/generator"
import { babel, slimSyntaxError } from "./plugin.js"
import { readConfig } from "../modulePaths.js"
import { typeFromAST } from "./types.js"
import { ANY, formatType, readType, substituteType } from "../external/typeSyntax.js"

const generate = _generate.default ?? _generate

const SKIP_KEYS = new Set([
    "loc", "start", "end", "extra", "range", "leadingComments", "trailingComments", "innerComments",
    "typeAnnotation", "returnType", "typeParameters", "typeArguments", "superTypeParameters"
])

const PREFIX_CALLS = {
    sizeof: "__sizeof__",
    kindof: "type",
    empty: "__is_empty__",
    copyof: "__copyof__",
    lock: "__lock_object__"
}

const NOT_STRUCTS = new Set(["any", "object"])

function returnsOf(node, found = []) {
    if (!isNode(node) || /Function|ClassMethod|ObjectMethod/.test(node.type)) return found
    if (node.type === "ReturnStatement" && node.argument) found.push(node)
    for (const [key, value] of Object.entries(node)) {
        if (SKIP_KEYS.has(key)) continue
        if (Array.isArray(value)) value.forEach(child => returnsOf(child, found))
        else if (isNode(value)) returnsOf(value, found)
    }
    return found
}

function typeParamNames(node) {
    const params = Array.isArray(node.typeParameters) ? node.typeParameters : node.typeParameters?.params ?? []
    return params.map(param => typeof param.name === "string" ? param.name : param.name?.name).filter(Boolean)
}

const isNode = value => !!value && typeof value === "object" && typeof value.type === "string"

function withLoc(node, from) {
    if (from && typeof from.start === "number") {
        node.start = from.start
        node.end = from.end
        node.loc = from.loc
    }
    return node
}

function forgetLoc(node) {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) return node.forEach(forgetLoc)
    delete node.start
    delete node.end
    delete node.loc
    for (const [key, value] of Object.entries(node)) {
        if (key !== "extra" && value && typeof value === "object") forgetLoc(value)
    }
}

const id = name => t.identifier(name)
const str = value => t.stringLiteral(value)
const call = (name, args) => t.callExpression(id(name), args)

function escapeTemplateText(text) {
    return text.replace(/\\|`|\$\{/g, match => "\\" + match)
}

function escapeMarkupText(text) {
    return text.replace(/\\[\s\S]|`/g, match => match === "`" ? "\\`" : match)
}

function keyName(key) {
    if (!key) return null
    if (key.type === "Identifier") return key.name
    if (key.type === "StringLiteral") return key.value
    if (key.type === "PrivateName") return `#${key.id.name}`
    return null
}

class Lowering {
    constructor(code, sourceFile) {
        this.code = code
        this.sourceFile = sourceFile
        this.typeParams = []
        this.stateDeclarations = []
    }

    fail(node, message) {
        throw slimSyntaxError(this.code, node.start ?? 0, message)
    }

    type(annotation, { keepTypeParams = false } = {}) {
        const type = typeFromAST(annotation, (node, message) => this.fail(node, message))
        if (keepTypeParams || this.typeParams.length === 0) return type
        return substituteType(type, new Map(this.typeParams.map(name => [name, ANY])))
    }

    label(annotation, options) {
        return formatType(this.type(annotation, options))
    }

    visit(node, parent) {
        const typeParams = typeParamNames(node)
        this.typeParams.push(...typeParams)
        try {
            return this.visitChildren(node, parent)
        } finally {
            this.typeParams.length -= typeParams.length
        }
    }

    visitChildren(node, parent) {
        for (const key of Object.keys(node)) {
            if (SKIP_KEYS.has(key)) continue
            const value = node[key]
            if (Array.isArray(value)) {
                node[key] = value.flatMap(child => {
                    if (!isNode(child)) return [child]
                    const lowered = this.visit(child, node)
                    return lowered === null ? [] : [lowered]
                })
            } else if (isNode(value)) {
                node[key] = this.visit(value, node)
            }
        }

        const handler = this[node.type]
        return typeof handler === "function" ? handler.call(this, node, parent) : node
    }


    SlimUnaryExpression(node) {
        return withLoc(call(PREFIX_CALLS[node.operator], [node.argument]), node)
    }

    SlimBinaryExpression(node) {
        return withLoc(call("__intdiv__", [node.left, node.right]), node)
    }

    SlimMarkup(node) {
        const quasis = node.quasis.map((text, index) => {
            const raw = escapeMarkupText(text)
            return t.templateElement({ raw, cooked: raw }, index === node.quasis.length - 1)
        })
        const markup = t.taggedTemplateExpression(id("__html__"), t.templateLiteral(quasis, node.expressions))
        markup._slimMarkup = true
        markup._slimQuasis = node.quasis
        return withLoc(markup, node)
    }

    SlimMatchExpression(node) {
        const statements = []
        let fallback = t.returnStatement(id("undefined"))

        for (const arm of node.arms) {
            if (arm.typeAnnotation) {
                const label = this.label(arm.typeAnnotation)
                const declarator = t.variableDeclarator(withLoc(id(arm.binding.name), arm.binding), id("__match"))
                declarator._slimType = label
                const result = t.returnStatement(arm.result)
                const body = [t.variableDeclaration("const", [declarator]), arm.guard ? t.ifStatement(arm.guard, result) : result]
                statements.push(t.ifStatement(call("__match_type__", [id("__match"), str(label)]), t.blockStatement(body)))
            } else if (arm.guard) {
                const body = []
                if (arm.binding) body.push(t.variableDeclaration("const", [t.variableDeclarator(id(arm.binding.name), id("__match"))]))
                body.push(t.ifStatement(arm.guard, t.returnStatement(arm.result)))
                statements.push(t.blockStatement(body))
            } else if (arm.wildcard) {
                fallback = t.returnStatement(arm.result)
            } else {
                statements.push(t.ifStatement(call("__match_eq__", [id("__match"), arm.pattern]), t.returnStatement(arm.result)))
            }
        }

        const fn = t.arrowFunctionExpression([id("__match")], t.blockStatement([...statements, fallback]))
        return withLoc(t.callExpression(fn, [node.discriminant]), node)
    }


    functionName(node, parent) {
        if (node.id) return node.id.name
        const own = keyName(node.key)
        if (own) return own
        if (!parent) return "function"
        if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name
        if (parent.type === "ObjectProperty" || parent.type === "ClassProperty" || parent.type === "ClassPrivateProperty") {
            return keyName(parent.key) ?? "function"
        }
        if (parent.type === "AssignmentExpression" && parent.left.type === "Identifier") return parent.left.name
        return "function"
    }

    typedParameter(name, label, optional, index, fnName) {
        const type = readType(label)
        const expected = (type.kind === "union" ? type.types : [type]).map(formatType).join(" or ")
        const message = optional
            ? `${fnName}: argument "${name}" expected ${expected}`
            : `function "${fnName}": argument<${index}> "${name}" expected ${expected}`
        const text = escapeTemplateText(`${message}, got `)
        const template = t.templateLiteral(
            [t.templateElement({ raw: text, cooked: `${message}, got ` }), t.templateElement({ raw: "", cooked: "" }, true)],
            [call("type", [id(name)])]
        )
        return t.expressionStatement(call("__typed_parameter__", [id(name), str(label), str(name), t.booleanLiteral(optional), template]))
    }

    asStruct(value, label) {
        const literal = value?.type === "ObjectExpression" ||
            (value?.type === "ArrayExpression" && value.elements.some(element => element?.type === "ObjectExpression"))
        if (!literal || NOT_STRUCTS.has(label)) return value
        return withLoc(call("__as_struct__", [value, str(label)]), value)
    }

    lowerFunction(node, parent) {
        const name = this.functionName(node, parent)
        const checks = []

        if (this.typeParams.length > 0) {
            const keep = annotation => annotation ? this.label(annotation, { keepTypeParams: true }) : null
            node._slimSignature = {
                typeParams: typeParamNames(node),
                params: node.params.map(param => {
                    const target = param.type === "AssignmentPattern" ? param.left : param.type === "RestElement" ? param.argument : param
                    return keep(param.typeAnnotation ?? target.typeAnnotation)
                }),
                optional: node.params.map(param => !!param.optional),
                returns: keep(node.returnType)
            }
        }

        node.params.forEach((param, index) => {
            const target = param.type === "AssignmentPattern" ? param.left : param.type === "RestElement" ? param.argument : param
            const annotation = param.typeAnnotation ?? target.typeAnnotation
            if (!annotation || target.type !== "Identifier") return

            const label = this.label(annotation)
            if (label === "any") return
            checks.push(this.typedParameter(target.name, label, !!target.optional, index, name))
        })

        if (node.returnType) {
            const label = this.label(node.returnType)
            checks.push(t.expressionStatement(call("__declare_return__", [str(label), str(name)])))
            if (node.body.type === "BlockStatement") {
                for (const statement of returnsOf(node.body)) statement.argument = this.asStruct(statement.argument, label)
            } else {
                node.body = this.asStruct(node.body, label)
            }
        }
        if (checks.length === 0) return node

        if (node.body.type === "BlockStatement") {
            node.body.body.unshift(...checks)
        } else {
            node.body = t.blockStatement([...checks, t.returnStatement(node.body)])
            node.expression = false
        }
        return node
    }

    FunctionDeclaration(node, parent) { return this.lowerFunction(node, parent) }
    FunctionExpression(node, parent) { return this.lowerFunction(node, parent) }
    ObjectMethod(node, parent) { return this.lowerFunction(node, parent) }
    ClassMethod(node, parent) { return this.lowerFunction(node, parent) }
    ClassPrivateMethod(node, parent) { return this.lowerFunction(node, parent) }

    ArrowFunctionExpression(node, parent) {
        return this.lowerFunction(node, parent)
    }


    VariableDeclaration(node) {
        if (!node.slimState) return node
        const [declarator] = node.declarations
        if (node.declarations.length !== 1 || declarator.id.type !== "Identifier" || !declarator.init) {
            this.fail(node, "A state needs a name and a starting value: state count = 0")
        }
        this.stateDeclarations.push(node)
        return node
    }

    VariableDeclarator(node) {
        const annotation = node.id.typeAnnotation
        if (!annotation || !node.init) return node

        const label = this.label(annotation)
        node.init = this.asStruct(node.init, label)
        node.init = node.id.type === "Identifier"
            ? withLoc(call("__typed_variable__", [node.init, str(label), str(node.id.name)]), node.init)
            : withLoc(call("__typed_pattern__", [node.init, str(label)]), node.init)
        return node
    }

    ClassProperty(node) {
        if (!node.typeAnnotation || !node.value) return node
        node.value = withLoc(call("__typed_variable__", [node.value, str(this.label(node.typeAnnotation)), str(keyName(node.key) ?? "field")]), node.value)
        return node
    }

    ClassPrivateProperty(node) {
        return this.ClassProperty(node)
    }


    declare(node, init) {
        const declarator = t.variableDeclarator(withLoc(id(node.id.name), node.id), init)
        return withLoc(t.variableDeclaration("const", [declarator]), node)
    }

    SlimStructDeclaration(node) {
        const name = node.id.name
        const schema = node.fields.map(field =>
            t.objectProperty(str((field.optional ? "*" : "") + field.key.name), str(this.label(field.typeAnnotation, { keepTypeParams: true }))))
        const defaults = node.fields
            .filter(field => field.value)
            .map(field => t.objectProperty(str(field.key.name), t.arrowFunctionExpression([], field.value)))
        const methods = node.methods.map(method => {
            const fn = withLoc(t.functionExpression(null, method.params, method.body, method.generator, method.async), method)
            fn._slimSignature = method._slimSignature
            return t.objectProperty(str(keyName(method.key)), fn)
        })
        const readonly = node.fields.filter(field => field.readonly).map(field => str(field.key.name))

        const args = [
            str(name),
            t.objectExpression(schema),
            t.objectExpression([]),
            t.objectExpression(defaults),
            node.superName ? str(node.superName.name) : t.nullLiteral(),
            methods.length ? t.objectExpression(methods) : t.nullLiteral(),
            node.typeParameters.length ? t.arrayExpression(node.typeParameters.map(param => str(param.name))) : t.nullLiteral(),
            readonly.length ? t.arrayExpression(readonly) : t.nullLiteral()
        ]
        while (args.length > 4 && t.isNullLiteral(args[args.length - 1])) args.pop()

        return this.declare(node, withLoc(call("__def_struct__", args), node))
    }

    SlimEnumDeclaration(node) {
        const members = node.members.map(member =>
            t.objectProperty(str(member.key.name), member.value ?? str(member.key.name)))
        return this.declare(node, withLoc(call("__def_enum__", [str(node.id.name), t.objectExpression(members)]), node))
    }

    typeDef(node, value, properties) {
        const props = t.objectExpression(Object.entries(properties).map(([key, entry]) => t.objectProperty(str(key), str(entry))))
        return this.declare(node, withLoc(call("__type_def__", [str(node.id.name), value, props]), node))
    }

    SlimTypeDeclaration(node) {
        if (node.kind === "alias") return this.typeDef(node, str(this.label(node.typeAnnotation)), { type: "one-line-expr" })
        if (node.kind === "typeof") return this.typeDef(node, node.expression, { type: "one-line-expr" })
        if (node.kind === "extends") {
            const label = this.label(node.typeAnnotation)
            return this.typeDef(node, str(label), { type: "one-line-expr", extends: label })
        }

        const { validator } = node
        const statements = validator.body.body
        const empty = statements.length === 0 ||
            (statements.length === 1 && t.isReturnStatement(statements[0]) && !statements[0].argument)
        const body = empty ? t.blockStatement([t.returnStatement(t.booleanLiteral(true))]) : validator.body
        const fn = withLoc(t.arrowFunctionExpression(validator.params, body), validator)

        return this.typeDef(node, fn, node.superType ? { extends: this.label(node.superType) } : {})
    }

    TSTypeAliasDeclaration(node) {
        return this.typeDef(node, str(this.label(node.typeAnnotation)), { type: "one-line-expr" })
    }

    SlimUseDeclaration(node) {
        const expression = node.specifier === null
            ? call("__use_all__", [str(node.source)])
            : call("__use__", [str(node.specifier), str(node.source)])
        return withLoc(t.expressionStatement(expression), node)
    }

    SlimModeStatement() {
        return null
    }

    SlimComponentDeclaration(node) {
        const component = buildComponent(node, this)
        component._slimComponentProps = componentProps(node, this)
        return this.declare(node, component)
    }


    Program(node) {
        node.body = node.body.flatMap(statement => {
            if (statement.type !== "ExportDefaultDeclaration" || statement.declaration.type !== "VariableDeclaration") {
                return [statement]
            }
            const declaration = statement.declaration
            const [first] = declaration.declarations
            if (declaration.declarations.length !== 1 || first.id.type !== "Identifier") {
                this.fail(statement, "export default needs a single named declaration")
            }
            return [declaration, t.exportNamedDeclaration(null, [t.exportSpecifier(id(first.id.name), id("default"))])]
        })
        for (const statement of node.body) {
            const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
            if (declaration?.slimState) declaration._slimStateOk = true
        }
        const stray = this.stateDeclarations.find(declaration => !declaration._slimStateOk)
        if (stray) this.fail(stray, "state can only be declared at the top of a component body or a module")
        return node
    }
}


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
    const onMount = fn => __mounts__.push(fn);
    const onConnect = fn => __connects__.push(fn);
    const onUnmount = fn => __unmounts__.push(fn);`

function componentBinding(params) {
    if (params.items.length === 0) return null
    if (!params.pattern) return id(params.items[0].name.name)

    return t.objectPattern(params.items.map(item => {
        const value = item.value ? t.assignmentPattern(id(item.name.name), item.value) : id(item.name.name)
        return t.objectProperty(id(item.name.name), value, false, true)
    }))
}

function componentProps(node, lowering) {
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

function buildComponent(node, lowering) {
    const name = node.id.name
    const statements = node.body.body
    const returnIndex = statements.findIndex(statement => t.isReturnStatement(statement))
    if (returnIndex === -1 || !statements[returnIndex].argument) lowering.fail(node, `Component "${name}" must contain return`)

    for (const statement of statements) {
        if (!statement.slimState) continue
        if (node.modifier === "isolated") lowering.fail(statement, "An isolated component can't have state")
        statement._slimStateOk = true
    }

    const before = statements.slice(0, returnIndex)
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
    const element = elementExpression(markup, name)
    element._slimRoot = markup
    const checks = componentChecks(node, lowering)
    const binding = componentBinding(node.params)
    const info = { name, bem: useBEMClasses() ? kebabCase(name) : null }

    if (node.modifier === "isolated") {
        const tail = fill(parseTemplate(`const __el__ = __SLIM_ELEMENT__;
            for (const fn of __mounts__) fn(__el__);
            __lifecycle__(__el__, __connects__, __unmounts__);
            return __el__;`), { __SLIM_ELEMENT__: element })
        const bodyCode = generate(t.program([...parseTemplate(HOOKS), ...before, ...tail]), { compact: true }).code
        const bindingCode = binding ? generate(binding).code : ""
        const guard = checks.length && binding
            ? [t.variableDeclaration("const", [t.variableDeclarator(binding, id("__props__"))]), ...checks]
            : []

        const [statement] = parseTemplate(`(() => {
            const ${name} = (__props__ = {}) => {
                __SLIM_GUARD__;
                return new Function(${JSON.stringify(bindingCode)}, ${JSON.stringify(bodyCode)})(__props__);
            };
            ${name}.__component__ = true;
            return ${name};
        })()`)
        return fill(statement, { __SLIM_GUARD__: guard }).expression
    }

    const body = [...checks, ...before]

    if (node.modifier === "element") {
        const tag = JSON.stringify(elementTag(node, lowering))
        const [statement] = parseTemplate(`(() => {
            const ${name} = (__props__ = {}) => ${name}.__render__(__props__);
            ${name}.__component__ = true;
            ${name}.tag = ${tag};
            ${name}.__render__ = (__SLIM_PARAM__ = {}, __host__ = null) => __component__(() => {
                const s = {};
                ${HOOKS}
                __SLIM_BODY__;
                const __el__ = __SLIM_ELEMENT__;
                if (!__host__) {
                    for (const fn of __mounts__) fn(__el__);
                    __lifecycle__(__el__, __connects__, __unmounts__);
                    return __el__;
                }
                __adopt_into__(__host__, __el__);
                for (const fn of __mounts__) fn(__host__);
                return { connects: __connects__, unmounts: __unmounts__ };
            });
            __define_element__(${tag}, ${name}.__render__);
            return ${name};
        })()`)
        const expression = fill(statement, {
            __SLIM_PARAM__: binding ?? id("__unused__"),
            __SLIM_BODY__: body,
            __SLIM_ELEMENT__: element
        }).expression
        componentFunction(expression)._slimComponent = info
        return expression
    }

    const [statement] = parseTemplate(`(() => {
        const ${name} = (__SLIM_PARAM__ = {}) => __component__(() => {
            const s = {};
            ${HOOKS}
            __SLIM_BODY__;
            const __el__ = __SLIM_ELEMENT__;
            for (const fn of __mounts__) fn(__el__);
            __lifecycle__(__el__, __connects__, __unmounts__);
            return __el__;
        });
        ${name}.__component__ = true;
        return ${name};
    })()`)

    const expression = fill(statement, { __SLIM_BODY__: body, __SLIM_ELEMENT__: element }).expression
    const inner = expression.callee.body.body[0].declarations[0].init
    if (binding) inner.params[0].left = binding
    else inner.params = []
    inner._slimComponent = info
    return expression
}


const UNWRAP = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "TSInstantiationExpression"])
const UNSUPPORTED = new Set([
    "TSInterfaceDeclaration", "TSEnumDeclaration", "TSModuleDeclaration", "TSDeclareFunction", "TSDeclareMethod",
    "TSImportEqualsDeclaration", "TSExportAssignment", "TSNamespaceExportDeclaration", "TSAbstractMethodDefinition"
])
const TYPE_KEYS = ["typeAnnotation", "returnType", "typeParameters", "typeArguments", "superTypeParameters", "implements", "predicate"]
const MODIFIER_KEYS = ["definite", "declare", "accessibility", "abstract", "override"]
const PATTERNS = new Set(["Identifier", "ObjectPattern", "ArrayPattern", "RestElement", "AssignmentPattern"])

function stripTypes(node, lowering) {
    if (Array.isArray(node)) return node.map(child => stripTypes(child, lowering))
    if (!isNode(node)) return node

    if (UNSUPPORTED.has(node.type)) lowering.fail(node, `TypeScript syntax (${node.type.slice(2)}) is not supported in Slim`)
    if (UNWRAP.has(node.type)) return stripTypes(node.expression, lowering)
    if (node.type === "TSParameterProperty") return stripTypes(node.parameter, lowering)

    for (const key of TYPE_KEYS) delete node[key]
    for (const key of MODIFIER_KEYS) delete node[key]
    if (PATTERNS.has(node.type) || node.type === "ClassProperty" || node.type === "ClassMethod") delete node.optional
    if (node.type === "ClassProperty" || node.type === "ClassPrivateProperty") delete node.readonly

    for (const [key, value] of Object.entries(node)) {
        if (key === "loc" || key === "extra") continue
        if (Array.isArray(value) || isNode(value)) node[key] = stripTypes(value, lowering)
    }
    return node
}

export function lowerSlim(file, code, sourceFile) {
    const lowering = new Lowering(code, sourceFile)
    file.program = lowering.visit(file.program, file)
    stripTypes(file.program, lowering)
    return file
}
