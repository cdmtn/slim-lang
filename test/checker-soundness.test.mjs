import assert from "node:assert/strict"
import { test } from "node:test"
import { transform } from "../src/transform.js"

function messages(source) {
    try {
        transform(source, "check.slim")
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

const P = "struct P { x: int }\n"

test("a struct literal is checked where the target is nullable or a union", () => {
    rejected(P + `let p: P? = { x: "no" }`, /"P\.x" expects int/)
    rejected(P + `let p: P? = { x: 1, typo: 1 }`, /has no field "typo"/)
    rejected(P + `func f() -> P? { return { y: 1 } }`, /has no field "y"/)
    rejected(P + `func g(p: P?) { log(p) }\ng({ x: "s" })`, /"P\.x" expects int/)
    rejected(P + `struct L { *a: P }\nlet l: L = { a: { x: "no" } }`, /"P\.x" expects int/)
    rejected(P + `let p: P | string = { x: "no" }`, /"P\.x" expects int/)
    accepted(P + `let p: P? = { x: 1 }\nlet q: P? = null\nlet r: P | string = "s"`)
})

test("match and switch coverage expands bool and enums and accepts null arms", () => {
    accepted(`func f(c: bool) { let n: int = match (c) { true => 1, false => 0 }\n log(n) }`)
    accepted(`func f(c: bool) -> int {\n switch (c) {\n  case true: return 1\n  case false: return 0\n }\n}`)
    accepted(`func f(c: "a") -> int { return match (c) { "a" => 1 } }`)
    accepted(`func f(c: "a" | "b" | null) -> int { return match (c) { "a" => 1, "b" => 2, null => 3 } }`)
    accepted(`enum C { R, G }\nfunc f(c: C?) -> int { return match (c) { C.R => 1, C.G => 2, null => 3, undefined => 4 } }`)
    accepted(`enum C { R, G }\nfunc f(c: C) -> int {\n if (c == C.R) { return match (c) { C.R => 1 } }\n return 0\n}`)
    accepted(`func f(c: int?) -> int { return match (c) { int x => x, null => 2, undefined => 3 } }`)
    rejected(`func f(c: "a" | "b") -> int { return match (c) { "a" => 1 } }`, /does not handle "b"/)
    rejected(`func f(c: bool) -> int { return match (c) { true => 1 } }`, /does not handle false/)
})

test("narrowing follows loop back-edges", () => {
    accepted(`let state: "a" | "b" = "a"\nstate = "a"\nwhile (true) {\n if (state == "b") { break }\n state = "b"\n}`)
    accepted(`func f(xs: int[]) {\n let prev: int? = 1\n prev = null\n for (const x of xs) {\n  if (prev != null) log(prev + x)\n  prev = x\n }\n}`)
    warned(`func f(s: string?) {\n if (s == null) return\n while (true) {\n  let x: string = s\n  s = null\n }\n}`, /"x" expects string/)
})

test("optional chains carry undefined and narrow their base", () => {
    const AB = "struct B { c: int }\nstruct A { b: B }\n"
    warned(AB + `func f(a: A?) { let n: int = a?.b.c }`, /int \| undefined/)
    accepted(AB + `func f(a: A?) { let n: int? = a?.b.c\n log(n) }`)
    warned(`func f(s: string?) { let x: string = s?.trim()\n log(x) }`, /string \| undefined/)
    warned(`func f(m: Map<string, int>?) { let x: int = m?.get("a")\n log(x) }`, /undefined/)
    const USER = "struct User { nick?: string\n name: string }\n"
    accepted(USER + `func f(u: User?) { if (u?.nick) { let n: string = u.nick\n log(n) } }`)
    accepted(USER + `func f(u: User?) { if (u?.name != null) { let n: string = u.name\n log(n) } }`)
})

test("an early exit inside a case narrows the rest of the case", () => {
    accepted(`func f(k: int, s: string?) {\n switch (k) {\n  case 1:\n   if (s == null) return\n   let y: string = s\n   log(y)\n   break\n }\n}`)
})

test("loose equality neither narrows across types nor counts as always false", () => {
    rejected(`func f(x: int | string) { if (x == 1) { let n: int = x\n log(n) } }`, /got \(int \| string\)/)
    accepted(`func f(x: int | string) { if (x === 1) { let n: int = x\n log(n) } }`)
    accepted(`func f(x: int) { if (x == "1") { log(x) } }`)
    rejected(`func f(x: int) { if (x === "1") { log(x) } }`, /always false/)
})

test("truthiness removes falsy literals, and ** with an unknown exponent is not an int", () => {
    accepted(`func f(v: 0 | 1) { if (v) { let n: 1 = v\n log(n) } }`)
    accepted(`func f(v: "" | "x") { if (v) { let n: "x" = v\n log(n) } }`)
    rejected(`let n: int = 2 ** -1`, /"n" expects int/)
    accepted(`let n: int = 2 ** 3`)
})

test("extends is checked: unknown parents, cycles and incompatible overrides", () => {
    rejected(`struct B extends Nope { b: int }`, /"B" extends unknown struct "Nope"/)
    rejected(`struct A extends B { a: int }\nstruct B extends A { b: int }`, /extends itself/)
    rejected(`struct A { a: int }\nstruct B extends A { a: string }`, /"B\.a" is string, but "A\.a" is int/)
    accepted(`struct A { a: int? }\nstruct B extends A { a: int }\nlog(B)`)
})

test("mutually recursive aliases don't accept everything", () => {
    rejected(`type A = B | int\ntype B = A | string\nlet x: A = true`, /"x" expects A, got bool/)
    rejected(`type A = B | int\ntype B = A | string\nlet x: A = 1\nlet y: A = "s"`, /type "A" refers to itself without a structure in between/)
})

test("narrowing stays fast on long functions", () => {
    let source = "func f() {\n let x: int = 0\n"
    for (let i = 0; i < 1000; i++) source += " x = x + 1\n"
    const started = performance.now()
    accepted(source + "}\n")
    assert.ok(performance.now() - started < 5000, "1000 reassignments should check in well under 5s")
})
