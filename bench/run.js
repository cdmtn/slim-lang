// Entry point: `npm run bench -- [flags]`. See bench/options.js or docs/benchmark.md.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs, OptionsError, HELP } from "./options.js"
import { planRows, rowKey } from "./registry.js"
import { runRows } from "./runner.js"
import { captureEnv, timerOverheadMs, ROOT } from "./env.js"
import { buildReport, renderTable, renderSummary, renderMetrics, validateReport } from "./report.js"
import { compareReports, renderComparison, sanitize, DEFAULT_MAX_REGRESSION } from "./compare.js"

const BASELINES = path.join(ROOT, "bench", "baselines")

function loadBaseline(nameOrPath) {
    const candidates = [path.resolve(nameOrPath), path.join(BASELINES, `${nameOrPath}.json`)]
    const file = candidates.find(c => fs.existsSync(c) && fs.statSync(c).isFile())
    if (!file) throw new OptionsError(`baseline not found: ${nameOrPath} (looked at ${candidates.join(", ")})`)
    const report = JSON.parse(fs.readFileSync(file, "utf8"))
    const problems = validateReport(report)
    if (problems.length) throw new OptionsError(`baseline ${nameOrPath} is invalid: ${problems.slice(0, 3).join("; ")}`)
    return report
}

// Pin the baseline's per-row sample plan so the new run is comparable by construction.
function planFrom(base) {
    return new Map(base.results.filter(r => r.status === "ok" && r.samples).map(r =>
        [rowKey(r), { n: r.samples.n, warmup: r.samples.warmup, batch: r.samples.batch }]))
}

export async function main(argv) {
    const options = parseArgs(argv)
    if (options.help) { console.log(HELP); return 0 }
    if (!options.isolate) options.modes = options.modes.length === 2 ? [process.env.SLIM_RELEASE === "1" ? "release" : "dev"] : options.modes
    options.timeoutMs = options.preset === 2 ? 900000 : 300000
    const rows = planRows(options)
    if (rows.length === 0) throw new OptionsError("filter matched no benchmark cases")
    if (options.list) {
        for (const r of rows) console.log(`${rowKey(r)}${r.unsupported ? "  (unsupported)" : ""}`)
        return 0
    }
    const base = options.compare ? loadBaseline(options.compare) : null
    const plan = base ? planFrom(base) : null
    const env = { ...captureEnv(), isolated: options.isolate, expose_gc: options.isolate }
    const startedAt = new Date().toISOString()
    console.log(`slim bench: ${rows.length} rows, preset ${options.presetName}, ${options.isolate ? "isolated" : "in-process"}, node ${env.node}${plan ? ", pinned to baseline sample counts" : ""}`)
    const results = await runRows(rows, options, plan, r => {
        const tag = r.status === "ok" ? "ok" : r.status
        process.stderr.write(`  ${tag.padEnd(11)} ${r.case}${r.size != null ? ` [${r.size}]` : ""} ${r.mode}\n`)
    })
    const budget = []
    if (options.maxP95Ms != null) {
        for (const r of results.filter(x => x.status === "ok" && x.stats && x.stats.p95 > options.maxP95Ms)) {
            budget.push(`${rowKey(r)} p95 ${r.stats.p95.toFixed(3)} ms > ${options.maxP95Ms} ms`)
        }
    }
    const report = buildReport({ options, env, timerMs: timerOverheadMs(), rows: results, startedAt, budget })
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true })
    fs.writeFileSync(options.output, JSON.stringify(sanitize(report, ROOT), null, 2) + "\n")

    let comparison = null
    if (base) comparison = compareReports(base, report, { maxRegression: options.maxRegression ?? DEFAULT_MAX_REGRESSION })
    if (options.format === "markdown" && comparison) {
        console.log(renderComparison(comparison, "markdown"))
    } else {
        console.log("\n" + renderTable(results) + "\n")
        const metrics = renderMetrics(results)
        if (metrics) console.log(metrics + "\n")
        console.log(renderSummary(report))
        if (comparison) console.log("\n" + renderComparison(comparison))
    }
    console.log(`JSON: ${options.output}`)
    if (options.save) {
        if (!report.completed) console.error("not saving a baseline from a failed run")
        else {
            fs.mkdirSync(BASELINES, { recursive: true })
            fs.writeFileSync(path.join(BASELINES, `${options.save}.json`), JSON.stringify(sanitize(report, ROOT), null, 2) + "\n")
            console.log(`baseline saved: bench/baselines/${options.save}.json`)
        }
    }
    if (!report.completed || budget.length) return 1
    if (comparison && (!comparison.compatible || comparison.regressions.length)) return comparison.compatible ? 1 : 2
    return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then(code => { process.exitCode = code }, error => {
    console.error(error instanceof OptionsError ? `bench: ${error.message}` : error)
    process.exitCode = 2
})
