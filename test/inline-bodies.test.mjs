import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__inline_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function runSlim(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const sourceFile = path.join(root, "__inline_tests__", `${name}.slim`)
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

test("single-line func body keeps a typed parameter check separate from the body", () => {
    const result = runSlim("inline-func", `
        func double(value: int) { return value * 2 }
        log(double(5))
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /10/)
})

test("single-line func body still rejects an argument of the wrong type", () => {
    const result = runSlim("inline-func-bad", `
        func double(value: int) { return value * 2 }
        log(double("nope"))
    `)

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /value.*expected int/)
})

test("single-line static method body validates its typed parameter", () => {
    const result = runSlim("inline-static", `
        class Counter {
            static make(start: int) { return start + 1 }
        }
        log(Counter.make(4))
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /5/)
})

test("single-line body with a typed defaulted parameter uses the default", () => {
    const result = runSlim("inline-default", `
        func withDefault(value: int = 7) { return value }
        log(withDefault())
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /7/)
})

test("single-line arrow block body validates its typed parameter", () => {
    const result = runSlim("inline-arrow", `
        const triple = (value: int) => { return value * 3 }
        log(triple(3))
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /9/)
})

test("method sharing a line with its class brace validates its typed parameter", () => {
    const valid = runSlim("inline-method", `
        class Greeter { hello(name: string) { return name } }
        log(new Greeter().hello("world"))
    `)
    assert.equal(valid.status, 0, valid.stderr)
    assert.match(valid.stdout, /world/)

    const invalid = runSlim("inline-method-bad", `
        class Greeter { hello(name: string) { return name } }
        new Greeter().hello(123)
    `)
    assert.notEqual(invalid.status, 0)
    assert.match(invalid.stderr, /name.*expected string/)
})

test("inline async method sharing a line with its class brace keeps its typed check", () => {
    const result = runSlim("inline-async-method", `
        class Loader { async load(id: int) { return id } }
        new Loader().load(3).then(value => log(value))
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /3/)
})
