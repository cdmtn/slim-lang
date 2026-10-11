// Deterministic .slim fixture generators. Committed files in bench/fixtures/ are
// produced by `node bench/fixtures/generate.js`; sizes not on disk are generated in memory.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))

// Declaration k is a struct, enum or typed function (round robin), so N means N declarations.
export function genDecls(count) {
    const out = []
    for (let k = 0; k < count; k++) {
        if (k % 3 === 0) out.push(`struct S${k} {\n    name: string\n    id: int\n}\n`)
        else if (k % 3 === 1) out.push(`enum E${k} {\n    A: 0\n    B: 1\n}\n`)
        else out.push(`func f${k}(x: int) -> int {\n    let y: int = x + ${k}\n    return match (y) { 0 => 1, _ => y }\n}\n`)
    }
    return out.join("\n")
}

// Nested blocks, object literals and arrays `depth` levels deep.
export function genDeep(depth = 40) {
    let body = "return x"
    for (let d = 0; d < depth; d++) body = `if (x > ${d}) {\n${body}\n} else { return [${d}, { v: ${d} }] }`
    let literal = "1"
    for (let d = 0; d < depth; d++) literal = `{ level${d}: [${literal}] }`
    return `func deep(x: int) {\n${body}\n}\nconst nested = ${literal}\n`
}

// Many structs, enums and match expressions in one file.
export function genManyTypes(structs = 150, enums = 100) {
    const out = []
    for (let k = 0; k < structs; k++) {
        out.push(`struct T${k} {\n    name: string\n    id: int\n    tags: string[]\n}\n`)
    }
    for (let k = 0; k < enums; k++) {
        out.push(`enum K${k} {\n    A: 0\n    B: 1\n    C: 2\n}\n`)
        out.push(`func pick${k}(v) {\n    return match (v) { K${k}.A => "a", K${k}.B => "b", _ => "c" }\n}\n`)
    }
    return out.join("\n")
}

// File i exports one struct and imports the struct of file i+1 (a dependency chain).
export function genGraph(count) {
    const files = {}
    for (let i = 0; i < count; i++) {
        const last = i === count - 1
        const dep = last ? "" : `use { M${i + 1} } from "./m${i + 1}"\n\n`
        const field = last ? "" : `    next: M${i + 1}\n`
        files[`m${i}.slim`] = `${dep}export struct M${i} {\n    id: int\n${field}}\n`
    }
    return files
}

// Source of a fixture by logical name, from disk when present.
export function fixtureSource(name) {
    const file = path.join(here, `${name}.slim`)
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8")
    const decls = /^decls-(\d+)$/.exec(name)
    if (decls) return genDecls(Number(decls[1]))
    if (name === "deep") return genDeep()
    if (name === "many-types") return genManyTypes()
    throw new Error(`unknown fixture ${name}`)
}

export const COMMITTED = {
    "decls-1": () => genDecls(1),
    "decls-10": () => genDecls(10),
    "decls-100": () => genDecls(100),
    "decls-1000": () => genDecls(1000),
    deep: () => genDeep(),
    "many-types": () => genManyTypes()
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    for (const [name, make] of Object.entries(COMMITTED)) {
        fs.writeFileSync(path.join(here, `${name}.slim`), make())
    }
    console.log(`wrote ${Object.keys(COMMITTED).length} fixtures`)
}
