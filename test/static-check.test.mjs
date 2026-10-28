import assert from "node:assert/strict"
import { test } from "node:test"
import { transform } from "../src/transform.js"

function diagnose(source) {
    try {
        transform(source, "check.slim")
    } catch (error) {
        if (error.slimTypeErrors) return error.slimTypeErrors
        throw error
    }
    return []
}

function messages(source) {
    return diagnose(source).map(diagnostic => diagnostic.message)
}

function accepted(source) {
    assert.deepEqual(messages(source), [], "expected no diagnostics")
}

test("a literal of the wrong type is rejected at compile time", () => {
    assert.match(messages(`let x: int = "hello"`)[0], /"x" expects int, got string/)
    assert.match(messages(`let s: string = 42`)[0], /expects string, got int/)
    assert.match(messages(`let b: bool = 1`)[0], /expects bool, got int/)
})

test("int widens to float but a float is not an int", () => {
    accepted(`let f: float = 3`)
    assert.match(messages(`let n: int = 1.5`)[0], /expects int, got float/)
})

test("a reassignment is checked against the declared type", () => {
    assert.match(messages(`let x: int = 1\nx = "no"`)[0], /"x" expects int, got string/)
    accepted(`let x: int = 1\nx = 2`)
})

test("array element types are checked", () => {
    accepted(`let xs: int[] = [1, 2]`)
    accepted(`let xs: int[] = []`)
    assert.match(messages(`let xs: int[] = [1, "a"]`)[0], /expects int\[\]/)
})

test("a struct literal is checked field by field", () => {
    const source = `struct U { name: string\n id: int }\n`
    assert.match(messages(`${source}const u: U = { name: "a", id: "b" }`)[0], /"U.id" expects int, got string/)
    assert.match(messages(`${source}const u: U = { name: "a", id: 1, extra: 2 }`)[0], /"U" has no field "extra"/)
    assert.match(messages(`${source}const u: U = { name: "a" }`)[0], /missing field "id"/)
    accepted(`${source}const u: U = { name: "a", id: 1 }`)
})

test("optional and defaulted struct fields may be omitted", () => {
    accepted(`struct U { name: string\n *age: int }\nconst u: U = { name: "a" }`)
    accepted(`struct U { name: string\n role: string = "member" }\nconst u: U = { name: "a" }`)
})

test("reading a field a struct does not have is rejected", () => {
    const source = `struct U { name: string\n greet() { return this.name } }\nconst u: U = { name: "a" }\n`
    assert.match(messages(`${source}log(u.nmae)`)[0], /"U" has no field "nmae"/)
    accepted(`${source}log(u.name)`)
    accepted(`${source}log(u.greet)`)
})

test("call arguments are checked against typed parameters", () => {
    const source = `func f(a: int, b: string) { return a }\n`
    assert.match(messages(`${source}f("x", "y")`)[0], /argument "a" of "f" expects int, got string/)
    accepted(`${source}f(1, "y")`)
})

test("argument count is checked", () => {
    assert.match(messages(`func f(a: int, b: int) { return a }\nf(1)`)[0], /expects 2 arguments, got 1/)
    assert.match(messages(`func f(a: int) { return a }\nf(1, 2)`)[0], /takes 1 argument, got 2/)
    accepted(`func f(a: int, b: int = 2) { return a }\nf(1)`)
    accepted(`func f(a?: int) { return a }\nf()`)
    accepted(`func f(a: int, ...rest) { return a }\nf(1, 2, 3)`)
})

test("a typed parameter carries its type into the body", () => {
    assert.match(
        messages(`func f(a: int) {\n    let s: string = a\n    return s\n}`)[0],
        /"s" expects string, got int/
    )
})

test("narrowing a union to one of its arms is allowed", () => {
    accepted(`let v: int | string = 1\nif (kindof v == "int") { let n: int = v }`)
    accepted(`let v: string? = "a"\nlet s: string = v`)
    assert.match(messages(`let v: int | string = 1\nlet b: bool = v`)[0], /"b" expects bool/)
})

test("unions and nullable types are honoured", () => {
    accepted(`let v: int | string = "s"`)
    accepted(`let s: string? = null`)
    accepted(`let s: string? = "a"`)
    accepted(`let v: int | string = true ? 1 : "a"`)
    assert.match(messages(`let v: int | bool = "s"`)[0], /expects \(int \| bool\), got string/)
})

test("an enum member type only accepts that member", () => {
    const source = `enum R { Admin: 2\n Member: 0 }\nstruct U { role: R::Member }\n`
    assert.match(messages(`${source}const u: U = { role: R.Admin }`)[0], /"U.role" expects R::Member/)
    accepted(`${source}const u: U = { role: R.Member }`)
    accepted(`enum R { Admin: 2 }\nlet r: R = R.Admin`)
})

test("arithmetic results are inferred", () => {
    accepted(`let n: int = 1 + 2`)
    accepted(`let s: string = "a" + 1`)
    accepted(`let n: float = 4 / 2`)
    assert.match(messages(`let s: string = 1 + 2`)[0], /expects string, got int/)
})

test("what the checker cannot resolve it leaves alone", () => {
    accepted(`let x: int = compute()`)
    accepted(`let v: Imported = 1`)
    accepted(`type Positive(v) { return v > 0 }\nlet n: Positive = 5`)
    accepted(`let v: any = "s"`)
    accepted(`let p: [int, string] = [1, "a"]`)
    accepted(`struct A { x: int }\nstruct B extends A { y: int }\nconst b: B = { x: 1, y: 2 }`)
})

test("a custom type shadows a built-in of the same name, as it does at runtime", () => {
    accepted(`type number(v) { return true }\nlet n: number = "anything"`)
    accepted(`type string(v) { return true }\nlet s: string = 42`)
    assert.match(messages(`let n: number = "x"`)[0], /expects number, got string/)
})

test("inherited fields are checked through the extends chain", () => {
    const source = `struct A { x: int }\nstruct B extends A { y: int }\n`
    assert.match(messages(`${source}const b: B = { x: "no", y: 2 }`)[0], /"B.x" expects int, got string/)
    assert.match(messages(`${source}const b: B = { y: 2 }`)[0], /missing field "x"/)
    accepted(`${source}const b: B = { x: 1, y: 2 }`)
    accepted(`${source}const b: B = { x: 1, y: 2 }\nlog(b.x)`)
    assert.match(messages(`${source}const b: B = { x: 1, y: 2 }\nlog(b.z)`)[0], /"B" has no field "z"/)
})

test("a child struct is accepted where its parent is expected", () => {
    const source = `struct A { x: int }\nstruct B extends A { y: int }\n`
    accepted(`${source}const b: B = { x: 1, y: 2 }\nlet a: A = b`)
    assert.match(
        messages(`${source}const a: A = { x: 1 }\nlet b: B = a`)[0],
        /"b" expects B, got A/
    )
})

test("this resolves to the struct inside its own method", () => {
    accepted(`struct P {\n    x: int\n    doubled() { return this.x * 2 }\n}`)
    assert.match(
        messages(`struct P {\n    x: int\n    bad() { return this.nope }\n}`)[0],
        /"P" has no field "nope"/
    )
})

test("indexing an array or tuple yields its element type", () => {
    assert.match(messages(`let xs: int[] = [1]\nlet s: string = xs[0]`)[0], /"s" expects string, got int/)
    accepted(`let xs: int[] = [1]\nlet n: int = xs[0]`)
    assert.match(messages(`let p: [int, string] = [1, "a"]\nlet n: int = p[1]`)[0], /"n" expects int, got string/)
    accepted(`let p: [int, string] = [1, "a"]\nlet s: string = p[1]`)
})

test("a match over an enum must be exhaustive", () => {
    const source = `enum R {\n    A: 0\n    B: 1\n}\n`
    assert.match(
        messages(`${source}const x = match (R.A) { R.A => 1 }`)[0],
        /does not handle R\.B/
    )
    accepted(`${source}const x = match (R.A) { R.A => 1, R.B => 2 }`)
    accepted(`${source}const x = match (R.A) { R.A => 1, _ => 0 }`)
    accepted(`${source}const x = match (R.A) { v when v == 0 => 1 }`)
    accepted(`const x = match (5) { 1 => "a" }`)
})

test("a declared return type is checked", () => {
    assert.match(messages(`func f(a: int) -> string { return a }`)[0], /"f" must return string, got int/)
    assert.match(messages(`func f(a: int) -> int { if (a > 0) { return }\n    return a }`)[0],
        /"f" must return int, got undefined/)
    accepted(`func f(a: int) -> int { return a }`)
    accepted(`func f(a: int) -> int | string { return "x" }`)
    accepted(`func f(a: int) -> int? { return }`)
    accepted(`struct U { name: string }\nfunc f() -> U { return { name: "a" } }`)
    assert.match(messages(`struct U { name: string }\nfunc f() -> U { return { name: 1 } }`)[0],
        /"U.name" expects string, got int/)
})

test("a nested function keeps its own return contract", () => {
    accepted(`func f(a: int) -> int {\n    const g = (x) => "text"\n    return a\n}`)
})

test("a call to a function with a return type infers its result", () => {
    assert.match(messages(`func f(a: int) -> int { return a }\nlet s: string = f(1)`)[0],
        /"s" expects string, got int/)
    accepted(`func f(a: int) -> int { return a }\nlet n: int = f(1)`)
    accepted(`const f = (a: int) -> int => a * 2\nlet n: int = f(1)`)
    assert.match(messages(`func f(a: int) { return "anything" }\nlet n: int = f(1)`)[0], /"n" expects int, got string/)
})

test("Array<T> and T[] are the same type", () => {
    assert.match(messages(`let xs: Array<int> = ["a"]`)[0], /"xs" expects int\[\], got string\[\]/)
    accepted(`let xs: Array<int> = [1, 2]`)
    accepted(`let xs: int[] = [1, 2]\nlet ys: Array<int> = xs`)
})

test("a container type is not satisfied by an unrelated value", () => {
    assert.match(messages(`let m: Map<string, int> = 5`)[0], /"m" expects Map<string, int>, got int/)
    accepted(`let m: Map<string, int> = new Map()`)
    accepted(`let d: Date = new Date()`)
})

test("a shadowed function is not checked against the outer signature", () => {
    accepted(`func f(a: int) { return a }\n{ const f = (x) => x\n f("anything") }`)
})

test("Struct.new yields an instance of that struct", () => {
    accepted(`struct U { name: string }\nconst u = U.new({ name: "a" })\nlog(u.name)`)
    assert.match(
        messages(`struct U { name: string }\nconst u = U.new({ name: "a" })\nlog(u.nmae)`)[0],
        /"U" has no field "nmae"/
    )
})

test("a diagnostic points at the offending value in the original source", () => {
    const [diagnostic] = diagnose(`struct U { name: string\n age: int }\nconst u: U = { name: "Ada", age: "old" }`)

    assert.equal(diagnostic.line, 3)
    assert.equal(diagnostic.sourceLine.slice(diagnostic.column - 1), `"old" }`)
})

test("checking can be turned off", () => {
    assert.doesNotThrow(() => transform(`let x: int = "hello"`, "check.slim", { check: false }))
})
