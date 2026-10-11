// Run-to-run comparison. Refuses (compatible: false) unless the runs measured the
// same thing on the same machine; a noisy one-off proves nothing.
import { COMPARABLE_ENV } from "./env.js"

export const DEFAULT_MAX_REGRESSION = 15 // percent
const MIN_ABS_MS = 0.002 // ignore sub-2µs absolute movement
const NOISE_MULTIPLIER = 3 // threshold is raised to 3x the larger relative spread

const key = r => `${r.case}@${r.size ?? "-"}:${r.mode}`
const measured = r => r.status === "ok" && r.stats && r.samples

export function compareReports(base, head, { maxRegression = DEFAULT_MAX_REGRESSION } = {}) {
    const reasons = []
    for (const field of COMPARABLE_ENV) {
        if (base.environment?.[field] !== head.environment?.[field]) {
            reasons.push(`environment.${field} differs: ${base.environment?.[field]} vs ${head.environment?.[field]}`)
        }
    }
    const baseRows = new Map(base.results.filter(measured).map(r => [key(r), r]))
    const headRows = new Map(head.results.filter(measured).map(r => [key(r), r]))
    const shared = [...headRows.keys()].filter(k => baseRows.has(k))
    if (shared.length === 0) reasons.push("no case/size/mode appears in both reports")
    for (const k of shared) {
        const b = baseRows.get(k).samples
        const h = headRows.get(k).samples
        if (b.n !== h.n) reasons.push(`${k}: sample count differs (${b.n} vs ${h.n})`)
        else if (b.batch !== h.batch) reasons.push(`${k}: batch size differs (${b.batch} vs ${h.batch})`)
    }
    if (reasons.length) return { compatible: false, reasons, rows: [], regressions: [], improvements: [], onlyBase: [], onlyHead: [] }

    const rows = shared.map(k => {
        const b = baseRows.get(k)
        const h = headRows.get(k)
        const delta = h.stats.median - b.stats.median
        const pct = (delta / b.stats.median) * 100
        const noise = Math.max(b.stats.rsd, h.stats.rsd) * 100 * NOISE_MULTIPLIER
        const threshold = Math.max(maxRegression, noise)
        let verdict = "same"
        if (Math.abs(delta) >= MIN_ABS_MS) {
            if (pct > threshold) verdict = "regression"
            else if (pct < -threshold) verdict = "improvement"
        }
        return { key: k, base: b.stats.median, head: h.stats.median, pct, threshold, verdict, noisy: b.stats.noisy || h.stats.noisy }
    })
    return {
        compatible: true,
        reasons: [],
        rows,
        regressions: rows.filter(r => r.verdict === "regression"),
        improvements: rows.filter(r => r.verdict === "improvement"),
        onlyBase: [...baseRows.keys()].filter(k => !headRows.has(k)),
        onlyHead: [...headRows.keys()].filter(k => !baseRows.has(k))
    }
}

const ms = v => (v >= 1 ? v.toFixed(3) : v.toFixed(4))

export function renderComparison(result, format = "table") {
    if (!result.compatible) {
        const lines = ["Comparison refused: the runs are not comparable.", ...result.reasons.slice(0, 20).map(r => `  - ${r}`)]
        if (result.reasons.length > 20) lines.push(`  ... ${result.reasons.length - 20} more`)
        return format === "markdown" ? lines.join("\n") : lines.join("\n")
    }
    const mark = { regression: "REGRESSION", improvement: "improvement", same: "same" }
    if (format === "markdown") {
        const head = "| case | base p50 ms | head p50 ms | change | verdict |\n|---|---:|---:|---:|---|"
        const body = result.rows.map(r => `| ${r.key} | ${ms(r.base)} | ${ms(r.head)} | ${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(1)}% | ${mark[r.verdict]}${r.noisy ? " (noisy)" : ""} |`)
        return [`**Benchmark comparison**: ${result.regressions.length} regression(s), ${result.improvements.length} improvement(s), ${result.rows.length} compared`, "", head, ...body].join("\n")
    }
    const width = Math.max(...result.rows.map(r => r.key.length))
    const lines = result.rows.map(r => `${r.key.padEnd(width)}  ${ms(r.base).padStart(10)} -> ${ms(r.head).padStart(10)}  ${((r.pct >= 0 ? "+" : "") + r.pct.toFixed(1) + "%").padStart(8)}  ${mark[r.verdict]}${r.noisy ? " (noisy)" : ""}`)
    return [...lines, `${result.regressions.length} regression(s), ${result.improvements.length} improvement(s) of ${result.rows.length}; only in base: ${result.onlyBase.length}, only in head: ${result.onlyHead.length}`].join("\n")
}

// Baselines never carry machine-specific absolute paths.
export function sanitize(report, root) {
    const text = JSON.stringify(report).split(root).join("<repo>")
    return JSON.parse(text)
}
