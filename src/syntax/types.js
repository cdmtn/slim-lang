import {
    ANY, named, literal, arrayOf, tupleOf, genericOf, enumMember, unionOf, intersectionOf, nullable, functionOf
} from "../external/typeSyntax.js"

const KEYWORDS = {
    TSAnyKeyword: "any",
    TSUnknownKeyword: "any",
    TSStringKeyword: "string",
    TSNumberKeyword: "number",
    TSBooleanKeyword: "bool",
    TSNullKeyword: "null",
    TSUndefinedKeyword: "undefined",
    TSVoidKeyword: "undefined",
    TSObjectKeyword: "object",
    TSBigIntKeyword: "bigint",
    TSSymbolKeyword: "symbol"
}

const UNSUPPORTED = {
    TSTypeLiteral: "object type literals are not supported, declare a struct instead",
    TSMappedType: "mapped types are not supported",
    TSConditionalType: "conditional types are not supported",
    TSIndexedAccessType: "indexed access types are not supported",
    TSTypeQuery: "\"typeof\" in a type position is not supported, use \"type Name = typeof value\"",
    TSInferType: "\"infer\" is not supported",
    TSTemplateLiteralType: "template literal types are not supported",
    TSThisType: "\"this\" type is not supported",
    TSNeverKeyword: "\"never\" type is not supported",
    TSImportType: "import types are not supported, use \"use\" to bring the type in"
}

function entityName(node) {
    if (node.type === "Identifier") return node.name
    if (node.type === "TSQualifiedName") return `${entityName(node.left)}.${node.right.name}`
    return null
}

function literalType(node, fail) {
    const value = node.literal
    switch (value.type) {
        case "StringLiteral":
        case "NumericLiteral":
        case "BooleanLiteral":
            return literal(value.value)
        case "UnaryExpression":
            if (value.operator === "-" && value.argument.type === "NumericLiteral") return literal(-value.argument.value)
            break
        case "TemplateLiteral":
            if (value.expressions.length === 0) return literal(value.quasis[0].value.cooked)
            break
    }
    return fail(node, "this literal type is not supported")
}

export function typeFromAST(node, fail) {
    const convert = child => typeFromAST(child, fail)

    if (node.type === "TSTypeAnnotation") return convert(node.typeAnnotation)
    if (node.type in KEYWORDS) return named(KEYWORDS[node.type])
    if (node.type in UNSUPPORTED) return fail(node, UNSUPPORTED[node.type])

    switch (node.type) {
        case "TSTypeReference": {
            const name = entityName(node.typeName)
            const args = (node.typeParameters ?? node.typeArguments)?.params
            return args ? genericOf(name, args.map(convert)) : named(name)
        }
        case "TSArrayType": return arrayOf(convert(node.elementType))
        case "TSTupleType":
            return tupleOf(node.elementTypes.map(element => {
                if (element.type === "TSNamedTupleMember") {
                    if (element.optional) fail(element, "optional tuple members are not supported")
                    return convert(element.elementType)
                }
                if (element.type === "TSOptionalType" || element.type === "TSRestType") {
                    return fail(element, "optional and rest tuple members are not supported")
                }
                return convert(element)
            }))
        case "TSUnionType": return unionOf(node.types.map(convert))
        case "TSIntersectionType": return intersectionOf(node.types.map(convert))
        case "TSParenthesizedType": return convert(node.typeAnnotation)
        case "TSLiteralType": return literalType(node, fail)
        case "TSFunctionType": {
            const params = (node.parameters ?? node.params).map(param => {
                if (param.type === "RestElement") return fail(param, "rest parameters in function types are not supported")
                const annotation = param.typeAnnotation
                return { name: param.type === "Identifier" ? param.name : null, type: annotation ? convert(annotation) : ANY }
            })
            const returns = node.typeAnnotation ?? node.returnType
            return functionOf(params, returns ? convert(returns) : ANY)
        }
        case "TSConstructorType":
            return named("function")
        case "TSTypeOperator":
            if (node.operator === "readonly") return convert(node.typeAnnotation)
            return fail(node, `"${node.operator}" types are not supported`)
        case "TSTypePredicate":
            return named("bool")
        case "SlimNullableType": return nullable(convert(node.typeAnnotation))
        case "SlimEnumMemberType": return enumMember(entityName(node.enumName.typeName), node.member.name)
    }

    fail(node, `this type is not supported in Slim`)
    return ANY
}
