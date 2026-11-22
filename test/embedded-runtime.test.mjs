import assert from "node:assert/strict"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import vm from "node:vm"
import * as esbuild from "esbuild"
import { slim } from "../src/esbuild.js"
import { outputFolder } from "./output.mjs"

function project(files) {
    const dir = outputFolder(`__embedded_${Math.random().toString(36).slice(2)}__`)
    for (const [name, source] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
        writeFileSync(path.join(dir, name), source)
    }
    return dir
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

function runEmbedded(code) {
    const lines = []
    const sandbox = { console: { log: (...args) => lines.push(args.map(String).join(" ")) } }
    let thrown = null
    try {
        vm.runInNewContext(code, sandbox)
    } catch (error) {
        thrown = error
    }
    return { lines, thrown, sandbox }
}

async function withProject(files, body) {
    const dir = project(files)
    try {
        await body(dir)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

test("a load-time error reaches an engine without process as an uncaught exception", async () => {
    await withProject({
        "src/boot.slim": `log("boot")\nthrow new Error("broken load")\n`,
        "src/main.slim": `use {} from "./boot"\nlog("after")\n`
    }, async dir => {
        const { lines, thrown } = runEmbedded(await bundle(dir, "src/main.slim"))
        assert.equal(thrown?.message, "broken load")
        assert.equal(lines[0], "boot")
        assert.ok(lines.some(line => line.includes("broken load")), lines.join("\n"))
        assert.ok(!lines.includes("after"))
    })
})

test("onError still handles a load-time error without rethrowing", async () => {
    await withProject({
        "src/main.slim": `onError(error => log("handled", error.message))\nthrow new Error("broken load")\n`
    }, async dir => {
        const { lines, thrown } = runEmbedded(await bundle(dir, "src/main.slim"))
        assert.equal(thrown, null)
        assert.deepEqual(lines, ["handled broken load"])
    })
})

test("@slim/test assertions work in a host without process or timers", async () => {
    await withProject({
        "src/main.slim": [
            `use { deepEqual, assert, assertEqual, assertDeepEqual, assertThrows, mock } from @slim/test`,
            `log(deepEqual({ a: [1, 2] }, { a: [1, 2] }), deepEqual([1], [2]))`,
            `assert(true)`,
            `assertEqual(1 + 1, 2)`,
            `assertDeepEqual(new Map([[1, "a"]]), new Map([[1, "a"]]))`,
            `const error = assertThrows(() => assertDeepEqual({ a: 1 }, { a: 2 }))`,
            `log(error.message)`,
            `const fake = mock().returns(3)`,
            `log(fake(1), fake.calledWith(1))`
        ].join("\n")
    }, async dir => {
        const { lines, thrown, sandbox } = runEmbedded(await bundle(dir, "src/main.slim", { release: true }))
        assert.equal(thrown, null, thrown?.stack)
        assert.equal(sandbox.setTimeout, undefined)
        assert.deepEqual(lines, ["true false", `expected {"a":2}, got {"a":1}`, "3 true"])
    })
})

test("use {} from runs a module without spreading its exports onto globalThis", async () => {
    await withProject({
        "src/a.slim": `export const fromA = 1\nlog("a ran")\n`,
        "src/b.slim": `export const fromB = 2\nlog("b ran")\n`,
        "src/main.slim": `use {} from "./a"\nuse {} from "./b"\nlog("main", typeof fromA, typeof globalThis.fromB)\n`
    }, async dir => {
        const { lines, thrown } = runEmbedded(await bundle(dir, "src/main.slim"))
        assert.equal(thrown, null, thrown?.stack)
        assert.deepEqual(lines, ["a ran", "b ran", "main undefined undefined"])
    })
})
