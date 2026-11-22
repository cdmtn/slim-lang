import _generate from "@babel/generator"
import { parseSlim } from "./plugin.js"
import { lowerSlim } from "./lower.js"

const generate = _generate.default ?? _generate

export function parseProgram(code, sourceFile = "input.slim", options = {}) {
    return lowerSlim(parseSlim(code, sourceFile), code, sourceFile, options)
}

export function preprocess(code, sourceFile = "input.slim", options = {}) {
    return { code: generate(parseProgram(code, sourceFile, options)).code }
}

function collectUses(node, uses) {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) return node.forEach(child => collectUses(child, uses))
    if (node.type === "SlimUseDeclaration") {
        uses.push({ spec: node.specifier, source: node.source, start: node.start, end: node.end })
        return
    }
    if ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node.source?.value.startsWith(".")) {
        uses.push({ spec: null, source: node.source.value.replace(/\.js$/, ""), start: node.start, end: node.end })
    }
    if (node.type === "ImportDeclaration" && node.specifiers.length === 0 && node.source.value.startsWith(".")) {
        uses.push({ spec: null, source: node.source.value.replace(/\.js$/, ""), start: node.start, end: node.end, plainImport: true })
    }
    for (const [key, value] of Object.entries(node)) {
        if (key !== "loc" && key !== "extra" && value && typeof value === "object") collectUses(value, uses)
    }
}

export function findUses(code) {
    let ast
    try {
        ast = parseSlim(code)
    } catch {
        return []
    }
    const uses = []
    collectUses(ast.program, uses)
    return uses
}

export { parseSlim }
