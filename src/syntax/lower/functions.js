import * as t from "@babel/types"
import { formatType, readType } from "../../external/typeSyntax.js"
import { NOT_STRUCTS, call, id, keyName, returnsOf, str, typeParamNames, withLoc } from "./helpers.js"

export const functionLowering = {
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
    },

    typedParameter(name, label, optional, index, fnName) {
        const type = readType(label)
        const expected = (type.kind === "union" ? type.types : [type]).map(formatType).join(" or ")
        const message = optional
            ? `${fnName}: argument "${name}" expected ${expected}`
            : `function "${fnName}": argument<${index}> "${name}" expected ${expected}`
        return t.expressionStatement(call("__typed_parameter__", [id(name), str(label), str(name), t.booleanLiteral(optional), str(`${message}, got `)]))
    },

    asStruct(value, label) {
        const literal = value?.type === "ObjectExpression" ||
            (value?.type === "ArrayExpression" && value.elements.some(element => element?.type === "ObjectExpression"))
        if (!literal || NOT_STRUCTS.has(label)) return value
        return withLoc(call("__as_struct__", [value, str(label)]), value)
    },

    lowerFunction(node, parent) {
        const name = this.functionName(node, parent)
        const checks = []
        if (this.functions.at(-1)?.tries) this.wrapTries(node)

        if (this.typeParams.length > 0) {
            const keep = annotation => annotation ? this.label(annotation, { keepTypeParams: true }) : null
            node._slimSignature = {
                typeParams: typeParamNames(node),
                constraints: Object.fromEntries(this.typeParamEntries(node).filter(param => param.label).map(param => [param.name, param.label])),
                defaults: this.typeDefaults(node),
                params: node.params.map(param => {
                    const target = param.type === "AssignmentPattern" ? param.left : param.type === "RestElement" ? param.argument : param
                    return keep(param.typeAnnotation ?? target.typeAnnotation)
                }),
                optional: node.params.map(param => !!param.optional),
                returns: keep(node.returnType)
            }
        }

        const declaredParams = node.params.map(param => {
            const target = param.type === "AssignmentPattern" ? param.left : param.type === "RestElement" ? param.argument : param
            const annotation = param.typeAnnotation ?? target.typeAnnotation
            return {
                label: annotation ? this.label(annotation, { keepTypeParams: true }) : null,
                optional: !!target.optional || param.type === "AssignmentPattern",
                rest: param.type === "RestElement"
            }
        })
        if (node.returnType || declaredParams.some(param => param.label)) {
            const own = typeParamNames(node)
            const constraints = own.length ? Object.fromEntries(this.typeParamEntries(node).filter(param => param.label).map(param => [param.name, param.label])) : {}
            node._slimDeclared = {
                typeParams: own.map(name => ({ name, constraint: constraints[name] ?? null })),
                params: declaredParams,
                returns: node.returnType ? this.label(node.returnType, { keepTypeParams: true }) : null
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
    },

    FunctionDeclaration(node, parent) { return this.lowerFunction(node, parent) },

    FunctionExpression(node, parent) { return this.lowerFunction(node, parent) },

    ObjectMethod(node, parent) { return this.lowerFunction(node, parent) },

    ClassMethod(node, parent) { return this.lowerFunction(node, parent) },

    ClassPrivateMethod(node, parent) { return this.lowerFunction(node, parent) },

    ArrowFunctionExpression(node, parent) {
        return this.lowerFunction(node, parent)
    },

    VariableDeclaration(node, parent) {
        if (node.declare) return this.declaredValue(node, parent)
        if (!node.slimState) return node
        const [declarator] = node.declarations
        if (node.declarations.length !== 1 || declarator.id.type !== "Identifier" || !declarator.init) {
            this.fail(node, "A state needs a name and a starting value: state count = 0")
        }
        this.stateDeclarations.push(node)
        return node
    },

    declaredValue(node, parent) {
        const [declarator] = node.declarations
        const name = declarator.id?.name ?? "world"
        if (!node.slimGlobal) this.fail(node, `Write "global ${name}: Type" instead of "declare": global ${name}: World, global ${name}?: World, or global let ${name}: World`)
        if (parent.type !== "Program") this.fail(node, "global belongs at the top level of a file")
        const label = this.label(declarator.id.typeAnnotation)
        const type = node.slimGlobal.optional ? formatType({ kind: "union", types: [readType(label), { kind: "named", name: "undefined" }] }) : label
        return withLoc(t.expressionStatement(call("__declare_value__", [str(name), str(type), str(node.kind)])), node)
    },

    VariableDeclarator(node) {
        const annotation = node.id.typeAnnotation
        if (!annotation || !node.init) return node

        const label = this.label(annotation)
        node.init = this.asStruct(node.init, label)
        node.init = node.id.type === "Identifier"
            ? withLoc(call("__typed_variable__", [node.init, str(label), str(node.id.name)]), node.init)
            : withLoc(call("__typed_pattern__", [node.init, str(label)]), node.init)
        return node
    },

    ClassProperty(node) {
        if (!node.typeAnnotation) return node
        const label = this.label(node.typeAnnotation)
        node._slimField = { type: label, optional: !!node.optional, readonly: !!node.readonly, setLater: !!node.definite }
        if (!node.value) return node
        node.value = withLoc(call("__typed_variable__", [node.value, str(label), str(keyName(node.key) ?? "field")]), node.value)
        return node
    },

    ClassPrivateProperty(node) {
        return this.ClassProperty(node)
    },

    declare(node, init) {
        const declarator = t.variableDeclarator(withLoc(id(node.id.name), node.id), init)
        return withLoc(t.variableDeclaration("const", [declarator]), node)
    },

    CatchClause(node) {
        const param = node.param
        const annotation = param?.typeAnnotation
        if (!annotation) return node
        if (param.type !== "Identifier") this.fail(param, "a typed catch needs a name: catch (e: TypeError)")

        const label = this.label(annotation)
        if (label === "any") return node
        param._slimCatchType = label
        node.body.body.unshift(t.expressionStatement(call("__typed_catch__", [id(param.name), str(label)])))
        return node
    }
}
