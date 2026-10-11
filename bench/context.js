// Setup helpers handed to every case. Module loading and compilation live here,
// so they never fall inside a measured region.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { ROOT } from "./env.js"
import { fixtureSource } from "./fixtures/generate.js"

export const FIXTURES = path.join(ROOT, "bench", "fixtures")
const RUNTIME_IMPORT = /^import\s+"[^"]*(?:defaults|core)\.js";$/m

export function makeContext(mode) {
    const tmp = path.join(os.tmpdir(), `slim-bench-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
    fs.mkdirSync(tmp, { recursive: true })
    const ctx = {
        mode,
        tmp,
        root: ROOT,
        // Dynamic import of a compiler/runtime module by repo-relative path.
        src: rel => import(pathToFileURL(path.join(ROOT, rel)).href),
        fixture: fixtureSource,
        fixturePath: name => path.join(FIXTURES, `${name}.slim`),
        // Source that must run inside Slim's own transform (never stub the compiler).
        async compile(source, file, options = {}) {
            const { transform } = await ctx.src("src/transform.js")
            return transform(source, file, options)
        },
        // Compile Slim source to a runnable ES module in tmp and import it.
        // The runtime import is pinned to this checkout's src/external.
        async build(name, source, options = { check: true }) {
            const { code } = await ctx.compile(source, path.join(FIXTURES, `${name}.slim`), { ...options, release: mode === "release" })
            const runtime = code.match(RUNTIME_IMPORT)?.[0]
            if (!runtime) throw new Error(`no runtime import in compiled ${name}`)
            const file = /defaults\.js/.test(runtime) ? "defaults.js" : "core.js"
            const target = pathToFileURL(path.join(ROOT, "src", "external", file)).href
            const out = path.join(tmp, `${name}.mjs`)
            fs.writeFileSync(out, code.replace(RUNTIME_IMPORT, `import ${JSON.stringify(target)};`))
            return { file: out, code }
        },
        async load(name, source, options) {
            const built = await ctx.build(name, source, options)
            return { ...built, module: await import(pathToFileURL(built.file).href) }
        },
        cleanup() { fs.rmSync(tmp, { recursive: true, force: true }) }
    }
    return ctx
}

// Compiler entry points can call process.exit/console.error on user errors.
// Convert that into an exception so a broken fixture becomes a failure row.
export function guardExit(fn) {
    const exit = process.exit
    const err = console.error
    let captured = ""
    console.error = (...a) => { captured += a.join(" ") + "\n" }
    process.exit = () => { throw new Error(captured.trim() || "process.exit called") }
    try { return fn() } finally { process.exit = exit; console.error = err }
}
