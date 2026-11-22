import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__safety_tests__")
const runtimeDir = path.join(root, "src", "external")
const cli = path.join(root, "src", "bin", "cli.js")

function compile(name, source, options = {}) {
    mkdirSync(outputDir, { recursive: true })
    const file = path.join(outputDir, `${name}.js`)
    const { code } = transform(source, path.join(root, "__safety_tests__", `${name}.slim`), { outFile: file, ...options })
    writeFileSync(file, code.replace(/"[^"]*external\/((?:runtime-dom|runtime-core|defaults|core)\.js)"/g, (match, entry) => JSON.stringify(pathToFileURL(path.join(runtimeDir, entry)).href)))
    return spawnSync(process.execPath, ["--no-warnings", file], { cwd: root, encoding: "utf8" })
}

function run(name, source, options) {
    const result = compile(name, source, options)
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
}

function errors(source) {
    try {
        transform(source, "safety.slim")
        return []
    } catch (error) {
        if (error.slimTypeErrors) return error.slimTypeErrors.map(diagnostic => diagnostic.message)
        return [error.message.split("\n")[0]]
    }
}

const accepted = source => assert.deepEqual(errors(source), [], "expected no errors")
const rejected = (source, pattern) => assert.match(errors(source).join("\n"), pattern)

function tempProject(files, config = { main: "index" }) {
    const dir = mkdtempSync(path.join(tmpdir(), "slim-safety-"))
    writeFileSync(path.join(dir, "slimconfig.json"), JSON.stringify(config))
    for (const [name, source] of Object.entries(files)) writeFileSync(path.join(dir, name), source)
    return dir
}

test("a function that declares a result can't fall off its end", () => {
    rejected(`func f(n: int) -> string {\n    if (n > 0) return "x"\n}`, /"f" must return string, but it can reach the end without a return/)
    rejected(`enum R { A: 1\n B: 2\n C: 3 }\nfunc f(r: R) -> string {\n    switch (r) {\n        case R.A: return "a"\n        case R.B: return "b"\n    }\n}`,
        /the switch on "R" does not handle R\.C/)
    accepted(`enum R { A: 1\n B: 2 }\nfunc f(r: R) -> string {\n    switch (r) {\n        case R.A: return "a"\n        case R.B: return "b"\n    }\n}`)
    accepted(`func g(n: int) -> int {\n    while (true) {\n        if (n > 3) return n\n        n++\n    }\n}\nfunc h(n: int) -> int {\n    try { return n } catch (e) { throw e }\n}\nfunc k(n: int) -> int? { if (n) return 1 }\nfunc v(n: int) { if (n) return }`)
    accepted(`func fail(m: string) -> never { throw new Error(m) }\nfunc f(n: int) -> int {\n    if (n) return 1\n    fail("x")\n}`)
    rejected(`func f(n: int) -> int {\n    outer: while (true) {\n        if (n) break outer\n        return 1\n    }\n}`, /reach the end/)
    rejected(`func fail(m: string) -> never { if (m) throw new Error(m) }`, /declared -> never, but it can finish normally/)
    assert.equal(run("fall-off", `
func f(n: any) -> string {
    if (n) return "x"
}
try { f(0) } catch (e) { log(e.message) }
`, { check: false }), `function "f" must return string, got undefined: undefined`)
})

test("a narrowing doesn't reach into a closure when the variable changes later", () => {
    const U = `struct U { name: string }\n`
    rejected(`${U}func f(u: U?) {\n    let cur = u\n    if (cur) {\n        setTimeout(() => log(cur.name), 0)\n    }\n    cur = null\n}`, /"cur" may be null here/)
    rejected(`${U}func f(u: U?) {\n    if (u) {\n        const run = () => { log(u.name) }\n        u = null\n        run()\n    }\n}`, /"u" may be null here/)
    accepted(`${U}func f(u: U?, items: int[]) {\n    let cur = u\n    cur = u\n    if (cur) items.forEach(i => log(cur.name, i))\n    if (u) items.forEach(i => log(u.name))\n    if (!u) return\n    items.forEach(i => log(u.name))\n}`)
    rejected(`func f(c: bool) {\n    let x = 1\n    const g = () => { let y: int = x }\n    x = "a"\n}`, /"y" expects int, got \(int \| string\)/)
    accepted(`let api = null\nfunc setup() { api = { go: () => 1 } }\nsetup()\napi.go()`)
})

test("code after return in a component is an error, functions after it are kept", () => {
    rejected(`component Card() {\n    return <b>x</b>\n    log("lost")\n}`, /Component "Card": code after return never runs/)
    assert.equal(run("component-hoist", `
component Card() {
    return <b>\${label()}</b>
    func label() -> string { return "hi" }
}
log(Card().outerHTML)
`), "<b>hi</b>")
})

test("calling a function that may be missing is an error", () => {
    const U = `struct U {\n    name: string\n    greet?: () => string\n}\n`
    rejected(`${U}func f(u: U) -> string { return u.greet() }`, /"u\.greet" may be undefined here .* call it with "\?\.\(\)"/)
    rejected(`func g(cb: (() => int)?) -> int { return cb() }`, /"cb" may be null here/)
    accepted(`${U}func f(u: U) -> string {\n    if (u.greet) return u.greet()\n    return u.greet?.() ?? "none"\n}\nfunc g(cb: (() => int)?) -> int { return cb ? cb() : 0 }`)
})

test("class fields and methods are checked like struct ones", () => {
    const ANIMAL = `class Animal {\n    name: string = ""\n    readonly id: int = 0\n    rename(n: string) { this.name = n }\n    get upper() -> string { return this.name }\n}\nconst a = new Animal()\n`
    rejected(`class Box {\n    value: int = 0\n    set(v: string) { this.value = v }\n}`, /"Box\.value" expects int, got string/)
    rejected(`${ANIMAL}a.rename(5)`, /argument "n" of "Animal\.rename" expects string, got int/)
    rejected(`${ANIMAL}a.id = 3`, /"Animal\.id" is readonly/)
    rejected(`${ANIMAL}a.upper = "x"`, /"Animal\.upper" is readonly/)
    rejected(`${ANIMAL}const n: int = a.name`, /"n" expects int, got string/)
    assert.equal(run("classes", `
class Animal {
    name: string = ""
    readonly id: int
    constructor(id: int) { this.id = id }
    rename(n: string) { this.name = n }
}
class Dog extends Animal {
    bark() -> string { return this.name + "!" }
}
const d = new Dog(1)
d.rename("rex")
d.extra = 5
log(d.bark(), d.id)
`), "rex! 1")
})

test("\"in\" narrows a union of structs", () => {
    const PETS = `struct Cat { meow: string }\nstruct Dog { bark: string }\n`
    assert.equal(run("in-narrow", `${PETS}
func f(x: Cat | Dog) -> string {
    if ("meow" in x) return x.meow
    return x.bark
}
func g(x: Cat | Dog) -> string {
    if (!("meow" in x)) return x.bark
    return x.meow
}
log(f({ bark: "w" }), g(Cat.new({ meow: "m" })))
`), "w m")
    rejected(`${PETS}func f(x: Cat | Dog) -> string {\n    if ("meow" in x) return x.bark\n    return ""\n}`, /"Cat" has no field "bark"/)
})

test("struct and enum methods can have their own type parameters", () => {
    const BOX = `struct Named { name: string }\nstruct Box<T> {\n    value: T\n    label<U extends Named>(u: U) -> string { return u.name }\n    pair<K>(k: K) -> [K, T] { return [k, this.value] }\n}\n`
    rejected(`${BOX}const b: Box<int> = { value: 1 }\nb.label(5)`, /type parameter "U" of "Box<int>\.label" must fit Named, got int/)
    assert.equal(run("generic-methods", `${BOX}
enum Shape {
    Circle(r: float)
    wrap<U>(u: U) -> U[] { return [u] }
}
const b = Box.new({ value: 1 })
log(b.label({ name: "x" }), b.pair("a").join(","), Shape.Circle(1.0).wrap(3).length)
`), "x a,1 1")
})

test("enum values are checked at compile time, and messages suggest a fix", () => {
    const ENUMS = `enum Color { Red: "red"\n Green: "green" }\nenum Level { Low: 1\n High: 2 }\nfunc paint(c: Color) { log(c) }\nfunc lvl(l: Level) { log(l) }\n`
    rejected(`${ENUMS}paint("blue")`, /argument "c" of "paint" expects Color, got "blue" — use one of "red", "green"/)
    rejected(`${ENUMS}lvl(3)`, /expects Level, got 3 — use one of 1, 2/)
    accepted(`${ENUMS}paint("red")\npaint(Color.Green)\nlvl(2)\nconst raw: string = "green"\npaint(raw)`)
    rejected(`let half: int = 10 / 2`, /use "~\/" for integer division/)
    rejected(`async func load() -> Result<int, string> { return Result.Ok(1) }\nasync func run() -> Result<int, string> {\n    const v = load()?\n    return Result.Ok(v)\n}`,
        /await it first: \(await load\(\.\.\.\)\)\?/)
})

test("slmc test runs hooks, only/skip, mocks, spies, timeouts and a filter", () => {
    const dir = tempProject({
        "suite.test.slim": `
const order: string[] = []
beforeAll(() => { order.push("all") })
afterAll(() => { log("order", order.join(",")) })
describe("math", () => {
    let n = 0
    beforeEach(() => { n = 10 })
    afterEach(() => { order.push("after") })
    test("hooks", () => {
        n++
        assertEqual(n, 11)
    })
    test("deep", () => { assertDeepEqual({ a: [1, 2], m: new Map([["k", 1]]) }, { a: [1, 2], m: new Map([["k", 1]]) }) })
    test("throws", () => {
        const err = assertThrows(() => { throw new TypeError("bad input") }, TypeError)
        assertThrows(() => JSON.parse("{"), /JSON/)
        assertEqual(err.message, "bad input")
    })
    test("rejects", async () => { await assertRejects(async () => { throw new Error("nope") }, "nope") })
    test.skip("later", () => { assert(false) })
})
describe("doubles", () => {
    test("mock", () => {
        const fn = mock((a: int) => a * 2)
        assertEqual(fn(2), 4)
        fn(5)
        assertEqual(fn.callCount, 2)
        assert(fn.calledWith(5))
        const fixed = mock().returns(7).returnsOnce(1)
        assertEqual(fixed(), 1)
        assertEqual(fixed(), 7)
    })
    test("spy", () => {
        const api = { get(x: int) -> int { return x + 1 } }
        const spy = spyOn(api, "get")
        assertEqual(api.get(1), 2)
        assertEqual(spy.callCount, 1)
    })
    test("deep failure", () => { assertDeepEqual([1, 2], [1, 3]) })
    test("slow", async () => { await new Promise(r => setTimeout(r, 300)) }, { timeout: 30 })
})
`
    })
    try {
        const result = spawnSync(process.execPath, [cli, "test"], { cwd: dir, encoding: "utf8" })
        const output = result.stdout
        assert.equal(result.status, 1, output + result.stderr)
        for (const line of ["✓ math › hooks", "✓ math › deep", "✓ math › throws", "✓ math › rejects", "- math › later (skipped)",
            "✓ doubles › mock", "✓ doubles › spy", "✗ doubles › deep failure", "expected [1,3], got [1,2]",
            "\"doubles › slow\" took longer than 30ms", "order all,after,after,after,after", "6 passed, 2 failed, 1 skipped"]) {
            assert.ok(output.includes(line), `missing "${line}" in:\n${output}`)
        }
        const filtered = spawnSync(process.execPath, [cli, "test", "--filter", "mock"], { cwd: dir, encoding: "utf8" })
        assert.equal(filtered.status, 0, filtered.stdout)
        assert.match(filtered.stdout, /1 passed, 0 failed, 8 skipped/)

        writeFileSync(path.join(dir, "only.test.slim"), `test("a", () => { assert(false) })\ntest.only("b", () => { assert(true) })\n`)
        const only = spawnSync(process.execPath, [cli, "test", "only.test.slim"], { cwd: dir, encoding: "utf8" })
        assert.equal(only.status, 0, only.stdout)
        assert.match(only.stdout, /1 passed, 0 failed, 1 skipped/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("slmc test builds the modules a test uses and reports coverage", () => {
    const dir = tempProject({
        "calc.slim": `export func classify(n: int) -> string {\n    if (n > 0) {\n        return "positive"\n    }\n    if (n < 0) {\n        return "negative"\n    }\n    return "zero"\n}\n`,
        "calc.test.slim": `use { classify } from "./calc"\ntest("positive", () => { assertEqual(classify(2), "positive") })\ntest("zero", () => { assertEqual(classify(0), "zero") })\n`
    })
    try {
        const result = spawnSync(process.execPath, [cli, "test", "--coverage"], { cwd: dir, encoding: "utf8" })
        assert.equal(result.status, 0, result.stdout + result.stderr)
        assert.match(result.stdout, /calc\.slim\s+\|\s+77\.8%\s+\|\s+6-7/)
        assert.doesNotMatch(result.stdout, /calc\.test\.slim\s+\|/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("build() can run again in the same process and reuses unchanged files", () => {
    const dir = tempProject({
        "calc.slim": `export func double(n: int) -> int { return n * 2 }\n`,
        "index.slim": `use { double } from "./calc"\nlog(double(2))\n`,
        "rebuild.mjs": `
import fs from "node:fs"
const { build } = await import(${JSON.stringify(pathToFileURL(path.join(root, "src", "compile.js")).href)})
const results = [build()]
results.push(build())
fs.writeFileSync("index.slim", 'use { double } from "./calc"\\nlet x: string = double(2)\\n')
results.push(build())
fs.writeFileSync("index.slim", 'use { double } from "./calc"\\nlog(double(5))\\n')
results.push(build())
console.log("RESULTS", results.join(","))
`
    })
    try {
        const result = spawnSync(process.execPath, ["rebuild.mjs"], { cwd: dir, encoding: "utf8" })
        assert.match(result.stdout, /RESULTS true,true,false,true/, result.stdout + result.stderr)
        assert.match(result.stdout, /Up to date: 2 of 2 files/)
        assert.match(result.stderr, /"x" expects string, got int/)
        const app = spawnSync(process.execPath, [path.join(dir, "slim-dist", "index.js")], { cwd: dir, encoding: "utf8" })
        assert.equal(app.stdout.trim(), "10")
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("a let or const can't be used before its declaration", () => {
    rejected(`log(x)\nlet x: int = 1`, /"x" is used before its declaration/)
    rejected(`run()\nconst run = () => log("r")`, /"run" is used before its declaration/)
    accepted(`func later() -> int { return value }\nconst value = 1\nlog(later())\ntry { log(1) } catch (e) { log(e) }\nexport type I = typeof S\nclass S {}`)
})

test("null can't be iterated, spread, destructured or used in arithmetic", () => {
    const U = `struct U { name: string }\n`
    rejected(`${U}func f(u: U?) {\n    const { name } = u\n}`, /"u" may be null here .* null can't be destructured/)
    rejected(`func f(xs: int[]?) { log([...xs]) }`, /"xs" may be null here .* null can't be spread/)
    rejected(`func f(xs: int[]?) { for (const x of xs) log(x) }`, /"xs" may be null here .* null can't be iterated/)
    rejected(`func f(x: int?) -> int { return x + 1 }`, /"x" may be null here .* null in "\+" gives a wrong result/)
    rejected(`func f(xs: (int | null)[]) -> int { return xs[0] * 2 }`, /"xs\[0\]" may be null here/)
    rejected(`const m = "abc".match(/z/)\nlog(m[0])`, /"m" may be null here \(string\[\] \| null\)/)
    accepted(`func f(xs: int[]?, x: int?) -> int {\n    for (const n of xs ?? []) log(n)\n    if (x == null) return 0\n    const m = "abc".match(/b/)\n    if (m) log(m[0])\n    return x + 1\n}\nlog("a" + null)`)
})

test("optional parameters may be missing", () => {
    rejected(`func f(name?: string) -> int { return name.length }`, /"name" may be undefined here/)
    rejected(`func f(cb?: () => int) -> int { return cb() }`, /"cb" may be undefined here/)
    accepted(`func f(name?: string, size: int = 1) -> int { return (name?.length ?? 0) + size }`)
})

test("values that can't be called, compared or created that way are errors", () => {
    rejected(`let n = 5\nn()`, /"n" is int, not a function/)
    rejected(`struct U { name: string }\nconst u = new U()`, /"U" is a struct, not a class/)
    rejected(`enum Color { Red: "red" }\nfunc f(c: Color) -> bool { return c == "blu" }`, /this comparison is always false: Color and "blu" have no value in common/)
    rejected(`func f(n: int) -> bool { return n === "1" }`, /always false/)
    rejected(`func f(x: any) -> bool { return typeof x == "strng" }`, /typeof never gives "strng" — did you mean "string"\?/)
    rejected(`enum A { X: 1 }\nenum B { Y: 1 }\nfunc f(a: A) -> string {\n    switch (a) {\n        case B.Y: return "y"\n        default: return "d"\n    }\n}`, /this case never matches/)
    rejected(`enum Color { Red: "red" }\nlog(Color.from("blue"))`, /"blue" is not a value of "Color" — use one of "red"/)
    rejected(`enum Level { Low: 1\n High: 2 }\nlet x: int = Level.Low + Level.High`, /an enum member and not a number — use Level\.Low\.value/)
    rejected(`setTimeout("log(1)", 10)`, /"setTimeout" needs a function/)
    rejected(`let n: int = 1 ~/ 0`, /integer division by 0/)
    accepted(`enum Color { Red: "red" }\nfunc f(c: Color, n: int, s: string?) -> bool { return c.value == "red" || c == Color.Red || n == 2 || s == null || typeof s == "string" }\nlog("level " + Color.Red)`)
    rejected(`enum Color { Red: "red" }\nfunc f(c: Color) -> bool { return c == "red" }`, /always false: "c" is a Color member and string is a raw value — compare with Color\.from\("red"\)/)
})

test("writes and defaults of the wrong type are errors", () => {
    rejected(`let i: int = 0\ni += 0.5`, /"i" is int, but "\+=" makes it float/)
    rejected(`let s: string = "a"\ns++`, /"s" is string: "\+\+" only works on numbers/)
    rejected(`func f(x: int = "a") { log(x) }`, /the default of "x" must be int, got string/)
    rejected(`struct A { x: int = "s" }`, /the default of "A\.x" must be int, got string/)
    rejected(`struct U { name: string }\nconst u: U = { name: "a" }\nu["name"] = 5`, /"U\.name" expects string, got int/)
    rejected(`struct U { name: string }\nconst u: U = { name: "a" }\ndelete u.name`, /"U\.name" is required/)
    rejected(`let p: positive = 3`, /unknown type "positive" — declare it, or bring it in with "use"/)
    rejected(`const [a, b]: [int, int] = [1]`, /the destructured value must be \[int, int\], got \[int\]/)
    rejected(`struct U { name: string }\nconst u = U.new({})`, /"U" is missing field "name"/)
    rejected(`class A {\n    name: string\n    len() -> int { return this.name.length }\n}`, /"name" is string but has no starting value/)
    accepted(`let i: int = 0\ni += 2\nlet f: float = 1.0\nf /= 2\nclass A {\n    name: string\n    tag?: string\n    constructor(n: string) { this.name = n }\n}\nstruct B { x: int = 1 }`)
})

test("locked objects, callbacks and Map/Set arguments are checked", () => {
    rejected(`const cfg = { a: { b: 1 } }\nlock cfg\ncfg.a.b = 2`, /"cfg" is locked: changing "cfg\.a\.b" throws/)
    rejected(`lock const user = { name: "a" }\nuser.name = "b"`, /"user" is locked/)
    rejected(`const xs: int[] = [1, 2]\nlog(xs.map((s: string) => s.length))`, /parameter "s" is string, but it gets int here/)
    rejected(`const m = new Map<string, int>()\nm.forEach((v: string, k: string) => log(v))`, /parameter "v" is string, but it gets int here/)
    rejected(`const m = new Map<string, int>()\nm.set("a", "x")`, /argument "value" of "Map<string, int>\.set" expects int, got string/)
    rejected(`const m = new Map<string, int>()\nlet v: int = m.get("a")`, /"v" expects int, got \(int \| undefined\)/)
    rejected(`const s = new Set<int>()\ns.add("a")`, /expects int, got string/)
    rejected(`struct C {\n    n: int\n    run() { [1].forEach(function () { log(this.n) }) }\n}`, /"this" is undefined inside a function passed to "forEach"/)
    accepted(`const cfg = { a: 1 }\ncfg.a = 2\nlock cfg\nlog(cfg.a)\nconst m = new Map<string, int[]>()\nm.set("a", [1])\nlog((m.get("a") ?? []).length);\n[1].forEach(n => log(n))`)
})

test("object literals in a const are checked where a struct is expected", () => {
    const USER = `struct User {\n    name: string\n    age: int\n}\nfunc greet(u: User) { log(u.name) }\n`
    rejected(`${USER}const p = { name: "a" }\ngreet(p)`, /expects User, got \{ name: string \} — it has no "age"/)
    rejected(`${USER}const p = { name: "a", age: 1, extra: true }\ngreet(p)`, /User has no field "extra"/)
    assert.equal(run("literal-shape", `${USER}const p = { name: "ok", age: 1 }\ngreet(p)\nconst q = { name: "a" }\nq.age = 2\ngreet(q)`), "ok\na")
})

test("component props and event handlers are checked", () => {
    const CARD = `component Card(props: { count: int }) { return <b>\${props.count + 1}</b> }\n`
    rejected(`${CARD}component App() { return <div><Card count="x" /></div> }`, /prop "count" of .* expects int, got "x" — a quoted value is a string/)
    rejected(`component C() {\n    const n = 5\n    return <button onClick=\${n}>x</button>\n}`, /"onClick" needs a function, got 5/)
    rejected(`component C() {\n    return <button onclick=\${() => log(1)}>x</button>\n}`, /"onclick" sets an HTML attribute.*write onClick=/)
    assert.equal(run("props-ok", `${CARD}component App() {\n    const s = 1\n    return <div><Card count=\${s} /></div>\n}\nlog(App().outerHTML)`), "<div><b>2</b></div>")
})

test("an import of a name the module doesn't export is an error", () => {
    const dir = tempProject({
        "mod.slim": `export const something = 1\nexport func helper() -> int { return 1 }\nexport type Id = int | string\n`,
        "index.slim": `use { something, Id, helpr } from "./mod"\nlog(something)\n`
    })
    try {
        const failed = spawnSync(process.execPath, [path.join(root, "src", "compile.js")], { cwd: dir, encoding: "utf8" })
        assert.notEqual(failed.status, 0)
        assert.match(failed.stdout + failed.stderr, /"mod\.slim" has no export "helpr" — did you mean "helper"\?/)
        writeFileSync(path.join(dir, "index.slim"), `use { something, helper } from "./mod"\nlog(something, helper())\n`)
        const fixed = spawnSync(process.execPath, [path.join(root, "src", "compile.js")], { cwd: dir, encoding: "utf8" })
        assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("class members, method results and detached methods are checked", () => {
    const A = `class A {\n    x: int = 1\n    get() -> int { return this.x }\n}\nclass B {\n    y: int = 2\n}\n`
    rejected(`${A}const a = new A()\nlog(a.y)`, /"A" has no field "y"/)
    rejected(`${A}func f(v: A | B) -> int {\n    if (v instanceof A) return v.y\n    return v.y\n}`, /"A" has no field "y"/)
    rejected(`${A}const s: string = new A().get()`, /"s" expects string, got int/)
    rejected(`${A}const a = new A()\nconst g = a.get\nlog(g())`, /"a\.get" loses its "this" when taken off the object/)
    rejected(`${A}const a = new A()\nconst xs = [1]\nlog(xs.map(a.get))`, /"a\.get" loses its "this"/)
    assert.equal(run("class-ok", `${A}class C {\n    constructor() { this.z = 3 }\n}\nclass E extends Error {}\nconst a = new A()\nconst g = a.get.bind(a)\nconst h = () => a.get()\nlog(g() + h(), new C().z, new E("m").message, typeof a.toString)`), "2 3 m function")
})

test("an index that is always past the end is an error", () => {
    rejected(`const xs = [1, 2]\nlog(xs[2])`, /"xs\[2\]" is always undefined: xs has 2 elements/)
    rejected(`const xs: int[] = []\nconst n: int = xs[0]`, /expects int, got undefined/)
    rejected(`const s = "ab"\nconst c: string = s[5]`, /expects string, got undefined/)
    rejected(`func f(xs: int[]) { log(xs[xs.length]) }`, /"xs\[xs\.length\]" is always undefined: the last index is length - 1/)
    rejected(`func f(xs: int[]) {\n    for (let i = 0; i <= xs.length; i++) log(xs[i])\n}`, /"i <= xs\.length" goes one step too far/)
    assert.equal(run("index-ok", `const xs = [1, 2]\nconst ys = [1]\nys.push(2)\nconst zs: int[] = []\nzs[zs.length] = 5\nfor (let i = 0; i < xs.length; i++) log(xs[i])\nlog(ys[1], zs[0], "ab"[1])`), "1\n2\n2 5 b")
})

test("built-in APIs have types", () => {
    const AB = `async func a() -> int { return 1 }\nasync func b() -> string { return "x" }\n`
    rejected(`${AB}async func m() {\n    const [x, y] = await Promise.all([a(), b()])\n    const z: int = y\n}`, /"z" expects int, got string/)
    rejected(`const d = new Date()\nconst s: string = d.getTime()`, /"s" expects string, got int/)
    rejected(`async func m() {\n    const r = await fetch("x")\n    const n: int = await r.text()\n}`, /"n" expects int, got string/)
    rejected(`async func m() {\n    const r = await fetch("x")\n    log(r.stauts)\n}`, /Response has no property "stauts" — did you mean "status"\?/)
    rejected(`const m = new Map<string, int>()\nfor (const [k, v] of m) { const t: string = v }`, /"t" expects string, got int/)
    rejected(`const m = new Map<string, int>()\nfor (const k of m.keys()) { const t: int = k }`, /"t" expects int, got string/)
    rejected(`struct U { a: int }\nconst u = U.new({ a: 1 })\nfor (const [k, v] of Object.entries(u)) { const t: string = v }`, /"t" expects string, got int/)
    rejected(`const xs = Array.from({ length: 3 }, (_, i) => i)\nconst s: string = xs[0]`, /"s" expects string, got int/)
    assert.equal(run("builtins-ok", `${AB}async func m() {\n    const [x, y] = await Promise.all([a(), b()])\n    const m = new Map<string, int>()\n    m.set("k", 2)\n    for (const [k, v] of m) log(k, v + x, y)\n    log(Array.from({ length: 3 }, (_, i) => i * 2).join(","), new Date(0).getTime())\n}\nm()`), "k 3 x\n0,2,4 0")
})

test("unawaited promises, bad regexes, inexact integers and array holes are errors", () => {
    rejected(`class Api {\n    async save() -> int { return 1 }\n}\nconst api = new Api()\nasync func main() {\n    api.save()\n}\nmain()`, /"save" is async and nothing awaits it/)
    rejected(`async func main() {\n    fetch("x")\n}\nmain()`, /"fetch" is async and nothing awaits it/)
    rejected(`const r = /(/\nlog(r)`, /invalid regular expression: .*Unterminated group/)
    rejected(`const r = new RegExp("[a-")\nlog(r)`, /invalid regular expression: .*Unterminated character class/)
    rejected(`const n: int = 9007199254740993\nlog(n)`, /too large to be stored exactly .* write 9007199254740993n/)
    rejected(`const n: int = 2 ** 60\nlog(n)`, /"2 \*\* 60" is 1152921504606847000, too large .* 2n \*\* 60n/)
    rejected(`const xs: int[] = [1, , 3]`, /"xs" expects int\[\], got \(int \| undefined\)\[\]/)
    const holes = compile("holes-runtime", `const raw: any = [1, , 3]\nconst xs: int[] = raw\nlog(xs)`)
    assert.notEqual(holes.status, 0)
    assert.match(holes.stderr, /"xs" is of type int\[\]/)
    const big = compile("big-runtime", `const raw: any = Number("1152921504606846976")\nconst n: int = raw\nlog(n)`)
    assert.notEqual(big.status, 0)
    assert.match(big.stderr, /too large to be an exact int/)
    assert.equal(run("exact-ok", `const n: int = 2 ** 53 - 1\nconst r = /(a)\\d+/gi\nlog(n, r.test("a12"), 1e21 > 0)`), "9007199254740991 true true")
})

test("the this type follows the receiver", () => {
    const SHAPES = `class Shape {\n    name: string = "shape"\n    next: this? = null\n    rename(name: string) -> this {\n        this.name = name\n        return this\n    }\n    same(other: this) -> bool { return other.name == this.name }\n}\nclass Circle extends Shape {\n    radius: int = 1\n    grow() -> this {\n        this.radius += 1\n        return this\n    }\n}\n`
    assert.equal(run("this-chain", `${SHAPES}const c = new Circle()\nconst r: int = c.rename("c").grow().radius\nlog(r, c.same(new Circle()), c.name, c.next)`), "2 false c null")
    rejected(`${SHAPES}const s: string = new Circle().rename("x")`, /"s" expects string, got Circle/)
    rejected(`${SHAPES}new Shape().rename("x").grow()`, /"Shape" has no field "grow"/)
    rejected(`${SHAPES}log(new Circle().same(new Shape()))`, /argument "other" of "Circle\.same" expects Circle, got Shape/)
    rejected(`class A {\n    copy() -> this { return new A() }\n}`, /"copy" must return this, but a new A is not this for a subclass of A/)
    rejected(`func f() -> this { return 1 }`, /the "this" type only works in a method of a class, struct, enum or trait/)
    rejected(`class A {\n    static make() -> this { return new A() }\n}`, /a static method has none/)
    rejected(`class A {\n    me() -> A {\n        const x: this = this\n        return x\n    }\n}`, /only works in method signatures and fields/)
    const wrong = compile("this-runtime", `class A {\n    other: A? = null\n    pick() -> this { return this.other ?? this }\n}\nclass B extends A {}\nconst b = new B()\nb.other = new A()\nlog(b.pick())`)
    assert.notEqual(wrong.status, 0)
    assert.match(wrong.stderr, /function "pick" must return B, got object/)
})

test("the this type works in structs, enums and traits", () => {
    const ORD = `trait Ord {\n    compare(other: this) -> int\n    max(other: this) -> this { return this.compare(other) >= 0 ? this : other }\n}\n`
    assert.equal(run("this-struct", `${ORD}struct Money implements Ord {\n    cents: int\n    compare(other: this) -> int { return this.cents - other.cents }\n    double() -> this { return Money.new({ cents: this.cents * 2 }) }\n}\nconst m = Money.new({ cents: 5 }).max(Money.new({ cents: 9 })).double()\nconst c: int = m.cents\nlog(c)\nenum Level {\n    Low, High\n    bump() -> this { return Level.High }\n}\nlog(Level.Low.bump() == Level.High)`), "18\ntrue")
    rejected(`${ORD}struct Money implements Ord {\n    cents: int\n    compare(other: string) -> int { return 1 }\n}`, /"Money\.compare\(other: string\) -> int" doesn't match "compare\(other: Money\) -> int"/)
    rejected(`${ORD}struct Money implements Ord {\n    cents: int\n    compare(other: this) -> int { return 1 }\n}\nstruct Cash { c: int }\nMoney.new({ cents: 1 }).compare(Cash.new({ c: 1 }))`, /expects Money, got Cash/)
    rejected(`enum Level {\n    Low, High\n    bump() -> this { return Level.High }\n}\nconst s: string = Level.Low.bump()`, /"s" expects string, got Level/)
})

test("instances of local classes are checked by name", () => {
    const AB = `class A { x: int = 1 }\nclass B extends A { y: int = 2 }\n`
    rejected(`${AB}const s: string = new A()`, /"s" expects string, got A/)
    rejected(`${AB}func f(b: B) {}\nf(new A())`, /argument "b" of "f" expects B, got A/)
    assert.equal(run("class-nominal-ok", `${AB}func f(a: A) -> int { return a.x }\nconst o: object = new B()\nlog(f(new B()), typeof o)`), "1 object")
})

test("every undefined name and type is an error", () => {
    rejected(`log(compute())`, /"compute" is not defined — declare it, import it with "use", or list it in "globals"/)
    rejected(`func f() -> int { return Ok(1) }`, /"Ok" is not defined — write Result\.Ok/)
    rejected(`let v: Missing = 1`, /unknown type "Missing" — declare it, or bring it in with "use"/)
    accepted(`let p: int = 1\nlet r: Record<string, int> = {}\nlog(p, r, typeof speechSynthesis)`)
    assert.deepEqual(transform(`log(hostValue)`, "safety.slim", { globals: ["hostValue"] }).warnings, [])
})

test("constructors, super calls and static members are checked", () => {
    const P = `class P {\n    x: int\n    static count: int = 0\n    constructor(x: int) { this.x = x }\n}\n`
    rejected(`${P}new P("a")`, /argument "x" of "new P" expects int, got string/)
    rejected(`${P}new P()`, /"new P" expects 1 argument, got 0/)
    rejected(`class E {}\nnew E(1)`, /"E" has no constructor/)
    rejected(`${P}class Q extends P {\n    constructor() { super("a") }\n}`, /argument "x" of "super \(P\)" expects int, got string/)
    rejected(`${P}log(P.cuont)`, /"P" has no static member "cuont" — did you mean "count"\?/)
    rejected(`${P}log(P.x)`, /"x" belongs to instances/)
    rejected(`${P}P.count = "x"`, /"P\.count" expects int, got string/)
    assert.equal(run("class-api-ok", `${P}class Q extends P {\n    constructor() { super(2) }\n}\nclass C {}\nC.cache = 5\nclass W {\n    handler = () => { this.y = 1 }\n    constructor() { [this.a, this.b] = [1, 2] }\n}\nconst w = new W()\nw.handler()\nlog(new Q().x, Q.count, C.cache, P.name, w.a + w.b, w.y)`), "2 0 5 P 3 1")
})

test("explicit type arguments are used", () => {
    const BOX = `struct Box<T> { value: T }\n`
    rejected(`${BOX}Box.new<int>({ value: "x" })`, /"Box<int>\.value" expects int, got string/)
    rejected(`${BOX}Box.new<int, string>({ value: 1 })`, /"Box\.new" takes 1 type argument, got 2/)
    rejected(`func first<T>(xs: T[]) -> T { return xs[0] }\nfirst<string>([1])`, /argument "xs" of "first" expects string\[\], got int\[\]/)
    rejected(`func id(x: int) -> int { return x }\nid<int>(1)`, /"id" has no type parameters/)
    const wrong = compile("type-args-runtime", `${BOX}const raw: any = { value: "x" }\nlog(Box.new<int>(raw))`)
    assert.notEqual(wrong.status, 0)
    assert.equal(run("type-args-ok", `${BOX}const b = Box.new<int>({ value: 2 })\nconst n: int = b.value\nlog(n)`), "2")
})

test("spread and rest arguments are checked", () => {
    const ADD = `func add(a: int, b: int) -> int { return a + b }\nfunc sum(...xs: int[]) -> int { return xs.length }\n`
    rejected(`${ADD}const xs = ["a"]\nadd(...xs)`, /argument "a" of "add" expects int, got string from "\.\.\.xs"/)
    rejected(`${ADD}const t: [int, string] = [1, "a"]\nadd(...t)`, /argument "b" of "add" expects int, got string from "\.\.\.t"/)
    rejected(`${ADD}sum(1, "a")`, /argument "xs" of "sum" expects int, got string/)
    assert.equal(run("spread-ok", `${ADD}const t: [int, int] = [1, 2]\nconst xs = [3, 4]\nlog(add(...t), add(...xs), sum(1, 2), sum(...xs))`), "3 7 2 2")
})

test("operators that never do what was meant are errors", () => {
    rejected(`const a = 10n\nlog(a + 1)`, /"\+" can't mix bigint and number.*write 1n/)
    rejected(`func f(s: string?) -> string { return "hi " + s }`, /"s" may be null here .* "\+" would put "null" into the text/)
    rejected(`const s = "abc"\ns.length = 1`, /"s\.length" can't be changed/)
    rejected(`const n = 5\nif (n == NaN) log(1)`, /NaN is not equal to anything.*Number\.isNaN\(n\)/)
    rejected(`const s = "a"\nlog(s instanceof String)`, /a primitive is never an instance/)
    rejected(`let x = 1\nif (x = 2) log(x)`, /this assigns instead of comparing/)
    rejected(`let x = 1\nx = x`, /"x" is assigned to itself/)
    rejected(`const xs = [1]\nif (xs) log(1)`, /always true — an empty array is truthy too: use xs\.length > 0/)
    rejected(`func f() -> int { return 1 }\nif (f) log(1)`, /always true — did you mean to call it: f\(\)\?/)
    rejected(`const xs = [10, 9]\nxs.sort()`, /sorts numbers as text/)
    rejected(`const xs = [1, 2]\ndelete xs[0]`, /leaves a hole/)
    rejected(`func has(xs: int[]) -> bool {\n    xs.forEach(x => { if (x == 2) return true })\n    return false\n}`, /"forEach" ignores what its callback returns/)
    rejected(`async func get() -> int { return 1 }\nget().then((s: string) => log(s))`, /parameter "s" is string, but it gets int here/)
    assert.equal(run("operators-ok", `const re = /a/g\nlet m\nlet n = 0\nwhile ((m = re.exec("aa"))) n++\nconst xs = ["b", "a"]\nxs.sort()\nfunc f(s: string?, cb?: () => int) -> string {\n    if (cb) log(cb())\n    return "hi " + (s ?? "x")\n}\nlog(n, xs[0], f(null), 1n < 2, 2n == 2)`), "2 a hi x true true")
})

test("repeated names are errors", () => {
    rejected(`struct U {\n    a: int\n    a: string\n}`, /"U" has field "a" twice/)
    rejected(`enum E {\n    A: 1\n    A: 2\n}`, /"E" has member "A" twice/)
    rejected(`const o = { a: 1, a: 2 }\nlog(o)`, /key "a" is written twice/)
    rejected(`func f(n: int) {\n    switch (n) {\n        case 1: log(1); break\n        case 1: log(2); break\n    }\n}`, /this case repeats an earlier one/)
    accepted(`const o = { get a() { return 1 }, set a(v) {} }\nlog(o.a)`)
})

test("a line that starts with [ or ( after a line without ; is an error", () => {
    rejected(`const xs = [1]\n[2].forEach(n => log(n))`, /this line starts with "\[", so it continues the line above/)
    rejected(`const f = () => 1\nconst g = f\n(1)`, /this line starts with "\(", so it calls the value on the line above/)
    assert.equal(run("semicolon-ok", `const xs = [1];\n[2].forEach(n => log(n))\nlog(xs[0], (1 + 1))`), "2\n1 2")
})

test("function types, generators and copies", () => {
    rejected(`func apply(f: (int) => int) {}`, /"int" here is a parameter name, not its type — write \(value: int\) => \.\.\./)
    assert.equal(run("generators", `func* gen(n: int) {\n    for (let i = 0; i < n; i++) yield i\n}\nasync func* tick() { yield 1 }\nasync func main() {\n    for await (const v of tick()) log(v)\n}\nlog([...gen(2)].join(","))\nmain()`), "0,1\n1")
    assert.equal(run("copy-write", `const a = { b: 1 }\nconst c = copyof a\nc.b = 2\nlog(a.b, c.b)`), "1 2")
    rejected(`const a = { b: 1 }\nconst c = copyof a\nc.b = "x"`, /expects int, got string/)
})

test("markup: unknown components, repeated attributes and React names are errors", () => {
    rejected(`component Hello() { return <b>x</b> }\ncomponent App() { return <div><Helo /></div> }`, /<Helo> is not defined — did you mean "Hello"\?/)
    rejected(`component C() { return <div class="a" class="b"></div> }`, /"class" is set twice on <div>/)
    rejected(`component C() { return <div className="a"></div> }`, /"className" is not an HTML attribute — write class/)
    rejected(`component Hello(props: { name: string }) {\n    return <b>\${props.nmae}</b>\n}`, /has no field "nmae" — did you mean "name"\?/)
    assert.equal(run("component-prop-ok", `component A() { return <i>a</i> }\ncomponent W(props: { Inner: function }) {\n    const Inner = props.Inner\n    return <div><Inner /></div>\n}\nlog(W({ Inner: A }).outerHTML)`), "<div><i>a</i></div>")
})

test("an isolated component is checked like any other code", () => {
    rejected(`func out() { return 1 }\nisolated component H() {\n    return <h1>\${out()}</h1>\n}`, /isolated component "H" can't see "out"/)
    rejected(`isolated component H() {\n    const n: int = "x"\n    return <h1>\${n}</h1>\n}`, /"n" expects int, got string/)
    rejected(`isolated component H() {\n    return <h1>\${nope}</h1>\n}`, /"nope" is not defined/)
    assert.equal(run("isolated-ok", `isolated component H(props: { n: int }) {\n    func hi() -> string { return "Hi" }\n    const x: int = props.n\n    return <h1>\${hi()} \${x}</h1>\n}\nlog(H({ n: 1 }).outerHTML)`), "<h1>Hi 1</h1>")
    const wrong = compile("isolated-runtime", `isolated component H(props: { n: int }) {\n    return <h1>\${props.n}</h1>\n}\nconst raw: any = { n: "x" }\nlog(H(raw).outerHTML)`)
    assert.notEqual(wrong.status, 0)
})

test("destructured props keep their types inside the component", () => {
    rejected(`component B({ count: int, label: string }) {\n    const s: string = count\n    return <i>\${s}</i>\n}`, /"s" expects string, got int/)
    assert.equal(run("destructured-props", `component B({ count: int, label: string = "x" }) {\n    const n: int = count + 1\n    return <i>\${n} \${label}</i>\n}\nlog(B({ count: 1 }).outerHTML)`), "<i>2 x</i>")
})

test("classes imported from another file are checked like local ones", () => {
    const failure = source => {
        const dir = tempProject({
            "mod.slim": `export class P {\n    x: int = 1\n    static count: int = 0\n    constructor(x: int) { this.x = x }\n    get() -> int { return this.x }\n    me() -> this { return this }\n}\nexport class Q extends P {\n    y: int = 2\n}\n`,
            "index.slim": source
        })
        try {
            const result = spawnSync(process.execPath, [path.join(root, "src", "compile.js")], { cwd: dir, encoding: "utf8" })
            return { status: result.status, output: result.stdout + result.stderr }
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    }
    const USE = `use { P, Q } from "./mod"\n`
    assert.match(failure(`${USE}const p = new P(1)\nconst s: string = p.get()\nlog(s)\n`).output, /"s" expects string, got int/)
    assert.match(failure(`${USE}log(new P(1).nope)\n`).output, /"P" has no field "nope"/)
    assert.match(failure(`${USE}new P("a")\n`).output, /argument "x" of "new P" expects int, got string/)
    assert.match(failure(`${USE}log(P.cuont)\n`).output, /"P" has no static member "cuont"/)
    assert.match(failure(`${USE}func f(q: Q) {}\nf(new P(1))\n`).output, /argument "q" of "f" expects Q, got P/)
    assert.match(failure(`${USE}class R extends P {\n    constructor() { super("a") }\n}\nlog(new R())\n`).output, /argument "x" of "super \(P\)" expects int, got string/)
    const fine = failure(`${USE}func f(p: P) -> int { return p.get() }\nclass R extends P {\n    constructor() { super(1) }\n}\nconst q: Q = new Q(1).me()\nlog(f(q), f(new R()), q.y, P.count)\n`)
    assert.equal(fine.status, 0, fine.output)
})
