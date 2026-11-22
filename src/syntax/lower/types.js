import { typeFromAST } from "../types.js"
import { ANY } from "../../external/typeSyntax.js"
import { isNode } from "./helpers.js"

const UNWRAP = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "TSInstantiationExpression"])
const UNSUPPORTED = new Set([
    "TSInterfaceDeclaration", "TSEnumDeclaration", "TSModuleDeclaration", "TSDeclareFunction", "TSDeclareMethod",
    "TSImportEqualsDeclaration", "TSExportAssignment", "TSNamespaceExportDeclaration", "TSAbstractMethodDefinition"
])
const TYPE_KEYS = ["typeAnnotation", "returnType", "typeParameters", "typeArguments", "superTypeParameters", "implements", "predicate"]
const MODIFIER_KEYS = ["definite", "declare", "accessibility", "abstract", "override"]
const PATTERNS = new Set(["Identifier", "ObjectPattern", "ArrayPattern", "RestElement", "AssignmentPattern"])

function markCast(cast, inner) {
    if (!isNode(inner)) return inner
    if (cast.type === "TSNonNullExpression") inner._slimNonNull = true
    if (cast.type === "TSAsExpression" || cast.type === "TSTypeAssertion") {
        const type = cast.typeAnnotation
        const isConst = type.type === "TSTypeReference" && type.typeName.name === "const"
        if (!isConst) inner._slimCast = typeFromAST(type, () => ANY)
    }
    return inner
}

export function stripTypes(node, lowering) {
    if (Array.isArray(node)) return node.map(child => stripTypes(child, lowering))
    if (!isNode(node)) return node

    if (UNSUPPORTED.has(node.type)) lowering.fail(node, `TypeScript syntax (${node.type.slice(2)}) is not supported in Slim`)
    if (UNWRAP.has(node.type)) return markCast(node, stripTypes(node.expression, lowering))
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
