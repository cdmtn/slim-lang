import * as t from "@babel/types"
import { call, keyName, numericValue, str, withLoc } from "./helpers.js"
import { buildComponent, componentProps } from "./components.js"

export const declarationLowering = {
    structSchema(node) {
        return node.fields.map(field =>
            t.objectProperty(str((field.optional ? "*" : "") + field.key.name), str(this.label(field.typeAnnotation, { keepTypeParams: true }))))
    },

    structMethods(methods) {
        return methods.map(method => {
            const fn = withLoc(t.functionExpression(null, method.params, method.body, method.generator, method.async), method)
            fn._slimSignature = method._slimSignature
            fn._slimSignatureOnly = !!method.slimSignatureOnly
            return t.objectProperty(str(keyName(method.key)), fn)
        })
    },

    SlimTraitDeclaration(node) {
        const fields = node.fields.filter(field => {
            if (field.value) this.fail(field.value, "a trait field can't have a default: give the default in the struct")
            if (field.readonly) this.fail(field, "a trait field can't be readonly: mark it readonly in the struct")
            return true
        })
        const required = this.structMethods(node.methods.filter(method => method.slimSignatureOnly))
        const defaults = this.structMethods(node.methods.filter(method => !method.slimSignatureOnly))
        const args = [str(node.id.name), t.objectExpression(this.structSchema({ fields })), t.objectExpression(required), t.objectExpression(defaults)]
        if (node.typeParameters.length) args.push(t.arrayExpression(node.typeParameters.map(param => str(param.name))))
        const definition = withLoc(call("__def_trait__", args), node)
        definition._slimTypeDefaults = this.typeDefaults(node)
        return this.declare(node, definition)
    },

    traitList(node) {
        return node.implements.length
            ? t.arrayExpression(node.implements.map(trait => withLoc(str(this.label(trait, { keepTypeParams: true })), trait)))
            : t.nullLiteral()
    },

    typeConstraints(node) {
        return Object.fromEntries(this.typeParamEntries(node).filter(param => param.label).map(param => [param.name, param.label]))
    },

    SlimStructDeclaration(node) {
        const name = node.id.name
        const schema = this.structSchema(node)
        const defaults = node.fields
            .filter(field => field.value)
            .map(field => t.objectProperty(str(field.key.name), t.arrowFunctionExpression([], field.value)))
        const methods = this.structMethods(node.methods)
        const readonly = node.fields.filter(field => field.readonly).map(field => str(field.key.name))

        const args = [
            str(name),
            t.objectExpression(schema),
            t.objectExpression([]),
            t.objectExpression(defaults),
            node.superName ? str(node.superName.name) : t.nullLiteral(),
            methods.length ? t.objectExpression(methods) : t.nullLiteral(),
            node.typeParameters.length ? t.arrayExpression(node.typeParameters.map(param => str(param.name))) : t.nullLiteral(),
            readonly.length ? t.arrayExpression(readonly) : t.nullLiteral(),
            this.traitList(node)
        ]
        while (args.length > 4 && t.isNullLiteral(args[args.length - 1])) args.pop()

        const definition = withLoc(call("__def_struct__", args), node)
        definition._slimConstraints = this.typeConstraints(node)
        definition._slimTypeDefaults = this.typeDefaults(node)
        return this.declare(node, definition)
    },

    SlimEnumDeclaration(node) {
        if (node.typeParameters.length > 0 || node.methods.length > 0 || node.implements.length > 0 || node.members.some(member => member.fields)) {
            return this.dataEnum(node)
        }
        let previous = null
        const members = node.members.map(member => {
            let value = member.value
            if (!value) value = previous === null ? str(member.key.name) : t.numericLiteral(previous + 1)
            previous = numericValue(value)
            return t.objectProperty(str(member.key.name), value)
        })
        return this.declare(node, withLoc(call("__def_enum__", [str(node.id.name), t.objectExpression(members)]), node))
    },

    dataEnum(node) {
        const variants = node.members.map(member => {
            if (member.value && !node.members.some(other => other.fields)) {
                this.fail(member.value, `an enum with methods or traits can't give its members values: write ${member.key.name}`)
            }
            if (member.value) this.fail(member.value, `"${member.key.name}" carries data, so it can't have a value: write ${member.key.name}(field: Type) or ${member.key.name}`)
            const fields = member.fields && t.arrayExpression(member.fields.map(field =>
                t.arrayExpression([str(field.key.name), str(this.label(field.typeAnnotation, { keepTypeParams: true }))])))
            return t.objectProperty(str(member.key.name), fields ?? t.nullLiteral())
        })
        const methods = this.structMethods(node.methods)
        const args = [
            str(node.id.name),
            t.objectExpression(variants),
            node.typeParameters.length ? t.arrayExpression(node.typeParameters.map(param => str(param.name))) : t.nullLiteral(),
            methods.length ? t.objectExpression(methods) : t.nullLiteral(),
            this.traitList(node)
        ]
        while (args.length > 2 && t.isNullLiteral(args[args.length - 1])) args.pop()
        const definition = withLoc(call("__def_variants__", args), node)
        definition._slimTypeDefaults = this.typeDefaults(node)
        return this.declare(node, definition)
    },

    typeDef(node, value, properties) {
        const props = t.objectExpression(Object.entries(properties).map(([key, entry]) => t.objectProperty(str(key), str(entry))))
        return this.declare(node, withLoc(call("__type_def__", [str(node.id.name), value, props]), node))
    },

    SlimTypeDeclaration(node) {
        if (node.kind === "alias") return this.typeDef(node, str(this.label(node.typeAnnotation)), this.aliasProperties(node))
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
    },

    TSTypeAliasDeclaration(node) {
        return this.typeDef(node, str(this.label(node.typeAnnotation)), this.aliasProperties(node))
    },

    SlimUseDeclaration(node) {
        const expression = node.specifier === null
            ? call("__use_all__", [str(node.source)])
            : call("__use__", [str(node.specifier), str(node.source)])
        return withLoc(t.expressionStatement(expression), node)
    },

    SlimModeStatement() {
        return null
    },

    SlimComponentDeclaration(node) {
        const component = buildComponent(node, this)
        component._slimComponentProps = componentProps(node, this)
        return this.declare(node, component)
    }
}
