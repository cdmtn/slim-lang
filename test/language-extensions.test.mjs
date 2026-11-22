import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__extension_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function run(name, source, options = {}) {
    mkdirSync(outputDir, { recursive: true })
    const file = path.join(outputDir, `${name}.js`)
    const { code } = transform(source, path.join(root, "__extension_tests__", `${name}.slim`), { outFile: file, ...options })
    const runtime = runtimeName => pathToFileURL(path.join(root, "src", "external", runtimeName)).href
    const patched = options.runtime === "imports"
        ? code.replace(/"[^"]*external\/(runtime-(?:dom|core)\.js)"/, (_, runtimeName) => JSON.stringify(runtime(runtimeName)))
        : code.replace(/^import\s+[^;]*(?:defaults|core)\.js";$/m, `import ${JSON.stringify(runtimeImport)};`)
    writeFileSync(file, patched)
    const result = spawnSync(process.execPath, ["--no-warnings", file], { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
}

function messages(source) {
    try {
        transform(source, "extensions.slim")
    } catch (error) {
        if (error.slimTypeErrors) return error.slimTypeErrors.map(diagnostic => diagnostic.message)
        throw error
    }
    return []
}

const accepted = source => assert.deepEqual(messages(source), [], "expected no diagnostics")
const rejected = (source, pattern) => assert.match(messages(source).join("\n"), pattern)

const SHAPES = `struct Circle {\n    kind: "circle"\n    r: float\n}\nstruct Square {\n    kind: "square"\n    side: float\n}\ntype Shape = Circle | Square\n`
const FIGURE = `enum Figure {\n    Circle(radius: float)\n    Rect(w: float, h: float)\n    Empty\n}\n`

test("match destructures objects and arrays", () => {
    const output = run("match-shapes", `
const event = { type: "move", pos: [3, 4], meta: { by: "me" } }
log(match (event) { { type: "click" } => "click", { type: "move", pos: [x, y], ...rest } => \`\${x},\${y} \${Object.keys(rest)}\`, _ => "?" })
log(match ([1, 2, 3]) { [a, b] => a + b, [head, ...tail] => head + tail.length, _ => 0 })
log(match ([5, 1]) { [a, b] when a > b => "desc", [a, b] => "asc", _ => "?" })
log(match ({ x: 0, y: 2 }) { { x: 0, y } => y, _ => -1 })
`)
    assert.equal(output, "3,4 meta\n3\ndesc\n2")
})

test("match patterns narrow the subject and check its fields", () => {
    accepted(`${SHAPES}func area(s: Shape) -> float {\n    return match (s) { { kind: "circle", r } => r * r, { kind: "square", side } => side * side, _ => 0.0 }\n}`)
    rejected(`${SHAPES}func area(s: Shape) -> float {\n    return match (s) { { kind: "circle", side } => side, _ => 0.0 }\n}`, /"Circle" has no field "side"/)
    assert.throws(() => transform(`log(match ([1]) { [a + 1] => 1, _ => 0 })`, "p.slim"), /can't be a match pattern/)
})

test("a typed catch handles only the errors of its type", () => {
    const output = run("typed-catch", `
class NotFound extends Error {}
try { throw new TypeError("t") } catch (e: TypeError | RangeError) { log("type", e.name) }
try { throw new NotFound("nf") } catch (e: NotFound) { log("own", e.message) }
try {
    try { throw new RangeError("deep") } catch (e: TypeError) { log("wrong") }
} catch (e) { log("outer", e.message) }
`)
    assert.equal(output, "type TypeError\nown nf\nouter deep")
})

test("constants can't be assigned again", () => {
    rejected(`const a = 1\na = 2`, /"a" is a constant/)
    rejected(`const a = 1\na += 2`, /"a" is a constant/)
    rejected(`const a = 1\na++`, /"a" is a constant/)
    accepted(`let a = 1\na = 2\na++`)
})

test("an enum member without a value follows the previous number", () => {
    assert.equal(run("enum-auto", `enum R {\n    A: 5\n    B\n    C\n}\nenum D {\n    Up\n    Down\n}\nlog(R.C, R.values().join(","), D.values().join(","))`), "7 5,6,7 Up,Down")
})

test("generic constraints are checked at the call and inside the body", () => {
    const NAMED = `struct Named { name: string }\n`
    rejected(`${NAMED}func g<T extends Named>(x: T) -> string { return x.name }\ng(5)`, /type parameter "T" of "g" must fit Named, got int/)
    rejected(`${NAMED}func g<T extends Named>(x: T) -> string { return x.nmae }`, /"Named" has no field "nmae"/)
    accepted(`${NAMED}func g<T extends Named>(x: T) -> T { return x }\nconst n: Named = { name: "a" }\ng(n)`)
})

test("a value that may be null can't be read without a check", () => {
    const USER = `struct User { name: string }\n`
    rejected(`${USER}func f(u: User?) { log(u.name) }`, /"u" may be null here \(User\?\) — check it first or use "\?\."/)
    rejected(`${USER}func f(us: User[]) { log(us.find(u => u.name == "a").name) }`, /"us\.find\(\.\.\.\)" may be undefined/)
    rejected(`struct A { city: string }\nstruct U { addr?: A }\nfunc f(u: U) { log(u.addr.city) }`, /"u\.addr" may be undefined/)
    accepted(`${USER}func f(u: User?) {\n    if (u) log(u.name)\n    log(u?.name, u && u.name, u ? u.name : "")\n    if (u == null) return\n    log(u.name)\n}`)
})

test("a union of structs narrows by its literal field", () => {
    rejected(`${SHAPES}func f(s: Shape) -> float { if (s.kind == "circle") { return s.side } return 0.0 }`, /"Circle" has no field "side"/)
    rejected(`${SHAPES}func f(s: Shape) { log(s.r) }`, /"Square" has no field "r" — narrow it to "Circle" first/)
    accepted(`${SHAPES}func f(s: Shape) -> float {\n    if (s.kind == "circle") return s.r\n    return s.side\n}\nfunc g(s: Shape) -> float {\n    switch (s.kind) {\n        case "circle": return s.r\n        case "square": return s.side\n    }\n    return 0.0\n}`)
})

test("never marks functions that don't finish normally", () => {
    accepted(`func fail(m: string) -> never { throw new Error(m) }\nfunc pick(x: int?) -> int {\n    if (x == null) return fail("none")\n    return x\n}`)
    rejected(`func fail(m: string) -> never { log(m) }`, /"fail" is declared -> never, but it can finish normally/)
    rejected(`func fail(m: string) -> never { return 1 }`, /"fail" must return never, got int/)
})

test("object types check fields statically and at runtime", () => {
    rejected(`func opts(o: { timeout: int, retries?: int }) { }\nopts({ timout: 5 })`, /has no field "timout" — did you mean "timeout"\?/)
    rejected(`func opts(o: { timeout: int }) { log(o.timeot) }`, /has no field "timeot"/)
    rejected(`let p: { x: int, y: int } = { x: 1, y: 2 }\np = { x: 1 }`, /is missing field "y" of type int/)
    const output = run("object-types", `
func opts(o: { timeout: int, retries?: int }) -> int { return o.timeout + (o.retries ?? 0) }
log(opts({ timeout: 5 }), opts({ timeout: 1, retries: 2 }))
const bad: any = { timeout: "x" }
try { opts(bad) } catch (e) { log("rejected") }
`)
    assert.equal(output, "5 3\nrejected")
})

test("built-in string and array methods check their arguments", () => {
    rejected(`const s = "abc"\nlet n: int = s.indexOf(1)`, /argument "searchString" of "string\.indexOf" expects string, got int/)
    rejected(`let a: int[] = [1]\na.push("x")`, /argument of "int\[\]\.push" expects int, got string/)
    rejected(`let a: int[] = [1]\nlog(a.join(1))`, /argument "separator" of "int\[\]\.join" expects string, got int/)
    accepted(`const s = "abc"\nconst a = []\na.push(1)\nconst names = ["a", "b"]\nlog(s.slice(0, s.length / 2), s.padStart(5, "-"), names.includes(s), s.replace(/a/g, x => x))`)
})

test("a spread in a struct literal brings its fields in", () => {
    const USER = `struct U {\n    name: string\n    age: int\n}\nconst u: U = { name: "a", age: 1 }\n`
    rejected(`${USER}const v: U = { ...u, age: "x" }`, /"U\.age" expects int, got string/)
    rejected(`${USER}struct N { name: string }\nconst n: N = { name: "a" }\nconst v: U = { ...n }`, /"U" is missing field "age"/)
    accepted(`${USER}const v: U = { ...u, age: 2 }\nconst w: U = { ...JSON.parse("{}") }`)
})

test("an enum can carry data and match takes it apart", () => {
    const output = run("data-enum", `${FIGURE}
func area(f: Figure) -> float {
    return match (f) {
        Figure.Circle(r) => 3.0 * r * r,
        Figure.Rect(w, h) => w * h,
        Figure.Empty => 0.0
    }
}
log(area(Figure.Circle(1.0)), area(Figure.Rect(2.0, 3.0)), area(Figure.Empty), Figure.Rect(2.0, 3.0), kindof Figure.Empty)
log(JSON.stringify(Figure.Circle(2.5)), \`\${Figure.Rect(1.5, 2.5)}\`)
log(match (Figure.Circle(0.0)) { Figure.Circle(0.0) => "dot", Figure.Circle(r) => "circle", _ => "?" })
const raw: any = "x"
try { Figure.Circle(raw) } catch (e) { log(e.message) }
`)
    assert.equal(output, [
        "3 6 0 Figure.Rect(2, 3) enum",
        `{"$tag":"Circle","radius":2.5} Figure.Rect(1.5, 2.5)`,
        "dot",
        `Figure.Circle: "radius" expected float, got string: "x"`
    ].join("\n"))
})

test("data enums are checked: payloads, arity, patterns and coverage", () => {
    rejected(`${FIGURE}func f(x: Figure) -> float { return match (x) { Figure.Circle(r) => r } }`, /match on "Figure" does not handle Figure\.Rect, Figure\.Empty/)
    rejected(`${FIGURE}Figure.Circle("x")`, /argument "radius" of "Figure\.Circle" expects float, got string/)
    rejected(`${FIGURE}Figure.Circle(1.0, 2.0)`, /"Figure\.Circle" takes 1 argument, got 2/)
    rejected(`${FIGURE}func f(x: Figure) -> float { return match (x) { Figure.Circle(r, q) => r, _ => 0.0 } }`, /"Figure\.Circle" has 1 field, the pattern gives more/)
    rejected(`${FIGURE}func f(x: Figure) -> float { return match (x) { Figure.Empty(e) => 0.0, _ => 1.0 } }`, /"Figure\.Empty" carries no data/)
    rejected(`${FIGURE}func f(x: Figure) -> string { return match (x) { Figure.Circle(r) => r, _ => "" } }`, /"f" must return string, got \(float \| string\)/)
})

test("generic data enums bind their type parameters", () => {
    const output = run("tree", `
enum Tree<T> {
    Leaf(value: T)
    Node(left: Tree<T>, right: Tree<T>)
}
func sum(t: Tree<int>) -> int {
    return match (t) {
        Tree.Leaf(v) => v,
        Tree.Node(l, r) => sum(l) + sum(r)
    }
}
log(sum(Tree.Node(Tree.Leaf(1), Tree.Node(Tree.Leaf(2), Tree.Leaf(3)))))
`)
    assert.equal(output, "6")
    rejected(`enum Box<T> {\n    Full(value: T)\n    Empty\n}\nfunc f(b: Box<int>) -> string { return match (b) { Box.Full(v) => v, Box.Empty => "" } }`, /must return string, got \(int \| string\)/)
})

test("Result, Option and ? return failures early", () => {
    const output = run("result", `
func parse(raw: string) -> Result<int, string> {
    const n = Number(raw)
    if (Number.isNaN(n)) return Result.Err(\`not a number: \${raw}\`)
    return Result.Ok(Math.trunc(n))
}
func double(raw: string) -> Result<int, string> {
    const n = parse(raw)?
    return Result.Ok(n * 2)
}
func guarded(r: Result<int, string>) -> Result<int, string> {
    try {
        return Result.Ok(r? + 1)
    } catch (e) {
        return Result.Err("crashed")
    }
}
const half = (xs: int[]) -> Option<int> => {
    const found = xs.find(x => x % 2 == 0)
    return Option.Some((found == null ? Option.None : Option.Some(found))? ~/ 2)
}
log(double("21"), double("x"), double("4").unwrap(), double("x").unwrapOr(0), double("1").isOk())
log(match (double("x")) { Result.Ok(v) => \`\${v}\`, Result.Err(e) => e })
log(guarded(Result.Ok(1)), guarded(Result.Err("bad")), half([1, 4]), half([1, 3]))
const ternary = true ? "yes" : "no"
const multiline = false
    ? "a"
    : "b"
func scaled(r: Result<int, string>) -> Result<int, string> { return Result.Ok(r? * 10 + 1) }
log(ternary, multiline, scaled(Result.Ok(4)))
`)
    assert.equal(output, [
        "Result.Ok(42) Result.Err('not a number: x') 8 0 true",
        "not a number: x",
        "Result.Ok(2) Result.Err('bad') Option.Some(2) Option.None",
        "yes b Result.Ok(41)"
    ].join("\n"))
})

test("? is checked against the value and the function's return type", () => {
    rejected(`func f(r: Result<int, string>) -> int { return r? }`, /"\?" returns the Err from "f", but "f" returns int/)
    rejected(`func f(n: int) -> Result<int, string> { return Result.Ok(n?) }`, /"\?" needs a Result or an Option, got int/)
    rejected(`func f(r: Result<int, string>) -> Result<string, string> {\n    let s: string = r?\n    return Result.Ok(s)\n}`, /"s" expects string, got int/)
    assert.throws(() => transform(`const r = Result.Ok(1)\nconst v = r?`, "t.slim"), /"\?" can only be used inside a function/)
})

test("Result and Option work with runtime imports", () => {
    const output = run("result-imports", `func f(n: int) -> Result<int, string> {\n    return n > 0 ? Result.Ok(n) : Result.Err("neg")\n}\nlog(f(1), f(-1).isErr(), typeof globalThis.Result)`, { runtime: "imports", check: false })
    assert.equal(output, "Result.Ok(1) true object")
})

test("a trait describes what a struct has to provide", () => {
    const output = run("trait", `
trait Named {
    name: string
    describe() -> string
    greet() -> string { return "Hi, " + this.describe() }
}
struct User implements Named {
    name: string
    age: int
    describe() -> string { return \`\${this.name} (\${this.age})\` }
}
func show(x: Named) -> string { return x.greet() }
const u = User.new({ name: "Ada", age: 36 })
log(show(u), u.greet())
const raw: any = { name: "x" }
try { show(raw) } catch (e) { log("rejected") }
`)
    assert.equal(output, "Hi, Ada (36) Hi, Ada (36)\nrejected")
})

test("traits are checked where structs implement and use them", () => {
    const NAMED = `trait Named {\n    name: string\n    describe() -> string\n}\n`
    rejected(`${NAMED}struct User implements Named {\n    age: int\n}`, /"User" needs field "name: string" for trait "Named"/)
    rejected(`${NAMED}struct User implements Named {\n    age: int\n}`, /"User" doesn't implement "describe\(\) -> string" from trait "Named"/)
    rejected(`${NAMED}struct User implements Named {\n    name: int\n    describe() -> int { return 1 }\n}`, /"User\.name" is int, but trait "Named" needs string/)
    rejected(`${NAMED}struct User implements Named {\n    name: string\n    describe() -> int { return 1 }\n}`, /doesn't match "describe\(\) -> string"/)
    rejected(`${NAMED}struct User implements Nmaed { name: string }`, /unknown trait "Nmaed" — did you mean "Named"\?/)
    rejected(`${NAMED}struct Dog { name: string }\nfunc f(x: Named) { log(x.name) }\nf(Dog.new({ name: "d" }))`, /argument "x" of "f" expects Named, got Dog/)
    rejected(`${NAMED}func f(x: Named) { log(x.nmae) }`, /"Named" has no field "nmae"/)
    rejected(`${NAMED}func f(x: Named) { }\nf({ name: "x" })`, /"Named" is missing method "describe\(\)"/)
})

test("the pipe operator passes a value into the next call", () => {
    const output = run("pipe", `
func double(n: int) -> int { return n * 2 }
func add(n: int, m: int) -> int { return n + m }
log(5 |> double |> add(1) |> (x => x * 10))
log([3, 1, 2] |> (xs => xs.toSorted()) |> (xs => xs.join("-")), 1 | 2)
`)
    assert.equal(output, "110\n1-2-3 3")
    rejected(`func double(n: int) -> int { return n * 2 }\nconst r = "x" |> double`, /argument "n" of "double" expects int, got string/)
})

test("data enums and traits cross module boundaries", () => {
    const dir = path.join(tmpdir(), `slim-ext-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    try {
        writeFileSync(path.join(dir, "slimconfig.json"), '{ "main": "index" }')
        writeFileSync(path.join(dir, "models.slim"), `export ${FIGURE}\nexport trait Named {\n    name: string\n}\n`)
        writeFileSync(path.join(dir, "index.slim"), `use { Figure, Named } from "./models"\n\nFigure.Circle("x")\nstruct User implements Named { age: int }\n`)
        const result = spawnSync(process.execPath, [path.join(root, "src", "compile.js")], { cwd: dir, encoding: "utf8" })
        const output = result.stdout + result.stderr
        assert.equal(result.status, 1, output)
        assert.match(output, /argument "radius" of "Figure\.Circle" expects float, got string/)
        assert.match(output, /"User" needs field "name: string" for trait "Named"/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
