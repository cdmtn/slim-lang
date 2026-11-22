import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__runtime_imports__")

function compile(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const file = path.join(outputDir, `${name}.js`)
    const { code } = transform(source, path.join(root, "__runtime_imports__", `${name}.slim`), { runtime: "imports", check: false, outFile: file })
    return { file, code }
}

function run(name, source) {
    const { file, code } = compile(name, source)
    const runtime = name => pathToFileURL(path.join(root, "src", "external", name)).href
    writeFileSync(file, code.replace(/"[^"]*external\/(runtime-(?:dom|core)\.js)"/, (_, name) => JSON.stringify(runtime(name))))
    return spawnSync(process.execPath, ["--no-warnings", file], { cwd: root, encoding: "utf8" })
}

test("the runtime comes in by name and leaves globalThis alone", () => {
    const result = run("named", `
        struct User { name: string }
        component Badge(props) {
            return <b>\${props.text}</b>
        }
        log(User.new({ name: "Ada" }).name, Badge({ text: "x" }).outerHTML, typeof globalThis.log, typeof globalThis.__insert__, typeof globalThis.raw)
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "Ada <b>x</b> undefined undefined undefined")
})

test("a file without components imports from the core runtime", () => {
    const { code } = compile("core-only", `func twice(n: int) -> int { return n * 2 }\nlog(twice(2))`)
    assert.match(code, /^import \{[^}]*\blog\b[^}]*\} from "[^"]*external\/runtime-core\.js";/)
    assert.doesNotMatch(code, /runtime-dom\.js/)
})

test("names a file declares itself are not imported", () => {
    const { code } = compile("shadowed", `const log = (...args) => console.log("own", ...args)\nlog(1)`)
    assert.doesNotMatch(code.split("\n")[0], /\blog\b/)
})

test("typed values, state and errors still work", () => {
    const result = run("typed", `
        component Counter() {
            state count: int = 1
            return <i>\${count}</i>
        }
        let n: int = 1
        try { n = "x" } catch (e) { log("rejected") }
        log(Counter().textContent)
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "rejected\n1")
})
