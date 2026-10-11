// Executes one row (case x size x mode). Runs in a child process by default so each
// row gets clean JIT state, or in-process with --in-process.
import { pathToFileURL } from "node:url"
import { findCase } from "./registry.js"
import { makeContext } from "./context.js"
import { measure, memoryEstimate, readSink } from "./measure.js"

export const MARKER = "@@SLIM_BENCH@@"

const baseRow = spec => ({
    case: spec.name, suite: spec.suite, size: spec.size, mode: spec.mode, unit: "ms",
    status: "failure", verified: false, unsupported: null, failure: null,
    samples: null, stats: null, counters: {}, memory: null
})

const currentMode = () => (process.env.SLIM_RELEASE === "1" ? "release" : "dev")

// Measures a prepared case and verifies its result outside the timed region. A wrong
// result is a failure row with verified=false, never a fast success.
export async function runPrepared(row, prepared, options, plan = null) {
    try {
        row.counters = { ...prepared.counters }
        if (!prepared.metric) {
            const m = await measure(prepared, options, plan)
            row.samples = m.samples
            row.stats = m.stats
        }
        await prepared.verify(prepared.reported || prepared.metric ? undefined : readSink())
        row.verified = true
        if (!prepared.metric && !prepared.reported && prepared.memory !== false) row.memory = await memoryEstimate(prepared)
        row.status = "ok"
    } catch (error) {
        row.status = "failure"
        row.verified = false
        row.failure = String(error?.stack ?? error).split("\n").slice(0, 4).join("\n")
    }
    return row
}

export async function execute(spec, options, plan = null) {
    let row = baseRow(spec)
    const def = findCase(spec.name)
    if (!def) return { ...row, failure: `unknown case ${spec.name}` }
    if (currentMode() !== spec.mode) {
        return { ...row, status: "unsupported", unsupported: `process runs in ${currentMode()} mode; ${spec.mode} needs an isolated process` }
    }
    const ctx = makeContext(spec.mode)
    try {
        const area = await import(`./cases/${def.area}.js`)
        const setup = area.setups?.[spec.name] ?? area.setup
        if (!setup) throw new Error(`no setup for ${spec.name} in cases/${def.area}.js`)
        row = await runPrepared(row, await setup(ctx, spec.size, def), options, plan)
    } catch (error) {
        row.failure = String(error?.stack ?? error).split("\n").slice(0, 4).join("\n")
    } finally {
        ctx.cleanup()
    }
    return row
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { spec, options, plan } = JSON.parse(process.argv[2])
    execute(spec, options, plan).then(row => {
        process.stdout.write(`\n${MARKER}${JSON.stringify(row)}\n`)
        process.exit(0)
    })
}
