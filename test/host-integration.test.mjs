import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { parse } from "@babel/parser"
import _traverse from "@babel/traverse"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const traverse = _traverse.default ?? _traverse
const root = process.cwd()
const outputDir = outputFolder("__host_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function messages(source, options = {}) {
    try {
        transform(source, "host.slim", options)
    } catch (error) {
        if (error.slimTypeErrors) return error.slimTypeErrors.map(diagnostic => diagnostic.message)
        throw error
    }
    return []
}

function run(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const file = path.join(outputDir, `${name}.js`)
    const { code } = transform(source, path.join(root, "__host_tests__", `${name}.slim`), { check: false, outFile: file })
    writeFileSync(file, code.replace(/^import\s+[^;]*(?:defaults|core)\.js";$/m, `import ${JSON.stringify(runtimeImport)};`))
    return spawnSync(process.execPath, ["--no-warnings", file], { cwd: root, encoding: "utf8" })
}

test("the runtime has no top-level await, so it bundles into a classic script", () => {
    const dir = path.join(root, "src", "external")
    for (const name of readdirSync(dir).filter(file => file.endsWith(".js"))) {
        const ast = parse(readFileSync(path.join(dir, name), "utf8"), { sourceType: "module" })
        traverse(ast, {
            AwaitExpression(path_) {
                assert.ok(path_.getFunctionParent(), `${name}:${path_.node.loc.start.line} awaits at the top level`)
            },
            ForOfStatement(path_) {
                if (path_.node.await) assert.ok(path_.getFunctionParent(), `${name}:${path_.node.loc.start.line} awaits at the top level`)
            }
        })
    }
})

test("names declared by the host are known to the checker", () => {
    const source = `const loadingOverlay = 1\nlog(LoadingOverlay, loadingOverlay)`
    assert.match(messages(source)[0] ?? "", /"LoadingOverlay" is not defined/)
    assert.deepEqual(messages(source, { globals: ["LoadingOverlay"] }), [])
})

test("a typo of a host name gets a suggestion", () => {
    assert.match(messages(`log(LoadingOverlya)`, { globals: ["LoadingOverlay"] })[0] ?? "", /did you mean "LoadingOverlay"/)
})

test("slimconfig globals reach the checker", () => {
    const dir = path.join(os.tmpdir(), `slim-globals-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    try {
        writeFileSync(path.join(dir, "index.slim"), `const emptyState = 1\nlog(EmptyState, emptyState)`)
        const compile = () => spawnSync(process.execPath, [path.join(root, "src", "compile.js")], { cwd: dir, encoding: "utf8" })

        writeFileSync(path.join(dir, "slimconfig.json"), `{ "main": "index" }`)
        assert.notEqual(compile().status, 0)

        writeFileSync(path.join(dir, "slimconfig.json"), `{ "main": "index", "globals": ["EmptyState"] }`)
        const built = compile()
        assert.equal(built.status, 0, built.stdout + built.stderr)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("markup on the line after return that starts with an interpolation", () => {
    const result = run("return-interpolation", `
        component Pair(props) {
            return
                \${props.left}
                <b>right</b>
        }

        component Single(props) {
            return
                \${props.text}
        }

        const text = node => node.nodeType == 11 ? [...node.childNodes].map(child => child.textContent).join("") : node.textContent
        log(text(Pair({ left: "left " })) + text(Single({ text: " single" })))
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "left right single")
})

test("return on its own line before plain code still returns nothing", () => {
    const result = run("return-plain", `
        func f() {
            return
            $(1)
        }
        log(f())
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "undefined")
})

test("flatMap over branches that return different arrays", () => {
    assert.deepEqual(messages(`func f(list) {
    const all = [...list].flatMap(e => e.leaf ? [e] : [...e.children])
    return all.find(o => o.classList.contains("active"))
}`), [])
    assert.match(messages(`const all = [1, 2].flatMap(n => n > 1 ? [n] : "x")\nlet s: bool = all[0]`)[0] ?? "", /expects bool, got \(int \| string\)/)
    assert.match(messages(`const all = [1, 2].flatMap(n => [n, n])\nlet s: string = all[0]`)[0] ?? "", /expects string, got int/)
})

test("browser APIs outside Node are known globals", () => {
    assert.deepEqual(messages(`const range = 1\nconst audioContext = 2\nlog(new Range(), new AudioContext(), range, audioContext)`), [])
})
