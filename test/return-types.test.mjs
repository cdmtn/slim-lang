import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"

const root = process.cwd()
const outputDir = path.join(root, "dist", "__return_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function runSlim(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const { code } = transform(source, path.join(root, "__return_tests__", `${name}.slim`))
    const executable = code.replace(
        /^import\s+[^;]*(?:defaults|core)\.js";$/m,
        `import ${JSON.stringify(runtimeImport)};`
    )
    const outputFile = path.join(outputDir, `${name}.js`)
    writeFileSync(outputFile, executable)
    return spawnSync(process.execPath, ["--no-warnings", outputFile], { cwd: root, encoding: "utf8" })
}

test("a returned value that only exists at runtime is still checked", () => {
    const result = runSlim("runtime-return", `
        func parse(raw: string) -> int {
            return JSON.parse(raw).value
        }

        log(parse(\`{ "value": 7 }\`))

        try {
            parse(\`{ "value": "seven" }\`)
        } catch (e) {
            log(e.message)
        }
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^7$/m)
    assert.match(result.stdout, /function "parse" must return int, got string: "seven"/)
})

test("a nested function is not bound by the outer return type", () => {
    const result = runSlim("nested-return", `
        func outer(a: int) -> int {
            const inner = (x) => "a string"
            log(inner(1))
            return a
        }

        log(outer(3))
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /a string/)
    assert.match(result.stdout, /^3$/m)
})

test("release mode drops the return check", () => {
    mkdirSync(outputDir, { recursive: true })
    const { code } = transform(`
        func parse(raw: string) -> int {
            return JSON.parse(raw).value
        }

        log(parse(\`{ "value": "seven" }\`))
    `, path.join(root, "__return_tests__", "release.slim"), { release: true })

    const outputFile = path.join(outputDir, "release.js")
    writeFileSync(outputFile, code.replace(
        /^import\s+[^;]*(?:defaults|core)\.js";$/m,
        `import ${JSON.stringify(runtimeImport)};`
    ))

    const result = spawnSync(process.execPath, ["--no-warnings", outputFile], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env }
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /seven/)
})

test("generic containers validate what they hold", () => {
    const result = runSlim("generics", `
        const attempt = (label, fn) => {
            try { fn(); log(label + ": accepted") }
            catch (e) { log(label + ": rejected") }
        }

        attempt("array good", () => { let a: Array<int> = [1, 2] })
        attempt("array bad", () => { let a: Array<int> = JSON.parse(\`[1, "a"]\`) })
        attempt("set good", () => { let s: Set<string> = new Set(["a"]) })
        attempt("set bad", () => { let s: Set<string> = new Set([1]) })
        attempt("map good", () => { let m: Map<string, int> = new Map([["a", 1]]) })
        attempt("map bad", () => { let m: Map<string, int> = new Map([["a", "x"]]) })
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /array good: accepted/)
    assert.match(result.stdout, /array bad: rejected/)
    assert.match(result.stdout, /set good: accepted/)
    assert.match(result.stdout, /set bad: rejected/)
    assert.match(result.stdout, /map good: accepted/)
    assert.match(result.stdout, /map bad: rejected/)
})

test("a bare built-in class annotation is matched by constructor", () => {
    const result = runSlim("builtins", `
        let m: Map = new Map()
        let d: Date = new Date()
        log("ok")

        try {
            let bad: Date = JSON.parse(\`"nope"\`)
        } catch (e) {
            log("rejected")
        }
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /ok/)
    assert.match(result.stdout, /rejected/)
})
