import * as t from "@babel/types"
import { slimSyntaxError } from "./syntax/plugin.js"
import { call, id, traverse } from "./reactivity/ast.js"
import { MarkupCompiler } from "./reactivity/markup.js"
import { useImported } from "./reactivity/reads.js"
import { innerPath, passGetters, prepare, prepareDeclarations, prepareModule } from "./reactivity/prepare.js"
import { passRawProps, propsParameter, rewrite } from "./reactivity/rewrite.js"
export { slimModuleTarget, reactiveImports, reactiveExports } from "./reactivity/exports.js"

function hasComponent(node) {
    if (!node || typeof node !== "object") return false
    if (Array.isArray(node)) return node.some(hasComponent)
    if (node._slimComponent) return true
    for (const key in node) {
        if (key === "loc" || key === "extra" || key === "leadingComments" || key === "trailingComments") continue
        const value = node[key]
        if (value && typeof value === "object" && hasComponent(value)) return true
    }
    return false
}

export function compileReactivity(ast, code, { importedReactive: imported = new Map(), importedReaders: readers = new Set() } = {}) {
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
    useImported(imported, readers)
    const reset = () => useImported()

    const pass = visit => {
        traverse.cache.clear()
        traverse(ast, { Program: visit })
    }
    const components = programPath => {
        const found = []
        programPath.traverse({
            Function(path) {
                if (path.node._slimComponent) found.push(path)
            }
        })
        return found
    }

    const hooks = programPath => {
        const found = []
        for (const statement of programPath.get("body")) {
            const declaration = statement.isExportNamedDeclaration() ? statement.get("declaration") : statement
            if (declaration.isFunctionDeclaration() && /^use[A-Z]/.test(declaration.node.id?.name ?? "")) found.push(declaration)
            if (!declaration.isVariableDeclaration()) continue
            for (const declarator of declaration.get("declarations")) {
                const init = declarator.get("init")
                if (init.isFunction() && t.isIdentifier(declarator.node.id) && /^use[A-Z]/.test(declarator.node.id.name)) found.push(init)
            }
        }
        return found.filter(path => path.get("body").isBlockStatement())
    }
    const moduleStates = ast.program.body.some(statement => (statement.declaration ?? statement).slimState)
    const hasHookState = ast.program.body.some(statement => {
        const declaration = statement.declaration ?? statement
        const bodies = declaration.type === "VariableDeclaration" ? declaration.declarations.map(item => item.init?.body) : [declaration.body]
        return bodies.some(body => body?.type === "BlockStatement" && body.body.some(item => item.slimState))
    })
    let found = moduleStates || hasHookState || imported.size > 0 || readers.size > 0
    if (!found && !hasComponent(ast.program)) {
        reset()
        return
    }
    pass(programPath => {
        prepareModule(programPath)
        for (const path of hooks(programPath)) {
            for (const param of path.node.params) {
                const target = t.isAssignmentPattern(param) ? param.left : param
                if (t.isIdentifier(target)) target._slimReactive = "hook"
            }
            prepareDeclarations(path.get("body.body"))
        }
        for (const path of components(programPath)) {
            found = true
            prepare(path, compiler)
        }
    })
    if (!found) {
        reset()
        return
    }

    pass(programPath => {
        programPath.traverse({
            Function(row) {
                if (row.node._slimListRow && row.get("body").isBlockStatement()) prepareDeclarations(row.get("body.body"))
            }
        })
    })
    pass(passGetters)
    pass(programPath => {
        rewrite(programPath, fail)
        for (const path of components(programPath)) {
            propsParameter(path)
            passRawProps(path)
            for (const statement of innerPath(path).node.body.body) {
                if (statement.slimState) statement.kind = "const"
            }
        }
        for (const path of hooks(programPath)) {
            for (const statement of path.node.body.body) {
                if (statement.slimState) statement.kind = "const"
            }
        }
        for (const statement of ast.program.body) {
            const declaration = statement.declaration ?? statement
            if (declaration.slimState) declaration.kind = "const"
        }
    })
    traverse.cache.clear()
    reset()

    ast.program.body.unshift(...templates)
}
