import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__nullable_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function runSlim(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const { code } = transform(source, path.join(root, "__nullable_tests__", `${name}.slim`), { check: false })
    const executable = code.replace(
        /^import\s+[^;]*(?:defaults|core)\.js";$/m,
        `import ${JSON.stringify(runtimeImport)};`
    )
    const outputFile = path.join(outputDir, `${name}.js`)
    writeFileSync(outputFile, executable)
    return spawnSync(process.execPath, ["--no-warnings", outputFile], { cwd: root, encoding: "utf8" })
}

test("a nullable variable accepts the base type and null", () => {
    const result = runSlim("nullable", `
        let x: int? = null
        log(x)
        x = 5
        log(x)
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /null\s+5/)
})

test("a nullable annotation still rejects an unrelated type", () => {
    const result = runSlim("nullable-bad", `let x: int? = "bad"`)
    assert.notEqual(result.status, 0)
})

test("nullable parameters accept null", () => {
    const result = runSlim("nullable-param", `
        func f(a: int?) { return a }
        log(f(null))
        log(f(3))
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /null\s+3/)
})

test("nullable types map to a JSDoc union with null and undefined", () => {
    const { code } = transform(`struct P { x: int? }`, "x.slim", { jsdoc: true })
    assert.match(code, /x: number \| null \| undefined/)
})
