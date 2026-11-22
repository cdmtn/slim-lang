import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__release_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function compile(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const sourceFile = path.join(root, "__release_tests__", `${name}.slim`)
    const { code } = transform(source, sourceFile, { check: false })
    const executable = code.replace(
        /^import\s+[^;]*(?:defaults|core)\.js";$/m,
        `import ${JSON.stringify(runtimeImport)};`
    )
    const outputFile = path.join(outputDir, `${name}.js`)
    writeFileSync(outputFile, executable)
    return outputFile
}

function run(outputFile, release) {
    return spawnSync(process.execPath, ["--no-warnings", outputFile], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, SLIM_RELEASE: release ? "1" : "0" }
    })
}

test("release mode skips implicit type checks that fail in dev mode", () => {
    const file = compile("release-arg", `
        func identity(value: int) { return value }
        log(identity("nope"))
    `)

    assert.notEqual(run(file, false).status, 0)

    const released = run(file, true)
    assert.equal(released.status, 0, released.stderr)
    assert.match(released.stdout, /nope/)
})

test("release mode keeps explicit struct verification", () => {
    const file = compile("release-verify", `
        struct User { name: string }
        log(User.verifySafe({ name: 5 }).success)
    `)

    const released = run(file, true)
    assert.equal(released.status, 0, released.stderr)
    assert.match(released.stdout, /false/)
})
