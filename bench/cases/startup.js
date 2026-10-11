// Process start-up and output/runtime sizes. Start-up is wall clock of a fresh `node`
// running a compiled hello world (includes node boot; subtract startup.node-baseline).
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { spawnSync } from "node:child_process"

const spawnNode = (args, mode) => spawnSync(process.execPath, ["--no-warnings", ...args], {
    encoding: "utf8", env: { ...process.env, SLIM_RELEASE: mode === "release" ? "1" : "0" }
})

export const setups = {
    async "runtime.startup.hello"(ctx) {
        const { file } = await ctx.build("hello", 'log("hello from slim")')
        return {
            run: () => spawnNode([file], ctx.mode),
            verify: r => {
                if (r.status !== 0) throw new Error(`hello exited ${r.status}: ${r.stderr.slice(0, 200)}`)
                if (!r.stdout.includes("hello from slim")) throw new Error(`stdout was ${JSON.stringify(r.stdout)}`)
            },
            memory: false,
            counters: { includes: "node boot + core.js load + first log" }
        }
    },
    async "runtime.startup.node-baseline"(ctx) {
        return {
            run: () => spawnNode(["-e", "console.log('hello from slim')"], ctx.mode),
            verify: r => { if (r.status !== 0 || !r.stdout.includes("hello")) throw new Error("baseline node failed") },
            counters: { includes: "node boot only" }
        }
    },
    async "runtime.size.generated-js"(ctx, size) {
        const text = ctx.fixture(`decls-${size}`)
        const { code } = await ctx.compile(text, ctx.fixturePath(`decls-${size}`), { check: true })
        const marker = code.lastIndexOf("\n//# sourceMappingURL")
        const body = code.slice(0, marker)
        return {
            metric: true,
            counters: { source_bytes: text.length, js_bytes_without_map: body.length, sourcemap_comment_bytes: code.length - body.length, js_gzip_bytes: zlib.gzipSync(body).length },
            verify: () => { if (!(body.length > 0)) throw new Error("empty output") }
        }
    },
    async "runtime.size.runtime"(ctx) {
        const dir = path.join(ctx.root, "src", "external")
        const files = {}
        for (const f of fs.readdirSync(dir).filter(n => n.endsWith(".js"))) {
            const buf = fs.readFileSync(path.join(dir, f))
            files[f] = { bytes: buf.length, gzip_bytes: zlib.gzipSync(buf).length }
        }
        return {
            metric: true,
            counters: { files, core_bytes: files["core.js"]?.bytes, core_gzip_bytes: files["core.js"]?.gzip_bytes },
            verify: () => { if (!files["core.js"]?.bytes) throw new Error("core.js not found") }
        }
    }
}
