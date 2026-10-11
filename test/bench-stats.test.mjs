import assert from "node:assert/strict"
import { test } from "node:test"
import { percentile, median, mad, rejectOutliers, summarize } from "../bench/stats.js"

const range = n => Array.from({ length: n }, (_, i) => i + 1)

test("percentiles interpolate linearly on a known sample", () => {
    const sorted = Float64Array.from(range(100))
    assert.equal(percentile(sorted, 0), 1)
    assert.equal(percentile(sorted, 50), 50.5)
    assert.ok(Math.abs(percentile(sorted, 95) - 95.05) < 1e-9)
    assert.ok(Math.abs(percentile(sorted, 99) - 99.01) < 1e-9)
    assert.equal(percentile(sorted, 100), 100)
    assert.ok(Number.isNaN(percentile([], 50)))
})

test("median and MAD of a small known sample", () => {
    assert.equal(median([1, 2, 3, 4, 100]), 3)
    assert.equal(mad([1, 2, 3, 4, 100]), 1) // |x - 3| = 2 1 0 1 97 -> median 1
})

test("outlier rejection drops a spike but keeps a clean sample intact", () => {
    const spiky = [10, 10.1, 9.9, 10.2, 9.8, 10, 10.1, 9.9, 500]
    const { kept, outliers } = rejectOutliers(spiky)
    assert.deepEqual(outliers, [500])
    assert.equal(kept.length, 8)
    assert.equal(rejectOutliers(range(20)).outliers.length, 0)
    assert.equal(rejectOutliers([5, 5, 5, 5, 90]).outliers.length, 0, "MAD = 0 rejects nothing")
})

test("summarize keeps the tail in p95/p99/max but reports central values without outliers", () => {
    const s = summarize([10, 10.1, 9.9, 10.2, 9.8, 10, 10.1, 9.9, 500])
    assert.equal(s.n, 9)
    assert.equal(s.outliers, 1)
    assert.equal(s.max, 500)
    assert.ok(s.p99 > 100, "tail must not be trimmed")
    assert.ok(Math.abs(s.median - 10) < 0.11)
    assert.ok(s.mean < 11, "mean excludes the outlier")
    assert.ok(s.raw.mean > 50, "raw mean is still available")
    assert.equal(s.min, 9.8)
})

test("noisy flag follows relative spread and tail ratio", () => {
    assert.equal(summarize(Array.from({ length: 30 }, () => 1)).noisy, false)
    assert.equal(summarize(range(30).map(i => 1 + (i % 2) * 0.9)).noisy, true)
    assert.equal(summarize([1, 1, 1, 1, 1, 1, 1, 1, 1, 50]).noisy, true)
})
