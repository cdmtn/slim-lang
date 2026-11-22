import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = process.cwd()
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))

test("package.json points at files that exist and are published", () => {
    const entries = [manifest.main, ...Object.values(manifest.bin), ...Object.values(manifest.exports).filter(entry => entry !== "./package.json")]
    for (const entry of entries) {
        assert.ok(existsSync(path.join(root, entry)), `${entry} does not exist`)
        assert.ok(manifest.files.some(file => path.normalize(entry).startsWith(path.normalize(file))), `${entry} is not in "files"`)
    }
})

test("the package entry compiles and formats Slim code", async () => {
    const slim = await import(pathToFileURL(path.join(root, manifest.main)).href)
    assert.deepEqual(Object.keys(slim).sort(), ["build", "formatSlim", "projectExports", "transform"])
    assert.match(slim.transform(`const n: int = 1\nlog(n)`, "entry.slim").code, /__typed_variable__/)
    assert.throws(() => slim.transform(`const n: int = "x"`, "entry.slim"), /"n" expects int, got string/)
    assert.equal(slim.formatSlim(`const n = 1\n`), `const n = 1\n`)
})

test("the package exposes its entry and the esbuild plugin, not its internals", async () => {
    const plugin = await import("@slim-lang/core/esbuild")
    assert.equal(typeof plugin.slim, "function")
    assert.equal(typeof plugin.check, "function")
    assert.equal(typeof (await import("@slim-lang/core")).transform, "function")
    await assert.rejects(import("@slim-lang/core/src/transform.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" })
})

test("importing the package entry starts no build", () => {
    const entry = pathToFileURL(path.join(root, manifest.main)).href
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(entry)})\nconsole.log("loaded")`], { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "loaded")
})
