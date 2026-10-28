import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { closest } from "../src/suggest.js"

const root = process.cwd()
const outputDir = path.join(root, "dist", "__improvement_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function run(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const file = path.join(outputDir, `${name}.js`)
    const { code } = transform(source, path.join(root, "__improvement_tests__", `${name}.slim`), { outFile: file })
    writeFileSync(file, code.replace(/^import\s+[^;]*(?:defaults|core)\.js";$/m, `import ${JSON.stringify(runtimeImport)};`))
    return spawnSync(process.execPath, ["--no-warnings", file], { cwd: root, encoding: "utf8" })
}

function messages(source) {
    try {
        transform(source, "improvements.slim")
    } catch (error) {
        if (error.slimTypeErrors) return error.slimTypeErrors.map(diagnostic => diagnostic.message)
        throw error
    }
    return []
}

const accepted = source => assert.deepEqual(messages(source), [], "expected no diagnostics")
const rejected = (source, pattern) => assert.match(messages(source).join("\n"), pattern)

const USER = `struct User {\n    name: string\n    age: int\n    greet() -> string { return this.name }\n}\n`

test("a literal typed as a struct is built like Struct.new", () => {
    const result = run("struct-literal", `
struct Address {
    city: string
    label() -> string { return "in " + this.city }
}
struct User {
    name: string
    role: string = "member"
    readonly id: int
    address: Address
    greet() -> string { return this.name + " " + this.role + " " + this.address.label() }
}
func make(name: string) -> User {
    return { name, id: 2, address: { city: "Oslo" } }
}
const u: User = { name: "Ada", id: 1, address: { city: "Paris" } }
const all: User[] = [{ name: "Eve", id: 3, address: { city: "Rome" } }]
log(u.greet(), "|", make("Bob").greet(), "|", all[0].greet(), "|", Object.getOwnPropertyDescriptor(u, "id").writable)
`)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "Ada member in Paris | Bob member in Oslo | Eve member in Rome | false")
})

test("a float holds whole numbers at runtime too", () => {
    const result = run("float-whole", `
struct Circle { radius: float }
func area(c: Circle) -> float { return c.radius * c.radius }
log(area(Circle.new({ radius: 2 })))
`)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "4")
})

test("typos get a did-you-mean", () => {
    assert.equal(closest("nmae", ["name", "age"]), "name")
    assert.equal(closest("username", ["userName"]), "userName")
    assert.equal(closest("ac", ["ab"]), null)

    rejected(`${USER}func f(u: User) { log(u.nmae) }`, /"User" has no field "nmae" — did you mean "name"\?/)
    rejected(`${USER}func f(u: User?) { log(u.nmae) }`, /did you mean "name"/)
    rejected(`${USER}const u: User = { name: "a", aeg: 1 }`, /has no field "aeg" — did you mean "age"\?/)
    rejected(`enum Role {\n    Admin: 1\n    Member: 2\n}\nlog(Role.Admn)`, /"Role" has no member "Admn" — did you mean "Admin"\?/)
    rejected(`const users = [1]\nlog(usres)`, /"usres" is not defined — did you mean "users"\?/)
    rejected(`${USER}func f(u: Usre) { return u }`, /unknown type "Usre" — did you mean "User"\?/)
    rejected(`func f(s: string) { return s.lenght }`, /string has no property "lenght" — did you mean "length"\?/)
    rejected(`func f(n: int) { return n.toUpperCase() }`, /int has no property "toUpperCase"/)

    accepted(`log(document, window.location, JSON, setTimeout, fetch, process.env, console)`)
    accepted(`if (typeof someGlobal !== "undefined") log(1)`)
    accepted(`use { getUser } from "./api"\nconst getUsers = 1\nlog(getUser)`)
    accepted(`use "./api"\nconst getUsers = 1\nlog(getUser)`)
    accepted(`enum Role {\n    Admin: 1\n}\nlog(Role.from(1), Role.keys())`)
})

test("type parameters are bound per call", () => {
    const pick = `const pick = <T>(items: T[]) -> T? => items[0]\n`
    rejected(`${pick}let n: int = pick(["a"])`, /"n" expects int, got string\?/)
    accepted(`${pick}let s: string? = pick(["a"])`)
    accepted(`${pick}let n: int = pick(JSON.parse("[]"))`)
    rejected(`func pair<T>(a: T, b: T) -> T[] { return [a, b] }\npair(1, "x")`, /argument "b" of "pair" expects int, got string/)
    rejected(`func first<K, V>(m: Map<K, V>, k: K) -> V? { return m.get(k) }\nfunc g(m: Map<string, int>) { first(m, 1) }`,
        /argument "k" of "first" expects string, got int/)

    const box = `struct Box<T> {\n    value: T\n    swap(next: T) -> T {\n        const old = this.value\n        this.value = next\n        return old\n    }\n}\nconst b: Box<int> = { value: 1 }\n`
    rejected(`${box}b.swap("s")`, /argument "next" of "Box<int>\.swap" expects int, got string/)
    rejected(`${box}let s: string = b.swap(2)`, /"s" expects string, got int/)
})

test("match takes type patterns and checks they cover the union", () => {
    const shapes = `struct Circle { radius: float }\nstruct Square { side: float }\ntype Shape = Circle | Square\n`
    accepted(`${shapes}func area(s: Shape) -> float {\n    return match (s) { Circle c => c.radius * c.radius, Square q => q.side * q.side }\n}`)
    rejected(`${shapes}func area(s: Shape) -> float {\n    return match (s) { Circle c => c.radius }\n}`, /match on Shape does not handle Square/)
    rejected(`${shapes}func f(s: Shape) { return match (s) { Circle c => c.side, _ => 0 } }`, /"Circle" has no field "side"/)
    rejected(`func f(v: int | string | bool) -> string { return match (v) { int n => "num", string s => s } }`, /does not handle bool/)
    accepted(`const x = 2\nconst r = match (x) { 1 => "a", n when n > 1 => "b", _ => "c" }`)

    const result = run("match-types", `${shapes}
func area(s: Shape) -> float {
    return match (s) {
        Circle c => 3.0 * c.radius * c.radius,
        Square q when q.side > 10 => -1.0,
        Square q => q.side * q.side
    }
}
func describe(v: int | string | null) -> string {
    return match (v) { int n => "number", string s => "text " + s, null n => "nothing" }
}
log([Circle.new({ radius: 1 }), Square.new({ side: 2 }), Square.new({ side: 20 })].map(area).join(","), describe(5), describe("a"), describe(null))
`)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "3,4,-1 number text a nothing")
})

test("function types keep their signature", () => {
    const apply = `func apply(cb: (n: int) => string, n: int) -> string { return cb(n) }\n`
    accepted(`${apply}apply(n => "#" + n, 1)`)
    rejected(`${apply}apply(n => n * 2, 1)`, /argument "cb" of "apply" expects \(n: int\) => string, got \(n: int\) => int/)
    rejected(`${apply}apply(n => n.toUpperCase(), 1)`, /int has no property "toUpperCase"/)
    rejected(`func twice(n: int) -> int { return n * 2 }\n${apply}apply(twice, 1)`, /expects \(n: int\) => string/)
    rejected(`func run(cb: (n: int) => string) { cb("x") }`, /argument "n" of "cb" expects int, got string/)
    rejected(`func run(cb: (a: int, b: int) => int) { cb(1) }`, /"cb" expects 2 arguments, got 1/)
    rejected(`const double: (n: int) => int = n => n * 2\ndouble("2")`, /argument "n" of "double" expects int/)
    rejected(`func mapAll<T, R>(xs: T[], f: (x: T) => R) -> R[] { return xs.map(f) }\nlet s: int[] = mapAll([1, 2], n => "" + n)`,
        /"s" expects int\[\], got string\[\]/)
    accepted(`let f: function = () => 1`)
    accepted(`func on(cb: ((e: string) => void)?) { if (cb) cb("x") }\non(null)\non(e => log(e))`)
})

test("an unchanged file is not compiled again, but its types still reach its importers", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "slim-cache-"))
    const build = (env = {}) => spawnSync(process.execPath, [path.join(root, "src", "compile.js")], {
        cwd: dir, encoding: "utf8", env: { ...process.env, ...env }
    })
    const write = (name, source) => writeFileSync(path.join(dir, name), source)

    try {
        write("slimconfig.json", JSON.stringify({ main: "index" }))
        write("models.slim", `export struct User {\n    name: string\n    age: int\n}\n`)
        write("index.slim", `use { User } from "./models"\nconst u: User = { name: "a", age: 1 }\nlog(u.name)\n`)

        assert.equal(build().status, 0)
        assert.match(build().stdout, /Up to date: 2 of 2 files/)

        write("index.slim", `use { User } from "./models"\nconst u: User = { name: "a", age: 1 }\nlog(u.nmae)\n`)
        assert.match(build().stderr, /"User" has no field "nmae"/)

        write("index.slim", `use { User } from "./models"\nconst u: User = { name: "a", age: 1 }\nlog(u.name)\n`)
        assert.equal(build().status, 0)
        write("models.slim", `export struct User {\n    name: string\n    age: string\n}\n`)
        assert.match(build().stderr, /"User\.age" expects string, got int/)

        write("models.slim", `export struct User {\n    name: string\n    age: int\n}\n`)
        assert.equal(build().status, 0)
        assert.doesNotMatch(build({ SLIM_FORCE: "1" }).stdout, /Up to date/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
