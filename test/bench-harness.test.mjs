import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { buildReport, validateReport, summarizeRows } from "../bench/report.js"
import { runPrepared } from "../bench/worker.js"
import { COMMITTED } from "../bench/fixtures/generate.js"
import { planRows, allCases } from "../bench/registry.js"
import { parseArgs } from "../bench/options.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const options = { ...parseArgs(["--quick"]), iterations: 3, warmup: 1, budgetMs: 5 }
const blank = () => ({
    case: "t.case", suite: "runtime", size: 1, mode: "dev", unit: "ms", status: "failure", verified: false,
    unsupported: null, failure: null, samples: null, stats: null, counters: {}, memory: null
})

test("a correct case is verified, with samples recorded for reproducibility", async () => {
    const row = await runPrepared(blank(), { run: () => [1, 2, 3].reduce((a, b) => a + b), verify: v => assert.equal(v, 6) }, options)
    assert.equal(row.status, "ok")
    assert.equal(row.verified, true)
    assert.equal(row.samples.n, 3)
    assert.ok(row.stats.median >= 0)
})

test("a case that throws is a failure, not a result", async () => {
    const row = await runPrepared(blank(), { run: () => { throw new Error("boom") }, verify: () => {} }, options)
    assert.equal(row.status, "failure")
    assert.equal(row.verified, false)
    assert.match(row.failure, /boom/)
})

test("a fast case with a wrong result is a failure, not a fast success", async () => {
    const row = await runPrepared(blank(), { run: () => 41, verify: v => assert.equal(v, 42) }, options)
    assert.equal(row.status, "failure")
    assert.equal(row.verified, false)
    assert.match(row.failure, /41/)
})

test("failure rows make the report incomplete and are listed", () => {
    const ok = { ...blank(), status: "ok", verified: true }
    const bad = { ...blank(), case: "t.bad", failure: "wrong result" }
    const unsup = { ...blank(), case: "t.u", status: "unsupported", unsupported: "reason" }
    const report = buildReport({ options, env: { node: "x" }, timerMs: 0, rows: [ok, bad, unsup], startedAt: "now" })
    assert.equal(report.completed, false)
    assert.match(report.failure, /1 row/)
    assert.deepEqual(report.failed_cases.map(f => f.case), ["t.bad"])
    assert.equal(report.verified, 1)
    assert.equal(report.unsupported, 1)
    assert.deepEqual(summarizeRows(report.results), { rows: 3, verified: 1, failures: 1, unsupported: 1 })
    assert.deepEqual(validateReport(report), [])
})

test("validateReport checks consistency, not just presence", () => {
    const ok = { ...blank(), status: "ok", verified: true }
    const good = buildReport({ options, env: { node: "x" }, timerMs: 0, rows: [ok], startedAt: "now" })
    assert.deepEqual(validateReport(good), [])
    assert.ok(validateReport({ ...good, verified: 5 }).some(e => /verified count/.test(e)))
    assert.ok(validateReport({ ...good, completed: false }).some(e => /completed/.test(e)))
    assert.ok(validateReport({ ...good, results: [{ ...ok, verified: false }] }).length > 0)
    assert.ok(validateReport({ ...good, schema_version: 99 }).length > 0)
})

test("--list prints rows and measures nothing", () => {
    const out = path.join(os.tmpdir(), `slim-bench-list-${process.pid}.json`)
    const r = spawnSync(process.execPath, ["bench/run.js", "--list", "--quick", "--filter", "struct.flat", "--output", out], { cwd: root, encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /runtime\.struct\.flat\.verify\.ok@1000:release/)
    assert.equal(fs.existsSync(out), false, "--list must not write a report")
    assert.equal(r.stderr, "", "no per-row progress means nothing ran")
})

test("a bad flag exits non-zero with a message", () => {
    const r = spawnSync(process.execPath, ["bench/run.js", "--iterations", "1"], { cwd: root, encoding: "utf8" })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /--iterations/)
})

test("the catalog has unique names and every case has an implementation file", () => {
    const names = allCases().map(c => c.name)
    assert.equal(new Set(names).size, names.length)
    for (const c of allCases().filter(c => !c.unsupported)) {
        assert.ok(fs.existsSync(path.join(root, "bench", "cases", `${c.area}.js`)), `${c.name}: missing cases/${c.area}.js`)
    }
    const rows = planRows(parseArgs(["--quick", "--suite", "runtime", "--filter", "typed.let-int"]))
    assert.deepEqual(rows.map(r => r.mode), ["dev", "release"])
})

test("committed fixtures match their generators", () => {
    for (const [name, make] of Object.entries(COMMITTED)) {
        assert.equal(fs.readFileSync(path.join(root, "bench", "fixtures", `${name}.slim`), "utf8"), make(), `${name}.slim is stale; run node bench/fixtures/generate.js`)
    }
})
