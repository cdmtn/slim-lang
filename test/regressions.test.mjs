import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { findUses, preprocess } from "../src/syntax/index.js"
import { parseValue } from "../src/bin/helpers.js"
import { StructResultError, UseError } from "../src/external/classErrors.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__regression_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function compile(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const { code } = transform(source, path.join(root, "__regression_tests__", `${name}.slim`), {
        check: false,
        outFile: path.join(outputDir, `${name}.js`)
    })
    const executable = code.replace(/^import\s+[^;]*(?:defaults|core)\.js";$/m, `import ${JSON.stringify(runtimeImport)};`)
    const file = path.join(outputDir, `${name}.js`)
    writeFileSync(file, executable)
    return file
}

function run(file) {
    return spawnSync(process.execPath, ["--no-warnings", file], { cwd: root, encoding: "utf8" })
}

test("operator words still work as plain identifiers", () => {
    const result = run(compile("operator-names", `
        let empty = []
        const box = { empty: true, sizeof: 2 }
        func kindof(x) { return "own " + x }
        let lock = 1
        lock = 2
        log(empty empty, box.empty, box.sizeof, kindof(1), lock, sizeof [1, 2], !empty [1])
    `))
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "true true 2 own 1 2 2 true")
})

test("lock at the start of a line after another statement", () => {
    const result = run(compile("lock-line", `
        let n = 1
        lock const user = { info: { name: "Mike" } }
        try { user.info.name = "x" } catch (e) { log(e.message) }
    `))
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /locked object mutation/)
})

test("exports can reference top-level declarations of their module", () => {
    const lib = compile("exports-lib", `
        const PREFIX = "hi "
        const { a, b: [c] } = { a: 1, b: [2] }
        func helper(name) { return PREFIX + name }
        export const total: int = a + c
        export func greet(name: string) -> string { return helper(name) }
        class Box { value() { return total } }
        export { Box }
        export default PREFIX.trim()
    `)
    const main = path.join(outputDir, "exports-main.mjs")
    writeFileSync(main, `
        import fallback, { total, greet, Box } from ${JSON.stringify(pathToFileURL(lib).href)}
        console.log(fallback, total, greet("bob"), new Box().value())
    `)

    const result = run(main)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "hi 3 hi bob 3")
})

test("a brace inside a string does not end a component body", () => {
    const { code } = transform(`
component Label() {
    const close = "}"
    return <span>{close}</span>
}
`, path.join(root, "label.slim"), { check: false })
    assert.match(code, /const close = "}"/)
})

test("an unclosed component reports an error instead of hanging", () => {
    assert.throws(() => transform(`component Broken() {\n    return <div></div>\n`, "broken.slim"), /end of file/)
})

test("keywords inside strings are left alone", () => {
    const { code } = transform(`log("type Foo = int", "use x from 'y'", "a } elif (b")`, "strings.slim", { check: false })
    assert.match(code, /"type Foo = int", "use x from 'y'", "a } elif \(b"/)
})

test("method chains continue on the next line, a | line is a bitwise OR", () => {
    const result = run(compile("chains", `
const words = ["a", "bb", "ccc"]
const lengths = words
    .map(w => w.length)
    .filter(n => Math.max(n, 2) > 2)
log(lengths)
const flags = 1
    | 2
log(flags)
`))
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "[ 3 ]\n3")
})

test("findUses reads every form of use", () => {
    const uses = findUses(`
use { a, b as c } from "./lib"
use path from "node:path"
use * as fs from "node:fs"
use x as y from "./x";
use { Server } from @slim/server
use @slim/time
use "./side"
const use = 1
`)
    assert.deepEqual(uses.map(({ spec, source }) => [spec, source]), [
        ["{ a, b as c }", "./lib"],
        ["path", "node:path"],
        ["* as fs", "node:fs"],
        ["x as y", "./x"],
        ["{ Server }", "@slim/server"],
        [null, "@slim/time"],
        [null, "./side"]
    ])
})

test("entry files compiled outside getDistPath import the runtime relative to their real location", () => {
    const { code } = transform("log(1)", path.join(root, "src", "app.slim"), {
        check: false,
        outFile: path.join(root, "slim-dist", "src", "app.js")
    })
    assert.match(code, /^import "\.\.\/external\/core\.js";/)
})

test("a slash on the next line is division, numbers keep their spelling", () => {
    assert.match(preprocess("a = b\n/ 2").code, /a = b \/ 2/)
    assert.match(preprocess("x = 0x1F + 1_000 + .5e-3 + 10n").code, /0x1F \+ 1_000 \+ \.5e-3 \+ 10n/)
})

test("config values parse numbers and booleans but keep empty strings", () => {
    assert.equal(parseValue("true"), true)
    assert.equal(parseValue("-1.5"), -1.5)
    assert.equal(parseValue(""), "")
    assert.equal(parseValue("-"), "-")
    assert.equal(parseValue("index"), "index")
})

test("error classes keep their own tag", () => {
    assert.equal(new StructResultError("x").tag, "StructResultError")
    assert.equal(new UseError("x").name, "UseError")
    assert.equal(new UseError("x").message, "x")
})

test("a value that may be undefined is a warning with its place and hint, not a build error", () => {
    const source = `struct Svc { serviceList: string[] }
let selected = { serviceList: ["x"] }
func pick(list: Svc[], id: int) {
    const s = list.find((x, i) => i == id)
    selected.serviceList = s.serviceList
    const kept: Svc = list.find(x => x.serviceList.length > 0)
    log(kept)
}
`
    const { code, warnings } = transform(source, "topbar.slim")
    assert.ok(code.length > 0)
    const access = warnings.find(warning => /"s" may be undefined here \(Svc \| undefined\) — check it first or use "\?\."/.test(warning.message))
    assert.ok(access, JSON.stringify(warnings))
    assert.equal(access.severity, "warning")
    assert.equal(access.line, 5)
    assert.equal(access.column, 28)
    assert.equal(access.sourceLine.trim(), "selected.serviceList = s.serviceList")
    assert.ok(warnings.some(warning => /"kept" expects Svc, got \(Svc \| undefined\) — check it for undefined first/.test(warning.message)), JSON.stringify(warnings))

    assert.deepEqual(transform(source, "topbar.slim", { warnings: false }).warnings, [])
    assert.throws(() => transform(`let u = undefined\nlog(u.x)\n`, "x.slim"), /"u" is undefined here, so it has no properties/)
})

test("enum stays a type: type enum gets a clear message and .d.ts and JSDoc write it as any", () => {
    assert.throws(() => transform(`type enum(v) {\n    return true\n}\n`, "x.slim"), /"enum" is a reserved word and can't name a type — "enum" already is one/)

    const source = `export enum Role { A, B }\nexport struct Item { kind?: enum\n tags: enum[] }\nexport func pick(x: enum) -> enum { return x }\n`
    const { code, declarations } = transform(source, "x.slim", { declarations: true, jsdoc: true })
    assert.doesNotMatch(declarations, /\benum\b/)
    assert.match(declarations, /kind\?: any; tags: any\[\]/)
    assert.match(declarations, /pick\(x: any\): any/)
    assert.doesNotMatch(code.split("\n").filter(line => /@typedef|@param|@returns/.test(line)).join("\n"), /\benum\b/)
})
