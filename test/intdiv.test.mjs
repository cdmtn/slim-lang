import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { preprocess } from "../src/parser.js"

const root = process.cwd()
const outputDir = path.join(root, "dist", "__intdiv_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function runSlim(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const sourceFile = path.join(root, "__intdiv_tests__", `${name}.slim`)
    const { code } = transform(source, sourceFile)
    const executable = code.replace(
        /^import\s+[^;]*defaults\.js";$/m,
        `import ${JSON.stringify(runtimeImport)};`
    )
    const outputFile = path.join(outputDir, `${name}.js`)
    writeFileSync(outputFile, executable)

    return spawnSync(process.execPath, ["--no-warnings", outputFile], {
        cwd: root,
        encoding: "utf8"
    })
}

test("`~/` after `return` compiles to valid JS and integer-divides", () => {
    const result = runSlim("return-intdiv", `
        func divide(a, b) {
            return a ~/ b
        }

        log(divide(20, 3), divide(7, 2))
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /6 3/)
})

test("nested `~/` associates right and evaluates correctly", () => {
    const result = runSlim("nested-intdiv", `
        log(100 ~/ 5 ~/ 3)
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /100/)
})

test("`return a ~/ b` lowers without swallowing the `return` keyword", () => {
    const { code } = preprocess("func f() { return a ~/ b }", "x.slim")
    assert.match(code, /return __intdiv__\(a, b\)/)
    assert.doesNotMatch(code, /__intdiv__\(return/)
})

test("unary prefix operators stay inside the left operand", () => {
    const typeofCase = preprocess("const x = typeof a ~/ b", "x.slim").code
    assert.match(typeofCase, /__intdiv__\(typeof a, b\)/)

    const awaitCase = preprocess("const x = await a ~/ b", "x.slim").code
    assert.match(awaitCase, /__intdiv__\(await a, b\)/)
})
