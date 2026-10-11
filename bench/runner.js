// Runs rows sequentially (parallel runs would distort each other's timings).
import { spawnSync } from "node:child_process"
import path from "node:path"
import { ROOT } from "./env.js"
import { execute, MARKER } from "./worker.js"
import { rowKey } from "./registry.js"

const WORKER = path.join(ROOT, "bench", "worker.js")

function isolated(spec, options, plan) {
    const r = spawnSync(process.execPath, ["--expose-gc", "--no-warnings", WORKER, JSON.stringify({ spec, options, plan })], {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: options.timeoutMs,
        env: { ...process.env, SLIM_RELEASE: spec.mode === "release" ? "1" : "0" }
    })
    const line = r.stdout?.split("\n").find(l => l.startsWith(MARKER))
    if (line) return JSON.parse(line.slice(MARKER.length))
    const why = r.error?.code === "ETIMEDOUT" ? `timed out after ${options.timeoutMs} ms` : `child exited ${r.status}: ${(r.stderr ?? "").trim().slice(-400)}`
    return { case: spec.name, suite: spec.suite, size: spec.size, mode: spec.mode, unit: "ms", status: "failure", verified: false, unsupported: null, failure: why, samples: null, stats: null, counters: {}, memory: null }
}

// plan: Map rowKey -> {n, warmup, batch} pinned from a baseline for comparable runs.
export async function runRows(rows, options, plan, onRow = () => {}) {
    const out = []
    for (const spec of rows) {
        let row
        if (spec.unsupported) {
            row = { case: spec.name, suite: spec.suite, size: spec.size, mode: spec.mode, unit: "ms", status: "unsupported", verified: false, unsupported: spec.unsupported, failure: null, samples: null, stats: null, counters: {}, memory: null }
        } else {
            const pinned = plan?.get(rowKey(spec)) ?? null
            row = options.isolate ? isolated(spec, options, pinned) : await execute(spec, options, pinned)
        }
        out.push(row)
        onRow(row)
    }
    return out
}
