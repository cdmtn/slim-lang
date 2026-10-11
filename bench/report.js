// JSON report construction/validation and console rendering.
export const SCHEMA_VERSION = 1

export function summarizeRows(rows) {
    return {
        rows: rows.length,
        verified: rows.filter(r => r.verified).length,
        failures: rows.filter(r => r.status === "failure").length,
        unsupported: rows.filter(r => r.status === "unsupported").length
    }
}

// completed = every selected row ran to a verified result (no failure rows);
// failure = null or a one-line reason; the rows carry details.
export function buildReport({ options, env, timerMs, rows, startedAt, budget = [], harnessError = null }) {
    const s = summarizeRows(rows)
    const failed = rows.filter(r => r.status === "failure")
    const failure = harnessError ?? (failed.length ? `${failed.length} row(s) failed verification or crashed` : null)
    return {
        schema_version: SCHEMA_VERSION,
        completed: failure === null,
        failure,
        failed_cases: failed.map(r => ({ case: r.case, size: r.size, mode: r.mode, failure: r.failure })),
        verified: s.verified,
        unsupported: s.unsupported,
        started_at: startedAt,
        options: {
            preset: options.presetName, suites: options.suites, filter: options.filter, sizes: options.sizes,
            iterations: options.iterations, warmup: options.warmup, modes: options.modes,
            isolated: options.isolate, budget_ms: options.budgetMs, max_p95_ms: options.maxP95Ms
        },
        environment: env,
        timer_overhead_ms: timerMs,
        budget_violations: budget,
        results: rows
    }
}

// Structural check used by tests and by CI: field presence AND consistency, not just file existence.
export function validateReport(report) {
    const errors = []
    const need = (cond, msg) => { if (!cond) errors.push(msg) }
    need(report && typeof report === "object", "report is not an object")
    if (errors.length) return errors
    need(report.schema_version === SCHEMA_VERSION, `schema_version must be ${SCHEMA_VERSION}`)
    need(typeof report.completed === "boolean", "completed must be boolean")
    need(report.failure === null || typeof report.failure === "string", "failure must be null or string")
    need(typeof report.verified === "number" && typeof report.unsupported === "number", "verified/unsupported must be numbers")
    need(Array.isArray(report.results), "results must be an array")
    need(report.environment && typeof report.environment.node === "string", "environment.node missing")
    if (!Array.isArray(report.results)) return errors
    need(report.completed === (report.failure === null), "completed must equal (failure === null)")
    need(report.verified === report.results.filter(r => r.verified).length, "verified count disagrees with rows")
    need(report.unsupported === report.results.filter(r => r.status === "unsupported").length, "unsupported count disagrees with rows")
    for (const r of report.results) {
        const id = `${r.case}@${r.size}:${r.mode}`
        need(["ok", "failure", "unsupported"].includes(r.status), `${id}: bad status`)
        need(r.status !== "ok" || r.verified === true, `${id}: status ok without verification`)
        need(r.status !== "failure" || (r.verified === false && typeof r.failure === "string"), `${id}: failure row must be unverified with a message`)
        need(r.status !== "unsupported" || typeof r.unsupported === "string", `${id}: unsupported needs a reason`)
        if (r.status === "ok" && r.stats) {
            need(r.stats.n === r.samples?.n, `${id}: stats.n != samples.n`)
            need(r.stats.median > 0 && r.stats.p95 >= r.stats.median * 0.999 || r.stats.n < 3, `${id}: inconsistent percentiles`)
        }
    }
    return errors
}

const fmt = ms => (ms == null ? "-" : ms >= 100 ? ms.toFixed(0) + "ms" : ms >= 1 ? ms.toFixed(2) + "ms" : ms >= 0.001 ? (ms * 1000).toFixed(1) + "µs" : (ms * 1e6).toFixed(0) + "ns")
const unitNote = "times are per operation; x = calls batched per sample; spread = robust relative deviation (1.4826*MAD/median)"
const label = r => `${r.case}${r.size != null ? ` [${r.size}]` : ""}`

export function renderTable(rows) {
    const head = ["case", "mode", "p50", "p95", "p99", "spread", "n", "x", "status"]
    const body = rows.map(r => {
        const s = r.stats
        const spread = s ? `${(s.rsd * 100).toFixed(1)}%${s.noisy ? " NOISY" : ""}` : "-"
        const status = r.status === "ok" ? (r.verified ? "ok" : "unverified") : r.status.toUpperCase()
        return [label(r), r.mode, fmt(s?.median), fmt(s?.p95), fmt(s?.p99), spread, s ? String(r.samples.n) : "-", r.samples ? String(r.samples.batch) : "-", status]
    })
    const widths = head.map((h, i) => Math.max(h.length, ...body.map(b => b[i].length)))
    const line = cells => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ")
    return [line(head), widths.map(w => "-".repeat(w)).join("  "), ...body.map(line), "", unitNote].join("\n")
}

export function renderSummary(report) {
    const out = [`Rows ${report.results.length}: verified ${report.verified}, unsupported ${report.unsupported}, failed ${report.failed_cases.length}`]
    for (const f of report.failed_cases) out.push(`FAILURE ${f.case}${f.size != null ? ` [${f.size}]` : ""} ${f.mode}: ${String(f.failure).split("\n")[0]}`)
    for (const r of report.results.filter(x => x.status === "unsupported")) out.push(`UNSUPPORTED ${r.case} ${r.mode}: ${r.unsupported}`)
    for (const b of report.budget_violations) out.push(`BUDGET ${b}`)
    out.push(`completed=${report.completed} failure=${report.failure ?? "null"}`)
    return out.join("\n")
}

// Deterministic counters of rows that carry no timing (sizes, byte counts).
export function renderMetrics(rows) {
    const metric = rows.filter(r => r.status === "ok" && !r.samples)
    if (metric.length === 0) return ""
    const lines = metric.map(r => {
        const flat = Object.entries(r.counters).flatMap(([k, v]) => (v && typeof v === "object"
            ? Object.entries(v).map(([k2, v2]) => `${k}.${k2}=${typeof v2 === "object" ? Object.values(v2).join("/") : v2}`)
            : [`${k}=${v}`]))
        return `${label(r)}\n    ${flat.join(" ")}`
    })
    return ["sizes (bytes, exact, not timed):", ...lines].join("\n")
}
