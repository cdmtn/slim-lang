import assert from "node:assert/strict"
import { test } from "node:test"
import { transform } from "../src/transform.js"
import { parseType, formatType, readType } from "../src/external/typeSyntax.js"

function messages(source) {
    try {
        transform(source, "inference.slim")
    } catch (error) {
        if (error.slimTypeErrors) return error.slimTypeErrors.map(diagnostic => diagnostic.message)
        throw error
    }
    return []
}

const accepted = source => assert.deepEqual(messages(source), [], "expected no diagnostics")
const rejected = (source, pattern) => assert.match(messages(source)[0] ?? "", pattern)

const USER = `struct User {\n    name: string\n    *nick: string\n    age: int\n}\n`

test("type labels round-trip through the tree", () => {
    for (const label of ["int", "int[]", "(int | string)[]", "Map<string, User[]>", "Role::Admin", "string?",
        "[int, string]", `"a" | "b" | 1`, "A & B", "Box<int>?"]) {
        assert.equal(formatType(parseType(label)), label)
    }
    assert.equal(formatType(parseType("Array<int>")), "int[]")
    assert.equal(formatType(parseType("int | string?")), "int | string | null | undefined")
    assert.deepEqual(parseType(`"a|b"`), { kind: "literal", value: "a|b" })
    assert.throws(() => parseType("Map<int"), /expected ">"/)
    assert.deepEqual(readType("Map<int"), { kind: "named", name: "Map<int" })
})

test("a union is not accepted where only one of its parts fits", () => {
    rejected(`func f(v: int | string) { let n: int = v }`, /"n" expects int, got \(int \| string\)/)
    rejected(`func f(s: string?) { let x: string = s }`, /expects string, got string\? — check it for null first/)
    rejected(`${USER}func f(u: User) { let n: string = u.nick }`, /check it for undefined first/)
})

test("checks narrow the type inside the branch", () => {
    accepted(`func f(s: string?) { if (s) { let x: string = s } }`)
    accepted(`func f(s: string?) { if (s == null) return\n    let x: string = s }`)
    accepted(`func f(s: string?) { if (!s) { throw new Error("x") }\n    let x: string = s }`)
    accepted(`func f(s: string?) { let x: string = s != null ? s : "" }`)
    accepted(`func f(s: string?) { let x: string = s ?? "" }`)
    accepted(`${USER}func f(u: User?) { let n: string? = u && u.name }`)
    accepted(`${USER}func f(u: User) { if (u.nick) { let n: string = u.nick } }`)
    accepted(`func f(v: int | string) { if (typeof v == "number") { let n: int = v } else { let s: string = v } }`)
    accepted(`func f(v: int | string) { if (kindof v == "int") { let n: int = v } }`)
    accepted(`func f(v: Date | string) { if (v instanceof Date) { let d: Date = v } }`)
    accepted(`func f(v: int[] | int) { if (Array.isArray(v)) { let xs: int[] = v } }`)
    accepted(`func f(s: string?) { while (s != null) { let x: string = s\n    s = null } }`)
    rejected(`func f(v: int | string) { if (typeof v == "string") { let n: int = v } }`, /"n" expects int, got string/)
})

test("an assignment after the check undoes the narrowing", () => {
    accepted(`let s: string? = null\ns = "a"\nif (s != null) { let x: string = s }`)
    rejected(`let s: string? = "a"\nif (s != null) {\n    s = null\n    let x: string = s\n}`, /"x" expects string/)
    rejected(`func f(s: string?) {\n    if (!s) return\n    s = null\n    let x: string = s\n}`, /"x" expects string/)
})

test("callback parameters take the element type of the array", () => {
    rejected(`${USER}func f(users: User[]) { users.forEach(u => log(u.nmae)) }`, /"User" has no field "nmae"/)
    rejected(`func f(xs: string[]) { for (const x of xs) { let n: int = x } }`, /"n" expects int, got string/)
    rejected(`func f(xs: int[]) { let s: string = xs.reduce((sum, x) => sum + x, 0) }`, /"s" expects string, got int/)
    rejected(`struct C {\n    n: int\n    run() { [1].forEach(() => log(this.nope)) }\n}`, /"C" has no field "nope"/)
})

test("array, string, Map and Set methods have result types", () => {
    rejected(`${USER}func f(users: User[]) { let xs: int[] = users.map(u => u.name) }`, /"xs" expects int\[\], got string\[\]/)
    accepted(`${USER}func f(users: User[]) { let names: string[] = users.map(u => u.name) }`)
    rejected(`func f(xs: int[]) { let ys: string[] = xs.filter(x => x > 1) }`, /got int\[\]/)
    rejected(`func f(xs: int[]) { let y: int = xs.find(x => x > 1) }`, /got \(int \| undefined\)/)
    rejected(`func f(s: string) { let parts: int[] = s.split(",") }`, /got string\[\]/)
    rejected(`func f(m: Map<string, int>) { let v: int = m.get("a") }`, /got \(int \| undefined\)/)
    accepted(`func f(s: string) {\n    let a: string = s.trim().toUpperCase()\n    let b: bool = s.includes("x")\n    let c: int = s.length\n}`)
    accepted(`func f(s: Set<string>) {\n    let b: bool = s.has("a")\n    let n: int = s.size\n}`)
    accepted(`let n: int = Math.floor(2.5)\nlet m: float = Math.random()`)
})

test("unannotated constants and functions get their types from their values", () => {
    rejected(`const n = "a"\nlet x: int = n`, /"x" expects int, got string/)
    rejected(`func f(r: "a" | "b") { return r }\nconst x = "c"\nf(x)`, /argument "r" of "f" expects \("a" \| "b"\), got "c"/)
    accepted(`func f(r: "a" | "b") { return r }\nconst x = "a"\nf(x)`)
    accepted(`async func load() { return 1 }\nasync func main() { let n: int = await load() }`)
    accepted(`func f(v: string) -> int {\n    const r = Number(v)\n    if (!Number.isInteger(r)) { throw new Error("x") }\n    return r\n}`)
    accepted(`func f(x: int) { if (x > 1) { return "a" } }\nlet n: int = f(1)`)
    accepted(`const xs = []\nxs.push(1)\nlet ys: int[] = xs`)
})

test("a match over a literal union must cover every value", () => {
    rejected(`func f(r: "a" | "b" | "c") { return match (r) { "a" => 1, "b" => 2 } }`,
        /match on \("a" \| "b" \| "c"\) does not handle "c"/)
    accepted(`func f(r: "a" | "b") { let n: int = match (r) { "a" => 1, "b" => 2 } }`)
    accepted(`enum R {\n    A: 1\n    B: 2\n}\nfunc f(r: R) { let n: int = match (r) { R.A => 1, R.B => 2 } }`)
})

test("generic struct arguments and nested struct literals are compared", () => {
    rejected(`struct Box<T> { value: T }\nfunc f(b: Box<int>) { let c: Box<string> = b }`, /"c" expects Box<string>, got Box<int>/)
    rejected(`struct P { x: int }\nstruct L { a: P }\nconst l: L = { a: { x: "no" } }`, /"P\.x" expects int, got string/)
})

test("TypeScript-only type syntax is rejected with a hint", () => {
    assert.throws(() => transform(`let o: { a: int } = { a: 1 }`, "ts.slim"), /declare a struct instead/)
    assert.throws(() => transform(`let k: keyof User = "a"`, "ts.slim"), /"keyof" types are not supported/)
})
