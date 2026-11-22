import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__intersection_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function runSlim(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const { code } = transform(source, path.join(root, "__intersection_tests__", `${name}.slim`))
    const executable = code.replace(
        /^import\s+[^;]*(?:defaults|core)\.js";$/m,
        `import ${JSON.stringify(runtimeImport)};`
    )
    const outputFile = path.join(outputDir, `${name}.js`)
    writeFileSync(outputFile, executable)
    return spawnSync(process.execPath, ["--no-warnings", outputFile], { cwd: root, encoding: "utf8" })
}

test("an intersection type lowers to the all-combinator", () => {
    const { code } = transform(`type Positive(v) { return v > 0 }
type Even(v) { return v % 2 == 0 }
let n: Positive & Even = 4`, "x.slim")
    assert.match(code, /__type_spec_all__/)
})

test("a value satisfying every member of an intersection passes", () => {
    const result = runSlim("valid", `
        type Positive(v) { return v > 0 }
        type Even(v) { return v % 2 == 0 }
        let n: Positive & Even = 4
        log(n)
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /4/)
})

test("a value missing one member of an intersection is rejected", () => {
    const result = runSlim("invalid", `
        type Positive(v) { return v > 0 }
        type Even(v) { return v % 2 == 0 }
        let m: Positive & Even = 3
    `)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Positive & Even/)
})
