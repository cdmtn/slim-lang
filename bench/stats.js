// Shared sample statistics. Extension point: the planned runtime bench() of
// prompts/08-doc-bench-tooling.txt must import summarize() from here instead of
// reimplementing percentiles, MAD or outlier rejection.

// Linear-interpolation percentile (R type 7) of a sorted array, p in [0, 100].
export function percentile(sorted, p) {
    if (sorted.length === 0) return NaN
    const pos = (p / 100) * (sorted.length - 1)
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

const sortedCopy = values => Float64Array.from(values).sort()

export function median(values) {
    return percentile(sortedCopy(values), 50)
}

export function mean(values) {
    let sum = 0
    for (const v of values) sum += v
    return values.length ? sum / values.length : NaN
}

// Median absolute deviation (unscaled).
export function mad(values, center = median(values)) {
    return median(values.map(v => Math.abs(v - center)))
}

// Modified z-score rejection (Iglewicz-Hoaglin): |0.6745 (x - med) / MAD| > cutoff.
// With MAD = 0 nothing can be called an outlier.
export function rejectOutliers(values, cutoff = 3.5) {
    const center = median(values)
    const spread = mad(values, center)
    if (!(spread > 0)) return { kept: Array.from(values), outliers: [] }
    const kept = []
    const outliers = []
    for (const v of values) {
        if (Math.abs((0.6745 * (v - center)) / spread) > cutoff) outliers.push(v)
        else kept.push(v)
    }
    return { kept, outliers }
}

export const NOISY_RSD = 0.15
export const NOISY_TAIL = 2

// min/max/p95/p99 describe all samples (the tail is never trimmed);
// median/mean/mad/rsd describe the samples left after outlier rejection.
export function summarize(samples) {
    const all = sortedCopy(samples)
    const { kept, outliers } = rejectOutliers(samples)
    const center = median(kept)
    const spread = mad(kept, center)
    const rsd = center > 0 ? (1.4826 * spread) / center : 0
    const p95 = percentile(all, 95)
    return {
        n: all.length,
        kept: kept.length,
        outliers: outliers.length,
        min: all[0],
        max: all[all.length - 1],
        mean: mean(kept),
        median: center,
        p95,
        p99: percentile(all, 99),
        mad: spread,
        rsd,
        noisy: rsd > NOISY_RSD || (center > 0 && p95 / center > NOISY_TAIL),
        raw: { mean: mean(samples), median: percentile(all, 50) }
    }
}
