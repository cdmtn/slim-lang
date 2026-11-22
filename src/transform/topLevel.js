import * as t from "@babel/types"

function isAsyncFunctionBinding(binding) {
    const node = binding?.path.node
    if (t.isFunctionDeclaration(node)) return node.async
    return t.isVariableDeclarator(node) && t.isFunction(node.init) && node.init.async
}

export function callsAsyncFunction(path_, call) {
    return t.isCallExpression(call) && t.isIdentifier(call.callee) &&
        isAsyncFunctionBinding(path_.scope.getBinding(call.callee.name))
}

function isExport(node) {
    return t.isExportNamedDeclaration(node) || t.isExportDefaultDeclaration(node) || t.isExportAllDeclaration(node)
}

function catchTopLevel(statements) {
    return t.tryStatement(
        t.blockStatement(statements),
        t.catchClause(t.identifier("__err__"), t.blockStatement([
            t.expressionStatement(t.callExpression(t.identifier("__handle_sync_error__"), [t.identifier("__err__")]))
        ]))
    )
}

export function layoutTopLevel(body) {
    const head = []
    const declared = []
    const ordered = []
    const hasExports = body.some(node => isExport(node) || node._slimPureDefinition)

    const assign = (target, value) =>
        ordered.push(t.expressionStatement(t.assignmentExpression("=", target, value)))

    const declare = (kind, names, exported, comments = []) => {
        const declaration = t.variableDeclaration(kind, names.map(name => t.variableDeclarator(t.identifier(name))))
        const statement = exported ? t.exportNamedDeclaration(declaration, []) : declaration
        if (comments.length) statement.leadingComments = comments
        declared.push(statement)
    }

    const hoistVariables = (node, exported, outer = null) => {
        const names = node.declarations.flatMap(declarator => Object.keys(t.getBindingIdentifiers(declarator.id)))
        const comments = [...(outer?.leadingComments ?? []), ...(node.leadingComments ?? [])]
        const [only] = node.declarations
        const onFunction = node.declarations.length === 1 && t.isFunction(only.init)
        if (onFunction && comments.length) only.init.leadingComments = [...comments, ...(only.init.leadingComments ?? [])]
        declare(node.kind === "var" ? "var" : "let", names, exported, onFunction ? [] : comments)
        for (const declarator of node.declarations) {
            if (declarator.init) assign(declarator.id, declarator.init)
        }
    }

    const hoistClass = (node, exported) => {
        declare("let", [node.id.name], exported)
        assign(t.identifier(node.id.name), t.classExpression(node.id, node.superClass, node.body, node.decorators))
    }

    const hoistDefault = node => {
        const declaration = node.declaration
        if (t.isFunctionDeclaration(declaration)) return declared.push(node)

        let local = "__slim_default__"
        if (t.isClassDeclaration(declaration) && declaration.id) {
            local = declaration.id.name
            hoistClass(declaration, false)
        } else {
            declare("let", [local], false)
            assign(t.identifier(local), t.isClassDeclaration(declaration)
                ? t.classExpression(null, declaration.superClass, declaration.body, declaration.decorators)
                : declaration)
        }
        declared.push(t.exportNamedDeclaration(null, [t.exportSpecifier(t.identifier(local), t.identifier("default"))]))
    }

    for (const node of body) {
        if (t.isImportDeclaration(node) || node._slimTypeSlots) head.push(node)
        else if (!hasExports) ordered.push(node)
        else if (node._slimPureDefinition) declared.push(node)
        else if (t.isFunctionDeclaration(node)) declared.push(node)
        else if (t.isVariableDeclaration(node)) hoistVariables(node, false)
        else if (t.isClassDeclaration(node) && node.id) hoistClass(node, false)
        else if (t.isExportDefaultDeclaration(node)) hoistDefault(node)
        else if (t.isExportNamedDeclaration(node) && t.isVariableDeclaration(node.declaration)) hoistVariables(node.declaration, true, node)
        else if (t.isExportNamedDeclaration(node) && t.isClassDeclaration(node.declaration)) hoistClass(node.declaration, true)
        else if (isExport(node)) declared.push(node)
        else ordered.push(node)
    }

    return [...head, ...declared, catchTopLevel(ordered)]
}
