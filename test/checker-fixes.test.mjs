import assert from "node:assert/strict"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { transform } from "../src/transform.js"

function messages(source, file = "check.slim") {
    try {
        transform(source, file)
    } catch (error) {
        if (error.slimTypeErrors) return error.slimTypeErrors.filter(diagnostic => diagnostic.severity !== "warning").map(diagnostic => diagnostic.message)
        throw error
    }
    return []
}

function accepted(source) {
    assert.deepEqual(messages(source), [], "expected no diagnostics")
}

function rejected(source, pattern) {
    const found = messages(source)
    assert.ok(found.some(message => pattern.test(message)), `expected ${pattern}, got ${JSON.stringify(found)}`)
}

function warned(source, pattern) {
    const found = transform(source, "check.slim").warnings.map(diagnostic => diagnostic.message)
    assert.ok(found.some(message => pattern.test(message)), `expected ${pattern}, got ${JSON.stringify(found)}`)
}

const P = "struct P { x: string }\n"
const OUT = "enum In {\n    A\n    B\n}\nenum Out {\n    W(i: In)\n    E\n}\n"

test("recursive aliases are compared without overflowing the stack", () => {
    accepted(`type Json = string | int | Json[]\nfunc f(a: Json[]) { const b: Json = a[0]\n log(b) }`)
    accepted(`type N = { v: int, next: N? }\nfunc g(n: N) { log(n) }\nfunc f(n: N) { g(n) }`)
    accepted(`type F = (n: int) => F\nconst f: F = n => f`)
    accepted(`type Tree = int | Tree[]\nfunc g(t: Tree) { log(t) }\nfunc f(t: Tree[]) { g(t[0]) }`)
    accepted(`type Json = string | int | bool | null | Json[] | Record<string, Json>\nfunc walk(j: Json) -> int {\n    if (Array.isArray(j)) return j.map(walk).reduce((a, b) => a + b, 0)\n    return 1\n}`)
    rejected(`type Json = string | int | Json[]\nlet x: Json = [1, ["a", [true]]]`, /"x" expects Json/)
})

test("type argument counts are checked", () => {
    rejected(`struct Box<T> { v: T }\nlet b: Box<int, string> = Box.new({ v: 1 })`, /"Box" takes 1 type argument, got 2/)
    rejected(`struct P { x: int }\nlet p: P<int> = { x: 1 }`, /"P" has no type parameters/)
    rejected(`let r: Record<string> = {}`, /"Record" takes 2 type arguments, got 1/)
    rejected(`let m: Map<string, int, int> = new Map()`, /"Map" takes 2 type arguments, got 3/)
    accepted(`func* g() -> Generator<int> { yield 1 }\nlet m: Map<string, int> = new Map()\nlog(g, m)`)
})

test("struct subtypes fit their parent everywhere", () => {
    const structs = `struct A { x: int }\nstruct B extends A { y: int }\n`
    accepted(`${structs}const a: A = B.new({ x: 1, y: 2 })\nconst as: A[] = [B.new({ x: 1, y: 2 })]\nfunc f() -> A { return B.new({ x: 1, y: 2 }) }\nfunc g(bs: B[]) { const xs: A[] = bs\n log(xs) }`)
    rejected(`${structs}func g(a: A) { const b: B = a }`, /"b" expects B, got A/)
})

test("computed member access narrows when key and object stay put", () => {
    accepted(`func f(out: Record<string, int[]>, k: string) {\n    if (!out[k]) out[k] = []\n    out[k].push(1)\n}`)
    accepted(`func f(out: Record<string, int[]>, k: string) {\n    if (out[k] != undefined) out[k].push(1)\n}`)
    accepted(`func f(xs: (int | null)[], i: int) -> int {\n    if (xs[i] != null) return xs[i] + 1\n    return 0\n}`)
    warned(`func f(out: Record<string, int[]>, k: string) {\n    if (out[k] != undefined) { k = "z"; out[k].push(1) }\n}`, /"out\[k\]" may be undefined/)
    warned(`func f(out: Record<string, int[]>, k: string, o: Record<string, int[]>) {\n    if (out[k] != undefined) { out = o; out[k].push(1) }\n}`, /"out\[k\]" may be undefined/)
})

test("logical assignments narrow", () => {
    accepted(`func f() {\n    let m: Map<string, int>? = null\n    m ??= new Map()\n    m.set("a", 1)\n}`)
    accepted(`class C {\n    items?: int[]\n    add(x: int) {\n        this.items ??= []\n        this.items.push(x)\n    }\n}`)
    accepted(`func f(s: string?) -> int {\n    s ||= "x"\n    return s.length\n}`)
    warned(`func f(s: string?) -> int {\n    s &&= "x"\n    return s.length\n}`, /"s" may be null/)
})

test("else-if chains that exit narrow by every test", () => {
    accepted(`func f(x: string?, y: string?) -> int {\n    if (x == null) return 0\n    else if (y == null) return 1\n    return x.length + y.length\n}`)
    accepted(`func f(x: int | string | bool) -> int {\n    if (typeof x == "string") { return 1 } else if (typeof x == "boolean") { return 2 }\n    return x\n}`)
    warned(`func f(x: string?, y: string?) -> int {\n    if (x == null) return 0\n    else if (y == null) log(1)\n    return x.length + y.length\n}`, /"y" may be null/)
})

test("switch narrows in default and is exhaustive after earlier narrowing", () => {
    const S = "enum S {\n    A\n    B\n    C\n}\n"
    accepted(`func f(x: "a" | "b" | "c") -> int {\n    switch (x) {\n        case "a": return 1\n        default: { const y: "b" | "c" = x\n            return 2 }\n    }\n}`)
    accepted(`${S}func f(s: S) -> int {\n    if (s == S.A) return 0\n    switch (s) {\n        case S.B: return 1\n        case S.C: return 2\n    }\n}`)
    rejected(`${S}func f(s: S) -> int {\n    switch (s) {\n        case S.B: return 1\n        case S.C: return 2\n    }\n}`, /does not handle S\.A/)
    accepted(`func f(x: int | string) -> int {\n    switch (typeof x) {\n        case "string": return x.length\n        default: return x\n    }\n}`)
    rejected(`func f(x: "a" | "b") -> int {\n    switch (x) {\n        case "a":\n        default: { const y: "b" = x\n            return 2 }\n    }\n}`, /"y" expects "b", got \("a" \| "b"\)/)
})

test("narrowing everything away leaves never", () => {
    const never = `func assertNever(x: never) -> never { throw new Error("x") }\n`
    accepted(`${never}func f(x: "a" | "b") -> int {\n    if (x == "a") return 1\n    if (x == "b") return 2\n    return assertNever(x)\n}`)
    accepted(`${never}enum S {\n    A\n    B\n}\nfunc f(s: S) -> int {\n    if (s == S.A) return 1\n    if (s == S.B) return 2\n    return assertNever(s)\n}`)
    accepted(`${never}func f(x: int | string) -> int {\n    if (typeof x == "string") return 1\n    if (typeof x == "number") return 2\n    return assertNever(x)\n}`)
    rejected(`${never}func f(x: "a" | "b" | "c") -> int {\n    if (x == "a") return 1\n    if (x == "b") return 2\n    return assertNever(x)\n}`, /expects never, got "c"/)
    accepted(`func f(a: int?) -> int { return a != null ? a : (a != null ? a : 0) }`)
})

test("filter narrows its element type", () => {
    accepted(`func f(xs: (int | null)[]) -> int[] { return xs.filter(x => x != null) }`)
    accepted(`func f(xs: (int | undefined)[]) -> int[] { return xs.filter(x => { return x !== undefined }) }`)
    accepted(`func f(xs: (string | null | undefined)[]) -> string[] { return xs.filter(Boolean) }`)
    accepted(`func f(xs: (int | string)[]) -> string[] { return xs.filter(x => typeof x == "string") }`)
    accepted(`struct C {\n    kind: "c"\n    r: float\n}\nstruct S {\n    kind: "s"\n    side: float\n}\nfunc f(xs: (C | S)[]) -> C[] { return xs.filter(x => x.kind == "c") }`)
    rejected(`func f(xs: (int | null)[]) -> int[] { return xs.filter(x => true) }`, /"f" must return int\[\], got \(int \| null\)\[\]/)
})

test("generic inference skips null arguments and widens numbers", () => {
    accepted(`func orDefault<T>(x: T?, d: T) -> T { return x ?? d }\nlet n: int = orDefault(null, 3)`)
    accepted(`func pair<T>(a: T, b: T) -> T[] { return [a, b] }\nlet r: float[] = pair(1, 1.5)`)
    rejected(`func pair<T>(a: T, b: T) -> T[] { return [a, b] }\npair(1, "x")`, /argument "b" of "pair" expects int, got string/)
})

test("type parameter constraints may mention type parameters", () => {
    accepted(`trait Cmp<T> { cmp(o: T) -> int }\nfunc f<T extends Cmp<T>>(a: T, b: T) -> int { return a.cmp(b) }`)
    accepted(`func f<K, V extends K[]>(k: K, v: V) -> int { return v.length }\nlog(f(1, [2]))`)
})

test("nested match patterns count toward exhaustiveness", () => {
    accepted(`${OUT}func f(o: Out) -> int { return match (o) { Out.W(In.A) => 1, Out.W(In.B) => 2, Out.E => 3 } }`)
    accepted(`func f(r: Result<Option<int>, string>) -> int { return match (r) { Result.Ok(Option.Some(n)) => n, Result.Ok(Option.None) => 0, Result.Err(e) => -1 } }`)
    accepted(`enum Out {\n    W(b: bool)\n    E\n}\nfunc f(o: Out) -> int { return match (o) { Out.W(true) => 1, Out.W(false) => 2, Out.E => 3 } }`)
    accepted(`func f(t: [bool, bool]) -> int { return match (t) { [true, true] => 1, [true, false] => 2, [false, _] => 3 } }`)
    rejected(`${OUT}func f(o: Out) -> int { return match (o) { Out.W(In.A) => 1, Out.E => 3 } }`, /match on "Out" does not handle Out\.W\(In\.B\)/)
    rejected(`func f(t: [bool, bool]) -> int { return match (t) { [true, true] => 1, [false, _] => 3 } }`, /does not handle \[true, false\]/)
    const missing = messages(`${OUT}func f(o: Out) -> int { return match (o) { Out.W(In.A) => 1, Out.E => 3 } }`)
    assert.ok(!missing.some(message => /check it for undefined/.test(message)), JSON.stringify(missing))
    rejected(`enum Out {\n    W(s: int)\n    E\n}\nfunc g(o: Out) -> int { return match (o) { Out.W(x) when x > 1 => 1, Out.W(2) => 3, Out.E => 2 } }`, /the match gives undefined when no case fits/)
})

test("object literals returned from functions are checked against structs", () => {
    accepted(`${P}const ps: P[] = [1, 2].map(n => ({ x: "s" + n }))`)
    accepted(`${P}func mk() { return { x: "s" } }\nconst p: P = mk()`)
    rejected(`${P}const ps: P[] = [1, 2].map(n => ({ x: n }))`, /"ps" expects P\[\], got \{ x: int \}\[\]/)
    rejected(`${P}func mk() { return { x: 1 } }\nconst p: P = mk()`, /"p" expects P, got \{ x: int \}/)
    rejected(`${P}func mk() { return { x: "a", y: 1 } }\nconst p: P = mk()`, /"p" expects P/)
    accepted(`func mk() { return { a: 1 } }\nconst o = mk()\nlog(o.a)`)
})

test("a promise used as a condition is always true", () => {
    const ok = "async func ok() -> bool { return false }\n"
    rejected(`${ok}async func f() { if (ok()) log(1) }`, /is Promise<bool>, so this condition is always true — await it/)
    rejected(`${ok}async func f() { if (!ok()) log(1) }`, /always true — await it/)
    rejected(`${ok}func f() -> int { return ok() ? 1 : 0 }`, /always true — await it/)
    rejected(`${ok}func f(x: int) { const y = ok() && x\n log(y) }`, /always true — await it/)
    rejected(`${ok}func f() { const p = ok()\n if (p) log(1) }`, /"p" is Promise<bool>, so this condition is always true — await it: await p/)
    accepted(`${ok}async func f() { if (await ok()) log(1) }`)
})

test("async return types and promise diagnostics", () => {
    accepted(`async func f() -> Promise<int> { return 1 }`)
    accepted(`async func g() -> int { return 1 }\nasync func h() -> int { return g() }`)
    rejected(`async func g() -> string { return "a" }\nasync func h() -> int { return g() }`, /"h" must return int, got Promise<string>/)
    rejected(`class C {\n    async load() -> int { return 1 }\n    async run() { this.load() }\n}`, /write "void this\.load\(\.\.\.\)"/)
    rejected(`func f(m: "a" | "b" | "c") {\n    if (m == "a") return\n    if (m == "b") return\n    let k: int = m\n}`, /"k" expects int, got "c"/)
})

test("smaller narrowing and builtin fixes", () => {
    accepted(`func f() {\n    let x: int? = null\n    while (x == null) { x = 1 }\n    log(x + 1)\n}`)
    accepted(`func f(a: string?) -> int {\n    const ok = a != null\n    if (ok) return a.length\n    return 0\n}`)
    accepted(`struct C {\n    kind: "c"\n    r: float\n}\nstruct S {\n    kind: "s"\n    side: float\n}\nfunc area(s: C | S) -> float {\n    const { kind } = s\n    if (kind == "c") return s.r\n    return 0.0\n}`)
    accepted(`func f(r: Record<"a" | "b", int>) -> int { return r.a + r["b"] }`)
    rejected(`let q: Record<"a" | "b", int> = { a: 1 }`, /"q" is missing the key "b"/)
    accepted(`func f(x: int?) -> int {\n    if (x == null) process.exit(1)\n    return x\n}`)
    accepted(`func f(a: int) -> int { return Math.pow(a, 2) }`)
    accepted(`class K { run?: () => void }\nfunc f(c: K) { if (c.run) c.run() }`)
})

test("long expressions check in near-linear time", () => {
    const sources = count => [
        `func f(s: string) {
    let x = ${Array.from({ length: count }, () => "s").join(" + ")}
    log(x)
}`,
        `func f(s: int?) { if (${Array.from({ length: count }, () => "s != null").join(" && ")}) log(s) }`,
        `const r = [1]${".map(x => x)".repeat(count / 2)}
log(r)`
    ]
    const timed = count => {
        const started = performance.now()
        for (const source of sources(count)) accepted(source)
        return performance.now() - started
    }
    timed(100)
    const small = Math.min(timed(200), timed(200))
    const large = timed(800)
    assert.ok(large < small * 8 + 300, `4x longer expressions took ${Math.round(large)}ms vs ${Math.round(small)}ms`)
})

test("destructured exports are visible to importers compiled later", () => {
    const dir = path.join(os.tmpdir(), `slim-checker-fixes-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    try {
        const shared = path.join(dir, "shared.slim")
        const source = `export const { a, b } = { a: 1, b: 2 }\nexport const [c] = [3]\n`
        writeFileSync(shared, source)
        transform(source, shared)
        const index = path.join(dir, "index.slim")
        const importer = `use { a, b, c } from "./shared"\nlog(a, b, c)\n`
        writeFileSync(index, importer)
        assert.deepEqual(messages(importer, index), [])
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("an alias that refers to itself without a structure in between is a compile error", () => {
    const cycle = /refers to itself without a structure in between/
    rejected(`type A = B\ntype B = A\nlet x: A = 1`, /type "A" refers to itself without a structure in between \(A → B → A\)/)
    rejected(`type A = A\nlet x: A = 1`, cycle)
    rejected(`type I = I & int\nlet x: I = 1`, cycle)
    rejected(`type A = A | int\nlet x: A = 1`, cycle)
    rejected(`type A = A?\nlet x: A = null`, cycle)
    rejected(`type Id<T> = T\ntype X = Id<X>\nlet x: X = 1`, cycle)
    rejected(`type G<T> = T | G<T[]>\nlet x: G<int> = 1`, cycle)
    accepted(`type A = A[]\nlet x: A = [[]]`)
    accepted(`type A = int | A[]\nlet x: A = [1, [2]]`)
})

test("generic aliases are expanded", () => {
    rejected(`type L<T> = T | L<T>[]\nlet y: L<int> = ["a"]`, /"y" expects L<int>, got string\[\]/)
    accepted(`type L<T> = T | L<T>[]\nlet y: L<int> = [1, [2, [3]]]`)
    rejected(`type Box<T> = { v: T }\nlet b: Box<int> = { v: "s" }`, /expects int, got string/)
    rejected(`type Box<T> = { v: T }\nlet b: Box<int, int> = { v: 1 }`, /"Box" takes 1 type argument, got 2/)
})

test("narrowed values are not reported in functions with a declared return type", () => {
    accepted(`func g(s: string?) -> int {\n    if (s == null) return 0\n    s.trim()\n    return 1\n}`)
    accepted(`async func g(s: string?) -> int {\n    if (s == null) return 0\n    s.trim()\n    return 1\n}`)
    accepted(`struct C { items?: int[] }\nfunc g(c: C) -> int {\n    if (!c.items) c.items = []\n    c.items.push(1)\n    return 0\n}`)
    accepted(`class Q {\n    items: int[]? = null\n    add(x: int) -> int {\n        if (this.items == null) this.items = []\n        this.items.push(x)\n        return this.items.length\n    }\n}`)
    accepted(`func g(out: Record<string, int[]>, k: string) -> int {\n    if (!out[k]) out[k] = []\n    out[k].push(1)\n    return 0\n}`)
    accepted(`func g() -> int {\n    let m: Map<string, int>? = null\n    m ??= new Map()\n    m.set("a", 1)\n    return 1\n}`)
})

test("assigning an object literal keeps the declared struct type", () => {
    const E = "struct E { v: int }\n"
    rejected(`${E}func f(e: E) {\n    e = { v: 1 }\n    let s: string = e.v\n}`, /"s" expects string, got int/)
    rejected(`${E}func f(e: E) {\n    e = { v: 1 }\n    log(e.nope)\n}`, /"E" has no field "nope"/)
    rejected(`${E}let e: E = { v: 1 }\ne = { v: 2 }\nlog(e.nope)`, /"E" has no field "nope"/)
    rejected(`${E}struct H { e: E }\nfunc f(h: H) {\n    h.e = { v: 2 }\n    log(h.e.nope)\n}`, /"E" has no field "nope"/)
    rejected(`${E}func f(e: E) { e = { v: "s", w: 1 } }`, /"E" has no field "w"/)
    accepted(`${E}func f(e: E?) {\n    if (e == null) e = { v: 1 }\n    log(e.v)\n}`)
})

test("object shapes fit Record types", () => {
    accepted(`const o = { a: 1, b: 2 }\nconst r: Record<string, int> = o`)
    accepted(`func mk() { return { a: 1 } }\nconst r: Record<string, int> = mk()`)
    accepted(`const rs: Record<string, int>[] = [1].map(n => ({ a: n }))`)
    accepted(`func mk() { return { a: 1, b: 2 } }\nconst r: Record<"a" | "b", int> = mk()`)
    rejected(`func mk() { return { a: 1 } }\nconst r: Record<"a" | "b", int> = mk()`, /"r" expects Record<"a" \| "b", int>/)
    rejected(`func mk() { return { a: "s" } }\nconst r: Record<string, int> = mk()`, /"r" expects Record<string, int>, got \{ a: string \}/)
    rejected(`func mk() { return { a: { x: "s" } } }\nconst r: Record<string, { x: int }> = mk()`, /got \{ a: \{ x: string \} \}/)
})

test("computed keys with member, call and template keys", () => {
    accepted(`struct U { name: string }\nfunc f(us: U[]) {\n    const out: Record<string, U[]> = {}\n    for (const u of us) {\n        if (!out[u.name]) out[u.name] = []\n        out[u.name].push(u)\n    }\n}`)
    accepted("func f(out: Record<string, int[]>, a: string) {\n    if (!out[`x${a}`]) return\n    log(out[`x${a}`].length)\n}")
    warned(`func f(out: Record<string, int[]>, c: { k: string }) { log(out[c.k].length) }`, /"out\[c\.k\]" may be undefined/)
    warned(`func key() -> string { return "a" }\nfunc f(out: Record<string, int[]>) { log(out[key()].length) }`, /"out\[key\(\.\.\.\)\]" may be undefined/)
    warned(`struct U { name: string }\nfunc f(out: Record<string, int[]>, u: U) {\n    if (!out[u.name]) return\n    u.name = "z"\n    log(out[u.name].length)\n}`, /may be undefined/)
})

test("mutations drop narrowing of indexed values", () => {
    warned(`func f(o: Record<string, int[]>, k: string) {\n    if (!o[k]) return\n    delete o[k]\n    log(o[k].length)\n}`, /"o\[k\]" may be undefined/)
    warned(`func f(xs: (int | null)[], i: int) -> int {\n    if (xs[i] == null) return 0\n    xs.shift()\n    return xs[i] + 1\n}`, /"xs\[i\]" may be null/)
    warned(`func f(o: Record<string, int[]>, j: string) {\n    if (!o["a"]) return\n    o[j] = undefined\n    log(o["a"].length)\n}`, /may be undefined/)
    accepted(`func f(xs: (int | null)[], i: int) -> int {\n    if (xs[i] == null) return 0\n    xs.push(1)\n    return xs[i] + 1\n}`)
})

test("an aliased condition stops narrowing once its subject is written", () => {
    warned(`func f(a: string?, b: string?) -> int {\n    const ok = a != null\n    a = b\n    if (ok) return a.length\n    return 0\n}`, /"a" may be null/)
    accepted(`func f(a: string?) -> int {\n    const ok = a != null\n    if (ok) return a.length\n    return 0\n}`)
})

test("plain objects don't pass for structs that need methods or defaults", () => {
    rejected(`struct P {\n    x: int\n    y: int = 0\n}\nfunc mk() { return { x: 1 } }\nconst p: P = mk()`, /a plain object gets no defaults/)
    rejected(`struct P {\n    x: int\n    dbl() -> int { return this.x * 2 }\n}\nfunc mk() { return { x: 1 } }\nconst p: P = mk()`, /a plain object has none of "P"'s methods/)
    rejected(`struct P { x: int }\nstruct Q {\n    x: int\n    z: int\n}\nfunc mk(q: Q) { return { ...q } }\nconst p: P = mk(Q.new({ x: 1, z: 2 }))`, /P has no field "z"/)
    rejected(`struct In { a: int }\nstruct P { i: In }\nfunc mk() { return { i: { a: "s" } } }\nconst p: P = mk()`, /"p" expects P, got \{ i: \{ a: string \} \}/)
    accepted(`struct In { a: int }\nstruct P { i: In }\nfunc mk() { return { i: { a: 1 } } }\nconst p: P = mk()`)
})

test("exact records give their value type and reject unknown keys", () => {
    accepted(`func f(r: Record<"a" | "b", int>, k: "a" | "b") -> int { return r[k] }`)
    accepted(`func f(r: Record<1 | 2, string>) -> int { return r[1].length }`)
    rejected(`func f(r: Record<"a" | "b", int>) { r.c = 3 }`, /it has no key "c"/)
    rejected(`func f(r: Record<"a" | "b", int>) { r.a = "x" }`, /"r\.a" expects int, got string/)
    accepted(`func f(r: Record<"a" | "b", int>) {\n    r.a = 3\n    r["b"] = 4\n}`)
})

test("arithmetic on unions has a type", () => {
    rejected(`func f(x: int | string) -> int { return x + 1 }`, /"f" must return int, got \(int \| string\)/)
    accepted(`func f(x: int | float) -> float { return x + 1 }`)
})

test("object and array patterns count toward exhaustiveness", () => {
    const P = "struct P {\n    ok: bool\n    n: int\n}\n"
    accepted(`${P}func f(p: P) -> int { return match (p) { { ok: true } => 1, { ok: false } => 0 } }`)
    rejected(`${P}func f(p: P) -> int { return match (p) { { ok: true } => 1 } }`, /does not handle P \{ ok: false \}/)
    accepted(`func f(xs: int[]) -> int { return match (xs) { [] => 0, [x] => 1, [x, y, ...r] => 2 } }`)
    rejected(`func f(xs: int[]) -> int { return match (xs) { [] => 0, [x] => 1 } }`, /does not handle \[_, _, \.\.\.\]/)
    const shapes = "struct Circle {\n    kind: \"c\"\n    r: float\n}\nstruct Square {\n    kind: \"s\"\n    side: float\n}\n"
    accepted(`${shapes}func f(s: Circle | Square) -> float { return match (s) { { kind: "c" } => 1.0, { kind: "s" } => 2.0 } }`)
    rejected(`${shapes}func f(s: Circle | Square) -> float { return match (s) { { kind: "c" } => 1.0 } }`, /does not handle Square/)
})

test("switch (true) narrows by its case conditions", () => {
    accepted(`func f(m: int | string) -> int {\n    switch (true) {\n        case typeof m === "string": return m.length\n        default: return m\n    }\n}`)
})

test("a promise anywhere in a condition is reported", () => {
    const ok = "async func ok() -> bool { return false }\n"
    rejected(`${ok}async func f(flag: bool) { if (flag && ok()) log(1) }`, /always true — await it/)
    rejected(`${ok}async func f(a: bool, b: bool) { while (a || (b && ok())) log(1) }`, /always true — await it/)
    accepted(`${ok}func f(flag: bool) {\n    const p = flag && ok()\n    log(p)\n}`)
})

test("a type mismatch past the depth limit is not accepted", () => {
    const deep = (base, depth) => base + "[]".repeat(depth)
    rejected(`func f(x: ${deep("int", 205)}) {\n    let z: ${deep("string", 205)} = x\n}`, /"z" expects/)
})

test("F-bounded constraint messages name the constraint once", () => {
    rejected(`trait Cmp<T> { compare(o: T) -> int }\nstruct M { c: int }\nfunc maxOf<T extends Cmp<T>>(xs: T[]) -> T { return xs[0] }\nmaxOf([M.new({ c: 1 })])`,
        /must fit Cmp<M>, got M/)
})

test("callbacks inside object literals get the expected parameter types", () => {
    const head = "trait Thing { x: float }\ntrait Spec { die?: (e: Thing) => void }\ntrait Need { die: (e: Thing) => void }\ntrait Api { define: (kind: string, spec: Spec) => void }\nglobal api: Api\nfunc define(spec: Spec) -> void {}\nfunc defineNeed(spec: Need) -> void {}\n"
    const bogus = /"Thing" has no field "bogus"/
    rejected(`${head}define({ die: (e) => { log(e.bogus) } })`, bogus)
    rejected(`${head}defineNeed({ die: (e) => { log(e.bogus) } })`, bogus)
    rejected(`${head}api.define("zz", { die: (e) => { log(e.bogus) } })`, bogus)
    rejected(`${head}const spec: Spec = { die: (e) => log(e.bogus) }`, bogus)
    rejected(`${head}define({ die(e) { log(e.bogus) } })`, bogus)
    accepted(`${head}define({ die: (e) => { log(e.x) } })`)
})

test("Object.prototype names are ordinary names", () => {
    accepted(`const o = { a: 1 }\no.__proto__ = null`)
    accepted(`const o = { a: 1 }\no.toString = () => "y"`)
    rejected(`log(constructor)`, /"constructor" is not defined/)
    rejected(`struct S {\n    constructor: int\n    toString: string\n    valueOf: int\n}\nconst s: S = { constructor: 1, toString: "a", valueOf: 2 }\nlet k: int = s.toString`, /"k" expects int, got string/)
})

test("a namespace re-export is an export", () => {
    const dir = path.join(os.tmpdir(), `slim-checker-ns-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    try {
        const files = {
            "store.slim": `export func get() -> int { return 1 }\n`,
            "lib.slim": `export * as store from "./store"\n`,
            "index.slim": `use { store } from "./lib"\nlog(store)\n`
        }
        for (const [name, source] of Object.entries(files)) writeFileSync(path.join(dir, name), source)
        transform(files["store.slim"], path.join(dir, "store.slim"))
        transform(files["lib.slim"], path.join(dir, "lib.slim"))
        assert.deepEqual(messages(files["index.slim"], path.join(dir, "index.slim")), [])
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("type parameter defaults lower the required argument count", () => {
    accepted(`type Pair<A, B = A> = [A, B]\nlet p: Pair<int> = [1, 2]`)
    rejected(`type Pair<A, B = A> = [A, B]\nlet p: Pair<int> = [1, "x"]`, /"p" expects Pair<int>, got \[int, string\]/)
    rejected(`type Pair<A, B = A> = [A, B]\nlet p: Pair<int, int, int> = [1, 2]`, /"Pair" takes 1 to 2 type arguments, got 3/)
    accepted(`func f<T, U = T>(a: T, b: U) -> U { return b }\nlog(f<int>(1, 2))`)
    rejected(`func f<T, U = T>(a: T, b: U) -> U { return b }\nlog(f<int, int, int>(1, 2))`, /"f" takes 1 to 2 type arguments, got 3/)
    accepted(`struct S<T, U = int> {\n    a: T\n    b: U\n}\nlet s: S<string> = { a: "x", b: 1 }`)
    rejected(`struct S<T, U = int> {\n    a: T\n    b: U\n}\nlet s: S<string> = { a: "x", b: "y" }`, /"S<string>\.b" expects int, got string/)
})

test("constraints that mention other type parameters are checked", () => {
    rejected(`func f<K, V extends K[]>(k: K, v: V) -> int { return v.length }\nlog(f(1, ["a"]))`, /type parameter "V" of "f" must fit int\[\], got string\[\]/)
    accepted(`func f<K, V extends K[]>(k: K, v: V) -> int { return v.length }\nlog(f(1, [2]))`)
})

test("strings and arrays fit traits made of their members", () => {
    accepted(`trait Longest { length: float }\nfunc longest<T extends Longest>(a: T, b: T) -> T { return a.length >= b.length ? a : b }\nlog(longest("ab", "c"))\nlog(longest([1, 2], [3]))`)
    rejected(`trait Longest { length: float }\nfunc longest<T extends Longest>(a: T, b: T) -> T { return a }\nlog(longest(1, 2))`, /must fit Longest, got int/)
    accepted(`trait Up { toUpperCase() -> string }\nfunc f<T extends Up>(a: T) -> string { return a.toUpperCase() }\nlog(f("a"))`)
})

test("host globals narrow like constants", () => {
    const dir = path.join(os.tmpdir(), `slim-checker-host-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    try {
        const host = path.join(dir, "host.slim")
        const hostSource = `trait KitApi { giveItem(id: string) -> void }\nglobal kit: KitApi | undefined\nglobal let counter: int?\n`
        writeFileSync(host, hostSource)
        transform(hostSource, host)
        const check = source => {
            try {
                transform(source, path.join(dir, "index.slim"), { host })
            } catch (error) {
                if (error.slimTypeErrors) return error.slimTypeErrors.map(diagnostic => diagnostic.message)
                throw error
            }
            return []
        }
        assert.deepEqual(check(`if (kit) kit.giveItem("x")`), [])
        assert.deepEqual(check(`if (counter != null) log(counter + 1)`), [])
        const warnings = transform(`kit.giveItem("x")`, path.join(dir, "index.slim"), { host }).warnings.map(diagnostic => diagnostic.message)
        assert.ok(warnings.some(message => /"kit" may be undefined/.test(message)))
        assert.ok(check(`if (counter != null) {\n    counter = null\n    log(counter + 1)\n}`).some(message => /"counter" is null here/.test(message)))
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("a misplaced ? is reported once", () => {
    const found = messages(`func parsePort(raw: string) -> Result<int, string> { return Result.Ok(1) }\nfunc port(raw: string) -> int { return parsePort(raw)? }`)
    assert.equal(found.length, 1, JSON.stringify(found))
    assert.match(found[0], /"\?" returns the Err from "port", but "port" returns int/)
})

test("comparing an enum member with a raw value is always false", () => {
    const Role = "enum Role {\n    Member: 0\n    Admin: 2\n}\n"
    rejected(`${Role}struct U { role: int }\nfunc f(u: U) -> bool { return u.role == Role.Member }`, /always false: "Role\.Member" is a Role member and int is a raw value — compare with Role\.from\(u\.role\)/)
    rejected(`${Role}func f(x: Role) -> bool { return x === 0 }`, /always false: "x" is a Role member/)
    rejected(`${Role}func f(x: Role) -> bool { return 0 != x }`, /always true: "x" is a Role member/)
    accepted(`${Role}func f(x: Role) -> bool { return x == Role.Admin || x.value == 2 }`)
})

test("a literal is checked against a custom type with a simple body", () => {
    const types = `type even(v) { return kindof v == "int" && v % 2 == 0 }\ntype short(v) { return typeof v == "string" && v.length <= 3 }\ntype big(v) { return v > 10n }\ntype mail(v) { return typeof v == "string" && /^[^@]+@[^@]+$/.test(v) }\ntype filled(v) { return Array.isArray(v) && v.length > 0 }\n`
    rejected(`${types}let a: even = 3`, /"a" expects even, got 3/)
    rejected(`${types}let s: short = "toolong"`, /"s" expects short, got "toolong"/)
    rejected(`${types}let b: big = 5n`, /"b" expects big, got 5n/)
    rejected(`${types}let m: mail = "nope"`, /"m" expects mail, got "nope"/)
    rejected(`${types}let l: filled = []`, /"l" expects filled, got \[\]/)
    rejected(`${types}let n: even = -3`, /"n" expects even, got -3/)
    rejected(`${types}struct A { x: even }\nconst a = A.new({ x: 1 })`, /"A\.x" expects even, got 1/)
    rejected(`${types}func f(x: even) { log(x) }\nf(7)`, /argument "x" of "f" expects even, got 7/)
    accepted(`${types}let a: even = 4\nlet s: short = "ab"\nlet b: big = 11n\nlet m: mail = "a@b"\nlet l: filled = [1]\nlog(a, s, b, m, l)`)
})

test("a custom type with a complex body or an unknown call is left to the runtime", () => {
    accepted(`type deep(v) {\n    const limit = 3\n    return v < limit\n}\nlet d: deep = 10\nlog(d)`)
    accepted(`func ok(v) { return false }\ntype calls(v) { return ok(v) }\nlet c: calls = 1\nlog(c)`)
    accepted(`type outer(v) { return v > globalThis.limit }\nlet o: outer = 1\nlog(o)`)
    accepted(`type even(v) { return kindof v == "int" && v % 2 == 0 }\nlet e: even = Number("3")\nlog(e)`)
})

test("a literal is checked against the base type of a custom type that extends one", () => {
    const port = `type Port(value) extends int {\n    return value > 0 and value < 65536\n}\n`
    const name = `type Name(v) extends string {\n    const least = 1\n    return v.length > least\n}\n`
    rejected(`${port}let p: Port = 1.5`, /"p" expects Port, got 1\.5/)
    rejected(`${port}let p: Port = 70000`, /"p" expects Port, got 70000/)
    rejected(`${name}let n: Name = 5`, /"n" expects Name, got 5/)
    accepted(`${port}${name}let p: Port = 8080\nlet n: Name = "a"\nlog(p, n)`)
})

test("the type of a custom type's parameter is its base type", () => {
    const port = `type Port(value: int) {\n    return value > 0 and value < 65536\n}\n`
    rejected(`${port}let p: Port = 1.5`, /"p" expects Port, got 1\.5/)
    rejected(`${port}let p: Port = 70000`, /"p" expects Port, got 70000/)
    accepted(`${port}let p: Port = 8080\nlog(p)`)
    assert.throws(
        () => transform(`type Port(value: int) extends int {\n    return value > 0\n}\n`, "check.slim"),
        /Type "Port" names the type of its value twice: keep either "\(value: \.\.\.\)" or "extends \.\.\."/
    )
})

test("awaiting a promise of unknown type gives an unknown value, not a promise", () => {
    accepted(`async func shot() {\n    const blob = await new Promise((resolve) => resolve(null))\n    if (!blob) return\n    log(blob)\n}\nshot()`)
    accepted(`class Picker {\n    pick() { return new Promise((resolve) => resolve(null)) }\n    async run() {\n        const track = await this.pick()\n        if (track) log(track)\n    }\n}\nnew Picker().run()`)
    rejected(`async func f() {\n    const p = new Promise((resolve) => resolve(1))\n    if (p) log(p)\n}\nf()`, /"p" is Promise, so this condition is always true/)
})

test("an array whose items were inferred from an object takes items of another shape", () => {
    accepted(`func menu(p: any) {\n    function item(label) { return { icon: p.icon, label: label } }\n    const children = [item("a"), item("b")]\n    children.push({ separator: true })\n    return children\n}\nlog(menu({}))`)
    rejected(`struct Item { icon: string }\nfunc f() {\n    const children: Item[] = []\n    children.push({ separator: true })\n    return children\n}\nlog(f())`, /"Item" (is missing field "icon"|has no field "separator")/)
})
