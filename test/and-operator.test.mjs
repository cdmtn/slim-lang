import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { preprocess } from "../src/syntax/index.js"

const root = process.cwd()
const outputDir = path.join(root, "dist", "__and_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function runSlim(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const sourceFile = path.join(root, "__and_tests__", `${name}.slim`)
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

test("`and` lowers to `&&` while leaving strings untouched", () => {
    const { code } = preprocess(`const x = a and b\nconst s = "a and b"`, "x.slim")
    assert.match(code, /a && b/)
    assert.match(code, /"a and b"/)
})

test("`and` respects word boundaries", () => {
    const { code } = preprocess(`const android = 1`, "x.slim")
    assert.match(code, /const android = 1/)
})

test("`and` and `or` evaluate together at runtime", () => {
    const result = runSlim("and-or", `
        log(true and false)
        log(true and true)
        log(false or true)
        log(true and false or true)
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /false\s+true\s+true\s+true/)
})
