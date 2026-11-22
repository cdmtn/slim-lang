import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import * as esbuild from "esbuild"
import { slim, check, slimFiles, runtimeDir } from "../src/esbuild.js"
import { outputFolder } from "./output.mjs"

function project(files) {
    const dir = outputFolder(`__esbuild_${Math.random().toString(36).slice(2)}__`)
    for (const [name, source] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
        writeFileSync(path.join(dir, name), source)
    }
    return dir
}

async function bundle(dir, entry, options = {}) {
    const outfile = path.join(dir, "out", "bundle.mjs")
    const result = await esbuild.build({
        entryPoints: [path.join(dir, entry)],
        outfile,
        bundle: true,
        format: "esm",
        platform: "node",
        logLevel: "silent",
        metafile: true,
        plugins: [slim({ root: dir, ...options })]
    })
    return { outfile, result }
}

function run(file) {
    const ran = spawnSync(process.execPath, ["--no-warnings", file], { encoding: "utf8" })
    return { status: ran.status, output: ran.stdout.trim(), errors: ran.stderr }
}

const FILES = {
    "packages/mathkit/main.slim": `export func twice(n: number) -> number {\n    return n * 2\n}\n`,
    "src/models/point.slim": `export struct Point {\n    x: number\n    y: number\n}\n`,
    "src/main.slim": `use { twice } from "@mathkit"\nuse { Point } from "./models/point"\nuse { createForm } from "@slim/forms"\n\nconst point = Point.new({ x: 2, y: 3 })\nlog(twice(point.x) + point.y, typeof createForm)\n`
}

test("bundles a project from its root, with packages, folders and core modules", async () => {
    const dir = project(FILES)
    try {
        const { outfile, result } = await bundle(dir, "src/main.slim")
        const ran = run(outfile)
        assert.equal(ran.status, 0, ran.errors)
        assert.equal(ran.output, "7 function")
        assert.equal(existsSync(path.join(dir, "slim-dist")), false)
        const runtimes = Object.keys(result.metafile.inputs).map(file => path.resolve(file)).filter(file => file.startsWith(runtimeDir + path.sep) && /runtime-core\.js$/.test(file))
        assert.equal(runtimes.length, 1)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("checks types across files whatever their order", async () => {
    const dir = project({
        ...FILES,
        "src/a.slim": `use { half } from "./z"\nexport const wrong = half("x")\n`,
        "src/z.slim": `export func half(n: number) -> number {\n    return n / 2\n}\n`
    })
    try {
        await assert.rejects(bundle(dir, "src/main.slim"), error => error.errors.some(item => /twice|number|string/.test(item.text)))
        const errors = check({ root: dir })
        assert.equal(errors.length, 1)
        assert.match(errors[0], /a\.slim/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("check: false leaves type errors to the caller", async () => {
    const dir = project({ ...FILES, "src/main.slim": `use { twice } from "@mathkit"\nlog(twice(4))\n`, "src/a.slim": `use { twice } from "@mathkit"\nexport const wrong = twice("x")\n` })
    try {
        const { outfile } = await bundle(dir, "src/main.slim", { check: false })
        assert.equal(run(outfile).output, "8")
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("auto-imports project exports when asked", async () => {
    const dir = project({
        "src/lib/greet.slim": `export func greet(name: string) -> string {\n    return "Hi " + name\n}\n`,
        "src/main.slim": `log(greet("Ada"))\n`
    })
    try {
        const { outfile } = await bundle(dir, "src/main.slim", { autoImport: true })
        assert.equal(run(outfile).output, "Hi Ada")
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("finds the project's files, skipping node_modules and the dist folder", () => {
    const dir = project({
        "a.slim": "log(1)\n",
        "src/b.slim": "log(2)\n",
        "node_modules/x/c.slim": "log(3)\n",
        "slim-dist/d.slim": "log(4)\n",
        ".hidden/e.slim": "log(5)\n"
    })
    try {
        check({ root: dir })
        assert.deepEqual(slimFiles().map(file => path.relative(dir, file).replace(/\\/g, "/")).sort(), ["a.slim", "src/b.slim"])
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
