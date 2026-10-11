# Benchmark harness

One built-in harness measures the Slim compiler and runtime: `bench/`. There is no
second measurement system; ad-hoc scripts (such as `prompts/bench/runtime-bench.slim`)
are superseded by cases here. Benchmarks are **not** part of `npm test` and add nothing
to its time; only the harness's own fast unit tests (`test/bench-*.test.mjs`) run there.

```sh
npm run bench -- --list                          # cases, nothing is measured
npm run bench -- --quick                         # seconds, smoke-level numbers
npm run bench -- --filter struct.flat --suite runtime
npm run bench -- --hard --output target/bench/hard.json
```

Dependencies: only Node built-ins (`node:perf_hooks` timers, `node:fs`, `node:child_process`).

## Flags

| Flag | Meaning |
|---|---|
| `--quick` / `--hard` | small sizes, ~80 ms per row / large sizes, ~1500 ms per row |
| `--suite compiler\|runtime\|examples` | comma-separated, default all |
| `--filter a,b` | case-name substrings, any may match |
| `--list` | print rows and exit without measuring |
| `--sizes N,N` | override sizes (declarations / data items / modules, depending on the case) |
| `--iterations N` / `--warmup N` | fix the sample / warmup counts (otherwise adaptive and recorded) |
| `--release` / `--dev` | only `SLIM_RELEASE=1` rows / only dev rows (default both) |
| `--isolate` / `--in-process` | child process per row (default, clean JIT) / this process (debugging, one mode) |
| `--output PATH` | JSON report, default `target/bench/benchmark.json` |
| `--format table\|markdown` | markdown prints only the comparison, for CI |
| `--max-p95-ms N` | exit 1 if any row's p95 per operation exceeds N ms |
| `--save NAME` | also write `bench/baselines/NAME.json` (only from a completed run) |
| `--compare NAME\|PATH` | compare with a baseline; the baseline's per-row sample counts are reused |
| `--max-regression PCT` | exit 1 on a median regression above PCT (default 15); needs `--compare` |

Exit codes: `0` ok; `1` failure row, budget exceeded or regression; `2` bad options or a refused comparison.

## What is measured

**Compiler** (dev only; reported as one `unsupported` row in release):
`lexer`, `preprocess` (Slim's own rewriting before Babel), `parse` (Babel), `check`, `check-errors`
(failure path), `generate` and `sourcemap` (Babel generation without/with map; the difference is the
map cost), `transform` (whole pipeline without/with the checker), `format`, each at 1/10/100/1000
declarations; `deep-nesting`, `many-types`, `module-graph` (a `use` chain of N modules) and
`cold-first-call` (first `transform` in a fresh process).
Fixtures are in `bench/fixtures/` (regenerate with `node bench/fixtures/generate.js`).

**Runtime** (every case in dev and with `SLIM_RELEASE=1`, in separate processes):
`Struct.verify/verifySafe/new` on flat, nested and array-heavy data, success and failure paths;
annotated `let`, typed calls (parameters and returns), `kindof` on arrays, `match` on enum and values,
Proxy guard writes, component creation, process start-up of a compiled hello world, and exact sizes of
generated JS and of the runtime files.

**Examples**: full compile of each `examples/*.slim`. An example that does not compile is a failure row.

**Memory**: after the timing, the retained heap of a few results is measured around forced GCs
(`--expose-gc`, set automatically). It is an **estimate**, flagged `estimate: true`, and it only sees what `run()` returns: cases that return a
scalar (counts, sums) retain nothing, and deltas below the noise floor are reported as `retained_bytes_per_result: null` with `below_noise: true`.
It is meaningful for compiler stages with large outputs, not for the runtime loops; it is `null`
in `--in-process` runs without `--expose-gc`.

## Timing boundaries

Inside the numbers: one call of the stage or operation under test, in a warmed process.
Fast operations are batched until a sample lasts at least 1 ms and the per-call time is
reported; the batch size is `samples.batch`.

Outside the numbers: loading modules, compiling fixtures to JS, building input data,
result verification, memory probing, and timer overhead (`timer_overhead_ms`).
Compile time and execution time are separate rows: runtime cases compile their Slim source in
setup and time only the compiled code. A stage's input (for example the AST for `check`) is
produced before timing, so stage rows do not include earlier stages.

Special cases: `startup.hello` is wall clock of a fresh `node` and **includes node boot**
(subtract `startup.node-baseline`). `cold-first-call` is measured inside the child, after module load.
`struct.*.fail` and failure-path proxy rows are capped at 1000 items because every item throws.
`size.*` rows are exact byte counts and have no timing.

Reading the table: `p50` and the spread come from samples after outlier rejection (modified z-score
> 3.5 on the MAD); `p95`, `p99`, `min` and `max` are over all samples, so tails are not hidden.
`spread` is `1.4826*MAD/median`; a row is `NOISY` above 15 % spread or p95 > 2 × median.

**Dev numbers are not release numbers.** Dev includes the type guards the language exists to provide;
release (`SLIM_RELEASE=1`) compiles without them, and V8 may then fold simple loops to near zero.
Never present a dev figure as the cost of release or the reverse. Release rows compile their fixtures with
`release: true`, so the wrappers are absent from the measured code; the compiler suite has no release rows.

## Correctness of a measurement

Every case has a verification run **after** timing. A wrong or missing result marks the row
`failure` with `verified: false`; a fast wrong answer is never a success. Warmup is adaptive
(until the last five calls are stable, capped at 400 ms); the final warmup, batch and sample
counts are stored in each row so the run can be reproduced. Results are stored in a sink so V8
cannot drop the work. Each row runs in its own process by default for a clean JIT state.

## Report JSON

Check the fields, not just that the file exists:

* `completed` is `true` only when no row failed and the harness did not crash;
* `failure` is `null` or a reason; `failed_cases` lists every failed row with its message;
* `verified` is the number of rows whose result was verified; `unsupported` the number of rows
  that cannot be measured (each carries a reason);
* each result has `status` (`ok`, `failure`, `unsupported`), `samples` (`n`, `warmup`, `batch`, `adaptive`),
  `stats` (`min`, `mean`, `median`, `p95`, `p99`, `max`, `mad`, `rsd`, `outliers`, `noisy`), `counters`, `memory`;
* `environment`: Node, V8, OS, CPU model and cores, git commit and dirty state, Slim version.

`validateReport` in `bench/report.js` checks these invariants (it is what the tests use):
`completed === (failure === null)`, `verified` equals the verified rows, `ok` implies verified, and so on.

```sh
node -e 'const r=JSON.parse(require("fs").readFileSync("target/bench/benchmark.json"));import("./bench/report.js").then(m=>{console.log(m.validateReport(r), r.completed, r.failure, r.verified, r.unsupported)})'
```

## Comparing before and after

1. Same machine, quiet, same Node, same flags and cases. Prefer `--hard` for a hot-path change; one
   `--quick` run proves nothing (its percentiles are smoke values).
2. On the base commit: `npm run bench -- --filter <case> --save before`.
3. On your change: `npm run bench -- --filter <case> --compare before`.

`--compare` reuses the baseline's sample counts and batch sizes. The comparison is **refused** (exit 2,
with reasons) when Node, V8, OS, CPU model or core count differ, when no row is shared, or when sample counts
differ. A row regresses only if the median grows by more than `--max-regression` **and** more than three
times the larger spread; otherwise it is `same` (`noisy` is shown). Failed rows are not compared.
Baselines hold no absolute paths; commit them only when the environment note makes sense to others.

## CI example (not enabled)

A fixed `--quick` set on pull requests, comparing base and head **on the same runner**
(a baseline from another machine is correctly refused). Place it in `.github/workflows/bench.yml`
only after agreement; it is not active in this repository.

```yaml
name: bench
on: pull_request
jobs:
  bench:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - name: Baseline from the base branch
        run: |
          git checkout ${{ github.event.pull_request.base.sha }}
          git checkout ${{ github.sha }} -- bench   # harness from the PR, code under test from base
          npm run bench -- --quick --suite compiler,runtime --filter transform,struct.flat,typed.let --save base
          git checkout -- . && git checkout ${{ github.sha }}
      - name: Compare
        run: npm run bench -- --quick --suite compiler,runtime --filter transform,struct.flat,typed.let --compare base --max-regression 40 --format markdown | tee bench.md >> "$GITHUB_STEP_SUMMARY"
```

`--max-regression 40` leaves room for shared-runner noise; the noise rule above still applies.
