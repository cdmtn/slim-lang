import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"

const root = process.cwd()
const outputDir = path.join(root, "dist", "__tuple_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function runSlim(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const { code } = transform(source, path.join(root, "__tuple_tests__", `${name}.slim`))
    const executable = code.replace(
        /^import\s+[^;]*(?:defaults|core)\.js";$/m,
        `import ${JSON.stringify(runtimeImport)};`
    )
    const outputFile = path.join(outputDir, `${name}.js`)
    writeFileSync(outputFile, executable)
    return spawnSync(process.execPath, ["--no-warnings", outputFile], { cwd: root, encoding: "utf8" })
}

test("a tuple-typed value validates element types positionally", () => {
    const result = runSlim("valid", `
        let pair: [int, string] = [1, "a"]
        log(pair[0], pair[1])
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /1 a/)
})

test("a tuple rejects the wrong length or element types", () => {
    assert.notEqual(runSlim("bad-len", `let p: [int, string] = JSON.parse("[1]")`).status, 0)
    assert.notEqual(runSlim("bad-type", `let p: [int, string] = JSON.parse('["a", 1]')`).status, 0)
    assert.throws(() => runSlim("static-len", `let p: [int, string] = [1]`), /"p" expects \[int, string\], got \[int\]/)
})

test("tuple types work in parameters and struct fields", () => {
    const param = runSlim("param", `
        func add(p: [int, int]) { return p[0] + p[1] }
        log(add([3, 4]))
    `)
    assert.equal(param.status, 0, param.stderr)
    assert.match(param.stdout, /7/)

    const field = runSlim("field", `
        struct Point { coords: [int, int] }
        Point.verify({ coords: [1, 2] })
        log("ok")
    `)
    assert.equal(field.status, 0, field.stderr)
})

test("nested tuple types validate element by element", () => {
    const ok = runSlim("nested", `
        let t: [int, [int, string]] = [1, [2, "x"]]
        log(t[1][1])
    `)
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(ok.stdout, /x/)

    assert.notEqual(runSlim("nested-bad", `let t: [int, [int, string]] = [1, [2, 3]]`).status, 0)
})

test("tuple types map to a JSDoc tuple", () => {
    const { code } = transform(`struct Point { coords: [int, string] }`, "x.slim", { jsdoc: true })
    assert.match(code, /coords: \[number, string\]/)
})
