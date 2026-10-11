import assert from "node:assert/strict"
import { test } from "node:test"
import { compareReports, renderComparison, sanitize } from "../bench/compare.js"

const env = { node: "22.0.0", v8: "12", platform: "linux", arch: "x64", cpu_model: "cpu", cores: 8 }
const row = (name, median, extra = {}) => ({
    case: name, size: 100, mode: "dev", status: "ok", verified: true,
    samples: { n: 40, batch: 1, warmup: 5 },
    stats: { n: 40, median, rsd: 0.02, p95: median * 1.1, p99: median * 1.2, noisy: false, ...extra }
})
const report = (rows, environment = env) => ({ environment, results: rows })

test("a slowdown beyond the threshold is a regression", () => {
    const r = compareReports(report([row("a", 1)]), report([row("a", 1.5)]), { maxRegression: 15 })
    assert.equal(r.compatible, true)
    assert.equal(r.regressions.length, 1)
    assert.ok(Math.abs(r.regressions[0].pct - 50) < 1e-9)
})

test("a speedup is reported as an improvement, not a regression", () => {
    const r = compareReports(report([row("a", 1)]), report([row("a", 0.5)]))
    assert.equal(r.regressions.length, 0)
    assert.equal(r.improvements.length, 1)
})

test("movement inside the threshold or the noise floor is not a regression", () => {
    assert.equal(compareReports(report([row("a", 1)]), report([row("a", 1.1)])).regressions.length, 0)
    const noisy = compareReports(report([row("a", 1, { rsd: 0.2 })]), report([row("a", 1.4, { rsd: 0.2 })]))
    assert.equal(noisy.regressions.length, 0, "40% inside 3x a 20% spread")
    assert.equal(compareReports(report([row("a", 0.0005)]), report([row("a", 0.001)])).regressions.length, 0, "sub-2µs absolute noise")
})

test("different environments are refused with the reason", () => {
    const r = compareReports(report([row("a", 1)]), report([row("a", 1)], { ...env, cpu_model: "other", node: "24.0.0" }))
    assert.equal(r.compatible, false)
    assert.ok(r.reasons.some(x => x.includes("cpu_model")))
    assert.ok(r.reasons.some(x => x.includes("node")))
    assert.match(renderComparison(r), /refused/)
})

test("different sample counts or disjoint cases are refused", () => {
    const other = row("a", 1)
    other.samples.n = 41
    assert.match(compareReports(report([row("a", 1)]), report([other])).reasons[0], /sample count/)
    assert.match(compareReports(report([row("a", 1)]), report([row("b", 1)])).reasons[0], /appears in both/)
})

test("failed and unsupported rows are not compared; markdown output has a table", () => {
    const failed = { ...row("a", 1), status: "failure", verified: false }
    const r = compareReports(report([row("a", 1), row("b", 1)]), report([failed, row("b", 2)]))
    assert.equal(r.rows.length, 1)
    assert.deepEqual(r.onlyBase, ["a@100:dev"])
    assert.match(renderComparison(r, "markdown"), /\| case \|/)
})

test("sanitize removes absolute repository paths", () => {
    const clean = sanitize({ failure: "at /home/me/slim-lang/src/x.js" }, "/home/me/slim-lang")
    assert.equal(clean.failure, "at <repo>/src/x.js")
})
