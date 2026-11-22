import assert from "node:assert/strict"
import { test } from "node:test"
import { Signal, Owner, __computed__, __field__, __render_effect__, __is__, effect, watch, batch, untrack, runWithOwner } from "../src/external/reactive.js"

const D = 5
const ERR = "err"
const FAIL = "fuzz: computed failed"
const THROW = "fuzz: effect threw"
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 400)
const STEPS = Number(process.env.FUZZ_STEPS ?? 40)
const ONLY = process.env.FUZZ_SEED === undefined ? null : Number(process.env.FUZZ_SEED)

function randomOf(seed) {
    let a = seed >>> 0
    const next = () => {
        a = (a + 0x6D2B79F5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const int = n => Math.floor(next() * n)
    return { int, pick: list => list[int(list.length)], chance: p => next() < p }
}

const num = v => v === ERR ? 3 : v
const mod = v => ((v % D) + D) % D
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function evaluate(node, get) {
    const [a, b, c] = node.deps
    switch (node.kind) {
        case "sum":
        case "field":
            return mod(node.deps.reduce((total, d) => total + get(d), node.k))
        case "pick":
            return get(a) % 2 === 0 ? get(b) : get(c)
        case "bucket":
            return Math.floor(get(a) / 2)
        case "shift":
        case "norm":
            return mod(get(a) + node.k)
        case "fail": {
            const value = get(a)
            if (value === node.at) throw new Error(FAIL)
            return value
        }
        case "derived":
            return mod(node.deps.reduce((total, d) => total + get(d), 1))
    }
    throw new Error("unknown node " + node.kind)
}

function readsOf(spec, get, is) {
    if (spec.kind === "is") return [is(spec.deps[0], spec.key)]
    if (spec.kind !== "gate") return spec.deps.map(get)
    const first = get(spec.deps[0])
    return num(first) % 2 === 0 ? [first, ...spec.deps.slice(1).map(get)] : [first]
}

function modelOf(spec, base) {
    const values = []
    spec.nodes.forEach((node, i) => {
        if (node.type === "signal") {
            values[i] = base[i]
            return
        }
        try {
            values[i] = evaluate(node, d => num(values[d]))
        } catch (error) {
            if (error.message !== FAIL) throw error
            values[i] = ERR
        }
    })
    return values
}

function effectOf(r, nodes) {
    const all = nodes.map((_, i) => i)
    const safe = all.filter(i => nodes[i].kind !== "fail")
    const kind = r.pick(["plain", "plain", "render", "watch", "gate", "is", "throw", "parent"])
    const deps = Array.from({ length: (kind === "gate" || kind === "parent" ? 2 : 1) + r.int(3) }, () => r.pick(all))
    if (kind === "is") return { kind, deps: [r.pick(safe)], key: r.int(D) }
    if (kind === "throw") return { kind, deps, at: r.int(D) }
    if (kind === "parent") return { kind, deps: deps.slice(0, 1), child: { kind: r.pick(["plain", "gate"]), deps: deps.slice(1) } }
    return { kind, deps }
}

function design(r, writers) {
    const nodes = []
    const pinned = []
    const normalize = {}
    const indices = () => nodes.map((_, i) => i)
    const deps = count => Array.from({ length: count }, () => r.pick(indices()))
    const signals = 2 + r.int(4)
    for (let i = 0; i < signals; i++) nodes.push({ type: "signal", init: r.int(D) })
    const computeds = 3 + r.int(10)
    for (let n = 0; n < computeds; n++) {
        if (writers && r.chance(0.2)) nodes.push({ type: "derived", kind: "derived", deps: deps(1 + r.int(2)), via: r.pick(["effect", "computed"]) })
        if (writers && r.chance(0.2)) {
            const free = indices().filter(i => nodes[i].type === "signal" && !(i in normalize))
            if (free.length) {
                const signal = r.pick(free)
                const trigger = r.int(D)
                const result = mod(trigger + 1 + r.int(D - 1))
                normalize[signal] = [trigger, result]
                let link = signal
                let offset = 0
                for (let left = 1 + r.int(3); left > 0; left--) {
                    const k = r.int(D)
                    offset += k
                    nodes.push({ type: "computed", kind: "shift", deps: [link], k })
                    link = nodes.length - 1
                }
                const rule = { signal, offset, trigger, result }
                if (r.chance(0.5)) {
                    nodes.push({ type: "computed", kind: "norm", deps: [link], k: 0, rule })
                    pinned.push({ deps: [nodes.length - 1] })
                } else pinned.push({ deps: [link], rule })
            }
        }
        const kind = r.pick(["sum", "sum", "pick", "bucket", "fail", "field", "shift"])
        const arity = { sum: 1 + r.int(3), field: 1 + r.int(3), pick: 3, bucket: 1, fail: 1, shift: 1 }[kind]
        nodes.push({ type: "computed", kind, deps: deps(arity), k: r.int(D), at: r.int(D) })
    }
    const effects = Array.from({ length: 2 + r.int(5) }, () => effectOf(r, nodes))
    return { nodes, pinned, normalize, effects }
}

function runSeed(seed, writers) {
    const r = randomOf(seed)
    const spec = design(r, writers)
    const ops = []
    const problems = []
    const records = []
    const ranComputed = new Map()
    const pulled = new Set()
    const nodes = []
    const root = new Owner(null)
    const signals = spec.nodes.map((node, i) => i).filter(i => spec.nodes[i].type === "signal")
    const computeds = spec.nodes.map((node, i) => i).filter(i => spec.nodes[i].type === "computed")
    const settle = (i, value) => spec.normalize[i] && spec.normalize[i][0] === value ? spec.normalize[i][1] : value
    const base = []
    for (const i of signals) base[i] = settle(i, spec.nodes[i].init)
    let current = modelOf(spec, base)
    let inBatch = false
    let finished = false

    const raw = node => {
        try {
            return node.v
        } catch (error) {
            if (error.message === FAIL) return ERR
            throw error
        }
    }
    const get = i => raw(nodes[i])
    const is = (i, key) => __is__(nodes[i], key, true)
    const expectedOf = effectSpec => readsOf(effectSpec, i => current[i], (i, key) => current[i] === key)
    const apply = rule => value => {
        if (mod(value - rule.offset) === rule.trigger) nodes[rule.signal].v = rule.result
    }

    const saw = (rec, reads) => {
        rec.stepRuns++
        if (finished) problems.push(`${rec.label} ran after everything was disposed`)
        if (rec.disposed) problems.push(`${rec.label} ran after it was disposed`)
        if (inBatch) problems.push(`${rec.label} ran inside a batch`)
        if (writers) {
            if (rec.stepRuns > 30) problems.push(`${rec.label} ran ${rec.stepRuns} times in one step`)
        } else {
            const expected = expectedOf(rec.spec)
            if (!same(reads, expected)) problems.push(`${rec.label} saw ${JSON.stringify(reads)} while the state gives ${JSON.stringify(expected)}`)
            if (rec.last !== null && same(reads, rec.last) && !reads.includes(ERR)) problems.push(`${rec.label} ran though nothing it reads changed: ${JSON.stringify(reads)}`)
            if (rec.stepRuns > 1) problems.push(`${rec.label} ran ${rec.stepRuns} times in one step`)
        }
        rec.last = reads
    }

    const addEffect = effectSpec => {
        const k = records.length
        const rec = { spec: effectSpec, label: `effect ${k} (${effectSpec.kind})`, last: null, stepRuns: 0, runs: 0, disposed: false, generation: 0, child: null }
        records.push(rec)
        const body = () => {
            rec.runs++
            const reads = readsOf(effectSpec, get, is)
            saw(rec, reads)
            if (effectSpec.kind === "throw" && rec.runs > 1 && num(reads[0]) === effectSpec.at) throw new Error(THROW)
            if (effectSpec.kind !== "parent") return
            const generation = ++rec.generation
            const child = rec.child = { spec: effectSpec.child, label: `child ${generation} of effect ${k}`, last: null, stepRuns: 0, disposed: false }
            effect(() => {
                if (generation !== rec.generation) problems.push(`${child.label} ran after its parent ran again or was disposed`)
                saw(child, readsOf(effectSpec.child, get, is))
            })
        }
        if (effectSpec.kind === "render") {
            const node = __render_effect__(body)
            rec.dispose = () => node.dispose()
        } else if (effectSpec.kind === "watch") {
            rec.dispose = watch(() => effectSpec.deps.map(get), reads => saw(rec, reads))
        } else rec.dispose = effect(body)
    }

    runWithOwner(root, () => {
        spec.nodes.forEach((node, i) => {
            if (node.type === "signal") nodes[i] = new Signal(node.init)
            else if (node.type === "derived") {
                nodes[i] = new Signal(0)
                const write = () => {
                    const value = evaluate(node, d => num(get(d)))
                    nodes[i].v = value
                    return value
                }
                if (node.via === "effect") effect(() => { write() })
                else {
                    const writer = __computed__(write)
                    effect(() => { writer.v })
                }
            } else {
                const normalizing = node.rule ? apply(node.rule) : null
                nodes[i] = (node.kind === "field" ? __field__ : __computed__)(() => {
                    ranComputed.set(i, (ranComputed.get(i) ?? 0) + 1)
                    const value = evaluate(node, d => num(get(d)))
                    if (normalizing) normalizing(value)
                    return value
                })
            }
        })
        for (const pin of spec.pinned) {
            const normalizing = pin.rule ? apply(pin.rule) : null
            effect(() => {
                const value = num(get(pin.deps[0]))
                if (normalizing) normalizing(value)
            })
        }
        spec.effects.forEach(addEffect)
    })

    const write = ([i, value]) => {
        base[i] = settle(i, value)
        nodes[i].v = value
    }

    const operations = {
        set(op) {
            base[op.i] = settle(op.i, op.value)
            current = modelOf(spec, base)
            nodes[op.i].v = op.value
        },
        batch(op) {
            batch(() => {
                inBatch = true
                try {
                    const [first, ...rest] = op.sets
                    for (const [i, value] of op.sets) base[i] = settle(i, value)
                    current = modelOf(spec, base)
                    write(first)
                    if (op.nested) batch(() => rest.forEach(write))
                    else rest.forEach(write)
                } finally {
                    inBatch = false
                }
            })
        },
        read(op) {
            pulled.add(op.i)
            const got = untrack(() => get(op.i))
            if (!same(got, current[op.i])) problems.push(`reading node ${op.i} gave ${JSON.stringify(got)}, the state gives ${JSON.stringify(current[op.i])}`)
        },
        dispose(op) {
            const rec = records[op.k]
            rec.disposed = true
            rec.generation++
            rec.dispose()
        },
        add(op) {
            runWithOwner(root, () => addEffect(op.spec))
        }
    }

    const choose = () => {
        const roll = r.int(10)
        if (roll < 5) return { op: "set", i: r.pick(signals), value: r.int(D) }
        if (roll < 7) {
            const chosen = [...new Set(Array.from({ length: 2 + r.int(2) }, () => r.pick(signals)))]
            return { op: "batch", sets: chosen.map(i => [i, r.int(D)]), nested: r.chance(0.5) }
        }
        if (roll < 8) return { op: "read", i: r.pick(computeds) }
        const live = records.map((rec, k) => k).filter(k => !records[k].disposed)
        if (roll < 9 && live.length) return { op: "dispose", k: r.pick(live) }
        return { op: "add", spec: effectOf(r, spec.nodes) }
    }

    const report = message => {
        const shown = ops.map(op => JSON.stringify(op)).join("\n  ")
        return `seed ${seed} (${writers ? "with writers" : "pure"}), step ${ops.length}: ${message}\nnodes: ${JSON.stringify(spec.nodes)}\npinned: ${JSON.stringify(spec.pinned)}\neffects: ${JSON.stringify(spec.effects)}\nops:\n  ${shown}`
    }

    const check = observedBefore => {
        for (const i of spec.nodes.keys()) {
            if (spec.nodes[i].type === "computed") continue
            if (!same(nodes[i].peek(), current[i])) problems.push(`state ${i} holds ${nodes[i].peek()}, the model gives ${current[i]}`)
        }
        for (const rec of records) {
            if (rec.disposed) continue
            if (!same(rec.last, expectedOf(rec.spec))) problems.push(`${rec.label} last saw ${JSON.stringify(rec.last)}, the state gives ${JSON.stringify(expectedOf(rec.spec))}`)
            if (rec.child && !same(rec.child.last, expectedOf(rec.child.spec))) problems.push(`${rec.child.label} last saw ${JSON.stringify(rec.child.last)}, the state gives ${JSON.stringify(expectedOf(rec.child.spec))}`)
        }
        for (const [i, count] of ranComputed) {
            if (writers ? count > 30 : count > 1) problems.push(`computed ${i} ran ${count} times in one step`)
            if (!writers && !observedBefore.has(i) && !nodes[i].observers?.length && !pulled.has(i)) problems.push(`computed ${i} ran though nothing reads it`)
        }
    }

    if (problems.length) return report(problems.join("\n"))
    for (const rec of records) if (!same(rec.last, expectedOf(rec.spec))) return report(`${rec.label} first saw ${JSON.stringify(rec.last)}, the state gives ${JSON.stringify(expectedOf(rec.spec))}`)

    for (let step = 0; step < STEPS; step++) {
        const op = choose()
        ops.push(op)
        ranComputed.clear()
        pulled.clear()
        for (const rec of records) {
            rec.stepRuns = 0
            if (rec.child) rec.child.stepRuns = 0
        }
        const observedBefore = new Set(computeds.filter(i => nodes[i].observers?.length))
        try {
            operations[op.op](op)
        } catch (error) {
            if (error.message !== THROW) problems.push(`the step threw ${error.stack}`)
        }
        check(observedBefore)
        if (problems.length) return report(problems.join("\n"))
    }

    finished = true
    try {
        root.dispose()
    } catch (error) {
        return report(`dispose threw ${error.stack}`)
    }
    for (const [i, node] of nodes.entries()) {
        const left = (node.observers ?? []).filter(o => !o.isWatcher)
        if (left.length) return report(`node ${i} still has ${left.length} observers after everything was disposed`)
    }
    for (const i of signals) {
        try {
            nodes[i].v = mod(nodes[i].peek() + 1)
        } catch (error) {
            return report(`a write after dispose threw ${error.stack}`)
        }
    }
    if (problems.length) return report(problems.join("\n"))
    return null
}

function fuzz(writers) {
    const seeds = ONLY === null ? Array.from({ length: SEEDS }, (_, i) => i + 1) : [ONLY]
    for (const seed of seeds) {
        let failure
        try {
            failure = runSeed(seed, writers)
        } catch (error) {
            failure = `seed ${seed} (${writers ? "with writers" : "pure"}) threw while building: ${error.stack}`
        }
        if (failure) assert.fail(failure)
    }
}

test("random graphs of states, computeds and effects agree with a model that recomputes everything, run each effect once and stay lazy", () => {
    fuzz(false)
})

test("random graphs where effects and computeds write states settle where the model does", () => {
    fuzz(true)
})
