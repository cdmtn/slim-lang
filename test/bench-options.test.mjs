import assert from "node:assert/strict"
import { test } from "node:test"
import { parseArgs, OptionsError, sizesFor, DEFAULT_OUTPUT } from "../bench/options.js"

test("defaults", () => {
    const o = parseArgs([])
    assert.deepEqual(o.suites, ["compiler", "runtime", "examples"])
    assert.deepEqual(o.modes, ["dev", "release"])
    assert.equal(o.isolate, true)
    assert.equal(o.output, DEFAULT_OUTPUT)
    assert.equal(o.presetName, "default")
})

test("quick and hard presets change budget and sizes", () => {
    const q = parseArgs(["--quick"])
    const h = parseArgs(["--hard"])
    assert.ok(q.budgetMs < parseArgs([]).budgetMs && parseArgs([]).budgetMs < h.budgetMs)
    assert.ok(sizesFor(q, "decls").length < sizesFor(h, "decls").length || Math.max(...sizesFor(q, "decls")) < Math.max(...sizesFor(h, "decls")))
    assert.deepEqual(sizesFor(parseArgs(["--sizes", "3,7"]), "items"), [3, 7])
})

test("all documented flags parse", () => {
    const o = parseArgs(["--suite", "runtime", "--filter", "struct,match", "--iterations", "9", "--warmup", "2", "--release",
        "--in-process", "--output", "x/y.json", "--format", "markdown", "--max-p95-ms", "1.5", "--save", "base",
        "--compare", "base", "--max-regression", "20", "--list"])
    assert.deepEqual(o.suites, ["runtime"])
    assert.deepEqual(o.filter, ["struct", "match"])
    assert.equal(o.iterations, 9)
    assert.equal(o.warmup, 2)
    assert.deepEqual(o.modes, ["release"])
    assert.equal(o.isolate, false)
    assert.equal(o.maxP95Ms, 1.5)
    assert.equal(o.maxRegression, 20)
    assert.equal(o.list, true)
})

test("bad values are rejected with a clear OptionsError", () => {
    const bad = [
        [["--iterations", "1"], /--iterations/],
        [["--iterations", "abc"], /--iterations/],
        [["--warmup", "0"], /--warmup/],
        [["--sizes", "10,0"], /--sizes/],
        [["--sizes", "x"], /--sizes/],
        [["--suite", "nope"], /unknown suite/],
        [["--max-p95-ms", "-1"], /--max-p95-ms/],
        [["--max-p95-ms", "NaN"], /--max-p95-ms/],
        [["--output"], /requires a value/],
        [["--format", "xml"], /--format/],
        [["--bogus"], /unknown option/],
        [["--isolate", "--in-process"], /conflict/],
        [["--quick", "--hard"], /conflict/],
        [["--max-regression", "10"], /requires --compare/],
        [["--save", "../x"], /--save/]
    ]
    for (const [argv, pattern] of bad) {
        assert.throws(() => parseArgs(argv), error => error instanceof OptionsError && pattern.test(error.message), argv.join(" "))
    }
})
