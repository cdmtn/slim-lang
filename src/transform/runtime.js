import _traverse from "@babel/traverse"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { distDir } from "../modulePaths.js"
import * as RUNTIME_DOM from "../external/runtime-dom.js"

const traverse = _traverse.default ?? _traverse

export function getRuntimePath(distFile, entry) {
    const runtimeAbs = path.resolve(distDir(), "external", entry)
    const rel = path.relative(path.dirname(distFile), runtimeAbs)
    if (path.isAbsolute(rel)) return pathToFileURL(runtimeAbs).href
    const relFixed = rel.replace(/\\/g, "/")
    return relFixed.startsWith(".") ? relFixed : "./" + relFixed
}

const DOM_RUNTIME = new Set([
    "htmlToVdom", "HTMLElement", "__html__",
    "__flush_events__", "__bind_events__", "__lifecycle__",
    "__create_host__", "__adopt_into__", "__define_element__", "__element_host__", "__element_life__", "__upgrade__",
    "__listener__", "upgrade", "render", "listen", "onRemove", "dispose", "setHtml",
    "__template__", "__insert__", "__once__", "__root__", "__list__", "__attr__", "__set__", "__on__", "__spread__", "__branch__", "__enter__", "__leave__", "__child__", "__next__", "__move__", "Portal", "__dynamic__", "__with_host__"
])

export function runtimeReferences(ast) {
    const names = new Set()
    traverse(ast, {
        Program(path_) {
            path_.scope.crawl()
        },
        ReferencedIdentifier(path_) {
            const { name } = path_.node
            if (name in RUNTIME_DOM && !path_.scope.getBinding(name)) names.add(name)
        }
    })
    return [...names].sort()
}

export const RENAMED_BUILTINS = { Option: "__Option__" }

export function renameBuiltins(ast, importedNames) {
    traverse(ast, {
        Program(path_) {
            path_.scope.crawl()
        },
        ReferencedIdentifier(path_) {
            const renamed = RENAMED_BUILTINS[path_.node.name]
            if (renamed && !path_.scope.getBinding(path_.node.name) && !importedNames.has(path_.node.name)) path_.node.name = renamed
        }
    })
}

export function usesDom(ast) {
    let found = false
    traverse(ast, {
        Program(path_) {
            path_.scope.crawl()
        },
        ReferencedIdentifier(path_) {
            const { name } = path_.node
            if (DOM_RUNTIME.has(name) && !path_.scope.getBinding(name)) {
                found = true
                path_.stop()
            }
        }
    })
    return found
}
