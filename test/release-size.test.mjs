import assert from "node:assert/strict"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import vm from "node:vm"
import * as esbuild from "esbuild"
import { slim } from "../src/esbuild.js"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const TYPES = [
    `export trait Vec { x: number }`,
    `export trait Engine { spawn: (at: Vec) => undefined }`,
    `export trait Unused { y: string }`
].join("\n")

function project(files) {
    const dir = outputFolder(`__release_size_${Math.random().toString(36).slice(2)}__`)
    for (const [name, source] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
        writeFileSync(path.join(dir, name), source)
    }
    return dir
}

async function withProject(files, body) {
    const dir = project(files)
    try {
        await body(dir)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

async function bundle(dir, entry, options = {}) {
    const result = await esbuild.build({
        entryPoints: [path.join(dir, entry)],
        bundle: true,
        write: false,
        format: "iife",
        platform: "neutral",
        mainFields: ["module", "main"],
        logLevel: "silent",
        plugins: [slim({ root: dir, ...options })]
    })
    return result.outputFiles[0].text
}

function runEmbedded(code, globals = {}) {
    const lines = []
    vm.runInNewContext(code, { console: { log: (...args) => lines.push(args.map(String).join(" ")) }, ...globals })
    return lines
}

const HOSTED = {
    "types.slim": TYPES,
    "host.slim": `use { Vec, Engine } from "./types"\nglobal engine: Engine\n`,
    "noisy.slim": `use { Vec, Engine } from "./types"\nglobal engine: Engine\nconsole.log("host ran")\n`,
    "src/plain.slim": `engine.spawn({ x: 1 })\nlog("plain")\n`,
    "src/typed.slim": `func place(at: Vec) { engine.spawn(at) }\nplace({ x: 2 })\n`
}

test("a host that only declares adds no import, and named host types are imported where they're used", async () => {
    await withProject(HOSTED, async dir => {
        const host = path.join(dir, "host.slim")
        const source = name => [`${HOSTED[name]}`, path.join(dir, name)]
        transform(...source("types.slim"), { sourceMaps: false })
        const plain = transform(...source("src/plain.slim"), { host, sourceMaps: false }).code
        assert.doesNotMatch(plain, /host\.js|types\.js/)
        const typed = transform(...source("src/typed.slim"), { host, sourceMaps: false }).code
        assert.match(typed, /import \{ Vec \} from "[^"]*types\.js"/)
        assert.doesNotMatch(typed, /host\.js/)
        const released = transform(...source("src/typed.slim"), { host, sourceMaps: false, release: true }).code
        assert.doesNotMatch(released, /types\.js|host\.js/)
        const noisy = transform(...source("src/plain.slim"), { host: path.join(dir, "noisy.slim"), sourceMaps: false }).code
        assert.match(noisy, /import "[^"]*noisy\.js"/)
    })
})

test("a release bundle of a mod carries no host traits it doesn't use", async () => {
    await withProject(HOSTED, async dir => {
        const host = path.join(dir, "host.slim")
        const spawned = []
        const engine = { spawn: at => spawned.push(at.x) }
        const plain = await bundle(dir, "src/plain.slim", { host, release: true })
        assert.doesNotMatch(plain, /__def_trait__\(/)
        assert.deepEqual(runEmbedded(plain, { engine }), ["plain"])
        const dev = await bundle(dir, "src/typed.slim", { host })
        assert.match(dev, /__def_trait__\("Vec"/)
        runEmbedded(dev, { engine })
        assert.deepEqual(spawned, [1, 2])
    })
})

test("release keeps only the traits that are used by name, with the traits they mention", async () => {
    await withProject({
        "src/shapes.slim": [
            `export trait Pos { x: number }`,
            `export trait Unused { y: string }`,
            `export trait Named { name: string, pos: Pos }`
        ].join("\n"),
        "src/main.slim": [
            `use { Named } from "./shapes"`,
            `func kind(v: any) -> string {`,
            `    return match (v) { Named n => "named", _ => "other" }`,
            `}`,
            `log(kind({ name: "a", pos: { x: 1 } }), kind({ name: "a", pos: { x: "no" } }), kind(5))`
        ].join("\n")
    }, async dir => {
        const code = await bundle(dir, "src/main.slim", { release: true })
        assert.match(code, /__def_trait__\("Named"/)
        assert.match(code, /__def_trait__\("Pos"/)
        assert.doesNotMatch(code, /Unused/)
        assert.deepEqual(runEmbedded(code), ["named other other"])
    })
})

test("release definitions of exported traits are pure and sit outside the try block", () => {
    const { code } = transform(`export trait A { x: int }\nexport func f() -> int { return 1 }\nlog(f())`, "pure.slim", { sourceMaps: false, release: true })
    const definition = code.indexOf(`/*#__PURE__*/__def_trait__("A"`)
    assert.ok(definition !== -1, code)
    assert.ok(definition < code.indexOf("try {"), code)
    const dev = transform(`export trait A { x: int }\nlog(1)`, "pure-dev.slim", { sourceMaps: false }).code
    assert.doesNotMatch(dev, /__PURE__/)
})

test("release drops __as_struct__ when the type holds no struct", () => {
    const source = [
        `struct P { x: int }`,
        `trait T { y: int }`,
        `let r: Record<string, int> = {}`,
        `r = { a: 1 }`,
        `let t: T = { y: 1 }`,
        `t = { y: 2 }`,
        `let p: P = P.new({ x: 1 })`,
        `p = { x: 2 }`,
        `let ps: P[] = []`,
        `ps = [{ x: 3 }]`,
        `log(r, t, p, ps)`
    ].join("\n")
    const { code } = transform(source, "casts.slim", { sourceMaps: false, release: true })
    assert.doesNotMatch(code, /__as_struct__\([^)]*"(?:Record<string, int>|T)"\)/)
    assert.match(code, /__as_struct__\(\{\s*x: 2\s*\}, "P"\)/)
    assert.match(code, /__as_struct__\(\[\{\s*x: 3\s*\}\], "P\[\]"\)/)
    const unchecked = transform(source, "casts-unchecked.slim", { sourceMaps: false, release: true, check: false }).code
    assert.doesNotMatch(unchecked, /"Record<string, int>"/)
    assert.match(unchecked, /__as_struct__\(\{\s*x: 2\s*\}, "P"\)/)
})

test("release compiles a component that exposes methods over its state", () => {
    const source = [
        "trait Person { id: int }",
        "export component Members() {",
        "    state people: Person[] = []",
        "    expose({",
        "        get people() { return people },",
        "        set(list) { people = list },",
        "        person(id) { return people.find((p) => p.id == id) ?? null }",
        "    })",
        "    return <div>${people.map(p => <p key=${p.id}>${p.id}</p>)}</div>",
        "}"
    ].join("\n")
    const { code } = transform(source, "exposed.slim", { sourceMaps: false, release: true, warnings: false })
    assert.match(code, /Members/)
})
