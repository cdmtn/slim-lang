import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__diag_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function runSlim(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const sourceFile = path.join(root, "__diag_tests__", `${name}.slim`)
    const { code } = transform(source, sourceFile, { check: false })
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

test("struct field mismatch reports the offending value", () => {
    const result = runSlim("struct-preview", `
        struct User {
            name: string
            id: int
        }
        User.verify({ name: 5, id: 1 })
    `)

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /User\.name.*expected string, got int: 5/)
})

test("invalid reassignment reports the offending value", () => {
    const result = runSlim("reassign-preview", `
        let title: string = "Slim"
        title = 3
    `)

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /redefined with type int: 3/)
})

test("argument type error points at the call site, not the definition", () => {
    mkdirSync(outputDir, { recursive: true })
    const sourceFile = path.join(outputDir, "callsite.slim")
    const source = "func check(value: int) {\n    return value\n}\n\ncheck(\"bad\")\n"
    writeFileSync(sourceFile, source)
    const { code } = transform(source, sourceFile, { check: false })
    const executable = code.replace(
        /^import\s+[^;]*(?:defaults|core)\.js";$/m,
        `import ${JSON.stringify(runtimeImport)};`
    )
    const outputFile = path.join(outputDir, "callsite.js")
    writeFileSync(outputFile, executable)

    const result = spawnSync(
        process.execPath,
        ["--enable-source-maps", "--no-warnings", outputFile],
        { cwd: root, encoding: "utf8" }
    )

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /check\("bad"\)\s*\n\s*\^/)
})
