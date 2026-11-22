import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__helper_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href
const testing = pathToFileURL(path.join(root, "src", "external", "testing.js")).href

function runSlim(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const { code } = transform(source, path.join(root, "__helper_tests__", `${name}.slim`), { test: true })
    const executable = code.replace(
        /^import\s+[^;]*(?:defaults|core)\.js";$/m,
        `import ${JSON.stringify(runtimeImport)};\nimport ${JSON.stringify(testing)};`
    )
    const outputFile = path.join(outputDir, `${name}.js`)
    writeFileSync(outputFile, executable)
    return spawnSync(process.execPath, ["--no-warnings", outputFile], { cwd: root, encoding: "utf8" })
}

test("test/assert helpers report passes and failures with a summary", () => {
    const result = runSlim("helpers", `
        test("passes", () => { assert(1 + 1 == 2) })
        test("also passes", () => { assertEqual(sizeof [1, 2, 3], 3) })
        test("fails", () => { assertEqual(2, 3) })
    `)

    assert.notEqual(result.status, 0)
    assert.match(result.stdout, /✓ passes/)
    assert.match(result.stdout, /✗ fails/)
    assert.match(result.stdout, /2 passed, 1 failed/)
})

test("a test file that only passes exits zero", () => {
    const result = runSlim("all-pass", `
        test("ok", () => { assert(true) })
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /1 passed, 0 failed/)
})
