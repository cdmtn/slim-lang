import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__error_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function runSlim(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const { code } = transform(source, path.join(root, "__error_tests__", `${name}.slim`), { check: false })
    const executable = code.replace(
        /^import\s+[^;]*(?:defaults|core)\.js";$/m,
        `import ${JSON.stringify(runtimeImport)};`
    )
    const outputFile = path.join(outputDir, `${name}.js`)
    writeFileSync(outputFile, executable)
    return spawnSync(process.execPath, ["--no-warnings", outputFile], { cwd: root, encoding: "utf8" })
}

test("onError handles a top-level error without exiting the process", () => {
    const result = runSlim("handled", `
        onError((e) => { log("handled") })
        let n: int = 5
        n = "bad"
        log("unreachable")
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /handled/)
    assert.doesNotMatch(result.stdout, /unreachable/)
})

test("without a handler a top-level error still exits non-zero", () => {
    const result = runSlim("unhandled", `
        let n: int = 5
        n = "bad"
    `)
    assert.notEqual(result.status, 0)
})
