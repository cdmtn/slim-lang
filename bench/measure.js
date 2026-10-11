// Timing loop for one prepared case. Only run() is timed: module loading, setup,
// verification and memory probing all happen outside the measured region.
import { summarize, median, mad } from "./stats.js"

let sink // defeats dead-code elimination: every result is stored here
export const readSink = () => sink

const now = () => performance.now()
const MIN_SAMPLE_MS = 1 // each sample batches calls until it lasts at least this long
const WARMUP_CAP_MS = 400

async function call(def) {
    const t = now()
    const value = def.reported ? await def.run() : def.run()
    // reported cases return their own duration in ms (measured inside a child process)
    return { ms: def.reported ? value : now() - t, value: def.reported ? undefined : await value }
}

// Warm up until the last calls are stable (or a fixed count when --warmup is given).
async function warmUp(def, options, plan) {
    const fixed = plan?.warmup ?? options.warmup
    if (def.reported) return 0
    const start = now()
    const recent = []
    let count = 0
    while (true) {
        const { ms, value } = await call(def)
        sink = value
        count++
        recent.push(ms)
        if (recent.length > 5) recent.shift()
        if (fixed != null) { if (count >= fixed) return count; continue }
        const stable = recent.length === 5 && mad(recent) <= 0.1 * median(recent)
        if ((count >= 3 && stable) || now() - start > WARMUP_CAP_MS) return count
    }
}

export async function measure(def, options, plan = null) {
    const warmup = await warmUp(def, options, plan)
    const probe = []
    for (let i = 0; i < 3; i++) probe.push((await call(def)).ms)
    const perCall = Math.max(median(probe), 1e-6)
    const batch = plan?.batch ?? (def.reported ? 1 : Math.max(1, Math.ceil(MIN_SAMPLE_MS / perCall)))
    const budget = options.budgetMs * (def.budgetFactor ?? 1)
    const fixedN = plan?.n ?? options.iterations
    const n = fixedN ?? Math.min(options.maxSamples,
        Math.max(options.minSamples, Math.floor(budget / (perCall * batch))))
    const samples = new Array(n)
    for (let i = 0; i < n; i++) {
        if (def.reported) { samples[i] = (await call(def)).ms; continue }
        const t = now()
        for (let b = 0; b < batch; b++) sink = def.run()
        const elapsed = now() - t
        if (sink instanceof Promise) sink = await sink
        samples[i] = elapsed / batch
    }
    return {
        samples: { n, warmup, batch, adaptive: fixedN == null && options.warmup == null, budget_ms: budget },
        stats: summarize(samples)
    }
}

// Retained-heap estimate: keeps a few results alive and diffs heapUsed around forced GCs.
export async function memoryEstimate(def, keep = 3) {
    if (typeof globalThis.gc !== "function") return null
    globalThis.gc()
    const before = process.memoryUsage().heapUsed
    const held = []
    for (let i = 0; i < keep; i++) held.push((await call(def)).value)
    globalThis.gc()
    const after = process.memoryUsage().heapUsed
    sink = held
    const bytes = Math.round((after - before) / keep)
    // A negative delta means garbage from earlier work was collected: below the noise floor.
    return { estimate: true, retained_bytes_per_result: bytes >= 0 ? bytes : null, below_noise: bytes < 0, results_kept: keep }
}
