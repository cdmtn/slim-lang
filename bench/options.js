// Command-line parsing for `npm run bench`. Pure: no I/O, so it is unit-tested.
export class OptionsError extends Error {}

export const SUITES = ["compiler", "runtime", "examples"]
export const DEFAULT_OUTPUT = "target/bench/benchmark.json"

// Per size kind: [default, quick, hard]. "decls" = declarations per fixture,
// "items" = data objects per sample, "files" = modules in a use-graph.
export const SIZE_PRESETS = {
    decls: [[1, 10, 100, 1000], [1, 10, 100], [10, 100, 1000, 3000]],
    items: [[1000, 100000], [1000], [1000, 100000, 400000]],
    files: [[5, 20], [5], [20, 100]]
}
// [default, quick, hard]
const PRESETS = {
    budgetMs: [300, 80, 1500],
    minSamples: [15, 5, 30],
    maxSamples: [1000, 40, 3000]
}

export const HELP = `Slim benchmark harness (one harness for compiler and runtime)

  npm run bench -- [flags]

  --quick               small sizes, ~80 ms budget per row, seconds in total
  --hard                large sizes, ~1500 ms budget per row, many samples
  --suite NAME[,NAME]   compiler | runtime | examples (default: all)
  --filter TEXT[,TEXT]  case-name substrings, any may match; see --list
  --list                list cases and exit without measuring anything
  --sizes N,N,...       override sizes of sized cases (decls / items / files)
  --iterations N        fixed number of samples per row (disables adaptive count)
  --warmup N            fixed number of untimed warmup calls (disables adaptive)
  --release | --dev     only SLIM_RELEASE=1 rows | only dev rows (default: both)
  --isolate             one child process per row, clean JIT state (default)
  --in-process          run in this process: fast debugging, one mode, shared JIT
  --output PATH         JSON report (default ${DEFAULT_OUTPUT})
  --format table|markdown   console output; markdown prints the comparison for CI
  --max-p95-ms N        fail when a row's p95 per-operation time exceeds N ms
  --save NAME           also store the report as bench/baselines/NAME.json
  --compare NAME|PATH   compare with a saved report; pins its sample counts
  --max-regression PCT  fail when a median regresses beyond PCT (needs --compare)
  --help                this text`

const intOpt = (flag, raw, min = 1) => {
    const n = Number(raw)
    if (raw === undefined || raw === "" || !Number.isInteger(n) || n < min) {
        throw new OptionsError(`${flag} expects an integer >= ${min}, got ${JSON.stringify(raw)}`)
    }
    return n
}

const numOpt = (flag, raw) => {
    const n = Number(raw)
    if (raw === undefined || raw === "" || !Number.isFinite(n) || n <= 0) {
        throw new OptionsError(`${flag} expects a finite number > 0, got ${JSON.stringify(raw)}`)
    }
    return n
}

const listOpt = (flag, raw) => {
    const items = String(raw ?? "").split(",").map(s => s.trim()).filter(Boolean)
    if (items.length === 0) throw new OptionsError(`${flag} expects a comma-separated list`)
    return items
}

export function parseArgs(argv) {
    const o = {
        help: false, list: false, preset: 0, suites: [...SUITES], filter: [], sizes: null,
        iterations: null, warmup: null, modes: ["dev", "release"], isolate: true,
        output: DEFAULT_OUTPUT, format: "table", maxP95Ms: null, save: null,
        compare: null, maxRegression: null
    }
    let isolateFlag = null
    const args = [...argv]
    const next = flag => {
        if (args.length === 0) throw new OptionsError(`${flag} requires a value`)
        return args.shift()
    }
    while (args.length) {
        const flag = args.shift()
        switch (flag) {
            case "--": break
            case "--help": case "-h": o.help = true; break
            case "--list": o.list = true; break
            case "--quick": o.preset = 1; break
            case "--hard": o.preset = 2; break
            case "--suite": {
                o.suites = listOpt(flag, next(flag))
                for (const s of o.suites) {
                    if (!SUITES.includes(s)) throw new OptionsError(`unknown suite ${s}; expected ${SUITES.join("|")}`)
                }
                break
            }
            case "--filter": o.filter = listOpt(flag, next(flag)); break
            case "--sizes": o.sizes = listOpt(flag, next(flag)).map(v => intOpt(flag, v)); break
            case "--iterations": o.iterations = intOpt(flag, next(flag), 2); break
            case "--warmup": o.warmup = intOpt(flag, next(flag)); break
            case "--release": o.modes = ["release"]; break
            case "--dev": o.modes = ["dev"]; break
            case "--isolate": case "--in-process":
                if (isolateFlag && isolateFlag !== flag) throw new OptionsError("--isolate and --in-process conflict")
                isolateFlag = flag
                o.isolate = flag === "--isolate"
                break
            case "--output": o.output = next(flag); break
            case "--format": {
                o.format = next(flag)
                if (!["table", "markdown"].includes(o.format)) throw new OptionsError(`--format expects table|markdown, got ${o.format}`)
                break
            }
            case "--max-p95-ms": o.maxP95Ms = numOpt(flag, next(flag)); break
            case "--max-regression": o.maxRegression = numOpt(flag, next(flag)); break
            case "--save": o.save = next(flag); break
            case "--compare": o.compare = next(flag); break
            default: throw new OptionsError(`unknown option ${flag}; use --help`)
        }
    }
    if (argv.includes("--quick") && argv.includes("--hard")) throw new OptionsError("--quick and --hard conflict")
    if (o.maxRegression !== null && o.compare === null) throw new OptionsError("--max-regression requires --compare")
    if (o.save && !/^[\w.-]+$/.test(o.save)) throw new OptionsError(`--save NAME may contain only letters, digits, ._-; got ${o.save}`)
    o.presetName = ["default", "quick", "hard"][o.preset]
    o.budgetMs = PRESETS.budgetMs[o.preset]
    o.minSamples = PRESETS.minSamples[o.preset]
    o.maxSamples = PRESETS.maxSamples[o.preset]
    return o
}

// Sizes for a case of the given kind, honouring --sizes.
export function sizesFor(options, kind) {
    return options.sizes ?? SIZE_PRESETS[kind][options.preset]
}
