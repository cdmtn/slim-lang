// Whole-file compiler shapes: deep nesting, many types, a use-graph, cold start.
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { genGraph } from "../fixtures/generate.js"
import { guardExit } from "../context.js"

async function wholeFile(ctx, name, mustContain) {
    const { transform } = await ctx.src("src/transform.js")
    const text = ctx.fixture(name)
    const file = ctx.fixturePath(name)
    return {
        run: () => guardExit(() => transform(text, file, { check: true })),
        verify: ({ code }) => { if (!code.includes(mustContain)) throw new Error(`output lacks ${mustContain}`) },
        counters: { bytes_in: text.length }
    }
}

export const setups = {
    "compiler.deep-nesting": ctx => wholeFile(ctx, "deep", "deep"),
    "compiler.many-types": ctx => wholeFile(ctx, "many-types", "__def_enum__"),
    // A chain of N modules joined by `use`; dependencies are checked first, like slmc does.
    async "compiler.module-graph"(ctx, size) {
        const { transform } = await ctx.src("src/transform.js")
        const dir = path.join(ctx.tmp, "graph")
        fs.mkdirSync(dir, { recursive: true })
        const files = genGraph(size)
        for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text)
        const order = Object.keys(files).reverse()
        return {
            run: () => guardExit(() => order.map(name => transform(files[name], path.join(dir, name), { check: true }).code)),
            verify: outputs => {
                if (outputs.length !== size) throw new Error("module count mismatch")
                outputs.forEach((code, i) => {
                    const dep = order.length - 1 - i
                    if (dep < size - 1 && !code.includes(`m${dep + 1}`)) throw new Error(`m${dep} lost its import`)
                })
            },
            counters: { modules: size }
        }
    },
    // The first transform() of a fresh process, reported by the child itself.
    async "compiler.cold-first-call"(ctx) {
        let bytes = 0
        const fixture = ctx.fixturePath("decls-100")
        const child = path.join(ctx.root, "bench", "cases", "cold-child.mjs")
        return {
            reported: true,
            run: () => {
                const r = spawnSync(process.execPath, ["--no-warnings", child, ctx.root, fixture], { encoding: "utf8" })
                if (r.status !== 0) throw new Error(`cold child failed: ${r.stderr.slice(0, 300)}`)
                const out = JSON.parse(r.stdout)
                bytes = out.bytes
                return out.ms
            },
            verify: () => { if (!(bytes > 0)) throw new Error("child produced no code") },
            counters: { fixture: "decls-100", note: "first call per process, excludes module load and node boot" }
        }
    }
}
