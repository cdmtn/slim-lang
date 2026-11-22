import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__param_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function runSlim(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const sourceFile = path.join(root, "__param_tests__", `${name}.slim`)
    const { code } = transform(source, sourceFile)
    const executable = code.replace(
        /^import\s+[^;]*(?:defaults|core)\.js";$/m,
        `import ${JSON.stringify(runtimeImport)};`
    )
    const outputFile = path.join(outputDir, `${name}.js`)
    writeFileSync(outputFile, executable)

    return spawnSync(process.execPath, ["--no-warnings", outputFile], {
        cwd: root,
        encoding: "utf8"
    })
}

test("typed parameter default containing a call compiles and applies", () => {
    const result = runSlim("default-call", `
        func base() { return 9 }
        func withDefault(value: int = base()) { return value }
        log(withDefault())
        log(withDefault(3))
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /9\s+3/)
})

test("multiple typed parameters with a nested-call default validate", () => {
    const result = runSlim("default-nested", `
        func pick(a: int, b: int = Math.max(1, 2)) { return a + b }
        log(pick(10))
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /12/)
})

test("a generic type annotation does not split the parameter list at its comma", () => {
    const { code } = transform(`func f(m: Map<string, int>, n: int) { return n }`, "x.slim")
    assert.match(code, /function f\(m, n\)/)
})

test("a two-level nested call default compiles and evaluates", () => {
    const result = runSlim("two-level", `
        func inner() { return 4 }
        func wrap(x) { return x + 1 }
        func f(a = wrap(inner())) { return a }
        log(f())
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /5/)
})