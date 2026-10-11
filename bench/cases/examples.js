// Full compile of each shipped example. Failures are real findings: an example that
// does not compile is reported as failure, not skipped.
import fs from "node:fs"
import path from "node:path"
import { guardExit } from "../context.js"

export const setup = async (ctx, _size, def) => {
    const { transform } = await ctx.src("src/transform.js")
    const file = path.join(ctx.root, "examples", def.example)
    const text = fs.readFileSync(file, "utf8")
    return {
        run: () => guardExit(() => transform(text, file, { check: true })),
        verify: ({ code }) => { if (!code.includes("core.js") && !code.includes("defaults.js")) throw new Error("output has no runtime import") },
        counters: { source_bytes: text.length }
    }
}
