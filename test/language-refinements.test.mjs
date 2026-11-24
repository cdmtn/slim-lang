import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { formatSlim } from "../src/format.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__refinement_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function run(name, source, options = {}) {
    mkdirSync(outputDir, { recursive: true })
    const file = path.join(outputDir, `${name}.js`)
    const { code } = transform(source, path.join(root, "__refinement_tests__", `${name}.slim`), { outFile: file, ...options })
    writeFileSync(file, code.replace(/^import\s+[^;]*(?:defaults|core)\.js";$/m, `import ${JSON.stringify(runtimeImport)};`))
    const result = spawnSync(process.execPath, ["--no-warnings", file], { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
}

function diagnostics(source) {
    try {
        const { warnings } = transform(source, "refinements.slim")
        return { errors: [], warnings: warnings.map(warning => warning.message) }
    } catch (error) {
        if (error.slimTypeErrors) return { errors: error.slimTypeErrors.map(diagnostic => diagnostic.message), warnings: [] }
        throw error
    }
}

const accepted = source => assert.deepEqual(diagnostics(source).errors, [], "expected no errors")
const rejected = (source, pattern) => assert.match(diagnostics(source).errors.join("\n"), pattern)
const warned = (source, pattern) => assert.match(diagnostics(source).warnings.join("\n"), pattern)

function project(files, config = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "slim-refine-"))
    writeFileSync(path.join(dir, "slimconfig.json"), JSON.stringify({ main: "index", ...config }))
    for (const [name, source] of Object.entries(files)) writeFileSync(path.join(dir, name), source)
    const result = spawnSync(process.execPath, [path.join(root, "src", "compile.js")], { cwd: dir, encoding: "utf8" })
    return { dir, status: result.status, output: result.stdout + result.stderr }
}

const SHAPES = `struct Circle {\n    kind: "circle"\n    r: float\n}\nstruct Square {\n    kind: "square"\n    side: float\n}\ntype Shape = Circle | Square\n`

test("Record checks keys and values", () => {
    rejected(`let m: Record<string, int> = { a: "x" }`, /"m"\["a"\] expects int, got string/)
    rejected(`let k: Record<"a" | "b", int> = { c: 1 }`, /"k" can't have the key "c"/)
    warned(`let m: Record<string, int> = { a: 1 }\nlet n: int = m.a`, /"n" expects int, got \(int \| undefined\)/)
    assert.equal(run("record", `
let m: Record<string, int> = { a: 1, b: 2 }
log(Object.keys(m).join(","))
const raw: any = { a: "x" }
try { let bad: Record<string, int> = raw } catch (e) { log("rejected") }
`), "a,b\nrejected")
})

test("readonly arrays can't be changed", () => {
    rejected(`let a: readonly int[] = [1]\na.push(2)`, /"a" is readonly int\[\]: "push" would change it/)
    rejected(`let a: readonly int[] = [1]\na[0] = 5`, /"a" is readonly int\[\]: assigning to it would change it/)
    rejected(`let a: readonly int[] = [1]\nlet b: int[] = a`, /"b" expects int\[\], got readonly int\[\]/)
    accepted(`let a: readonly int[] = [1, 2]\nconst b = a.slice(1)\nb.push(3)\nlog(a.includes(1))`)
    assert.equal(run("readonly", `
let a: readonly int[] = [1]
const view: any = a
try { view.push(2) } catch (e) { log(e.message) }
log(a.length)
`), `"a" is readonly int[]: it can't be changed\n1`)
})

test("a write to a field undoes its narrowing, and an assignment narrows it", () => {
    const TYPES = `struct A { city: string }\nstruct U { addr?: A }\n`
    rejected(`${TYPES}func f(u: U) {\n    if (u.addr) {\n        u.addr = undefined\n        log(u.addr.city)\n    }\n}`, /"u\.addr" is undefined here/)
    accepted(`${TYPES}func f(u: U) {\n    if (!u.addr) u.addr = { city: "x" }\n    log(u.addr.city)\n}\nfunc g(u: U) {\n    u.addr = { city: "y" }\n    log(u.addr.city)\n}`)
    accepted(`func h(x: int?) {\n    let y = x\n    if (y == null) y = 0\n    let z: int = y\n}`)
})

test("a match over a union of structs needs a case for each of them", () => {
    rejected(`${SHAPES}func f(s: Shape) {\n    return match (s) { { kind: "circle", r } => r }\n}`, /match on Shape does not handle Square/)
    rejected(`${SHAPES}func f(s: Shape) {\n    return match (s) { { kind: "circle", r } when r > 1.0 => r, { kind: "square", side } => side }\n}`, /does not handle Circle/)
    accepted(`${SHAPES}func f(s: Shape) -> float {\n    return match (s) { { kind: "circle", r } => r, { kind: "square", side } => side }\n}`)
    accepted(`func f(x: any) { return match (x) { { kind: "a" } => 1 } }`)
})

test("enums carry methods and implement traits", () => {
    const output = run("enum-methods", `
trait Describe {
    describe() -> string
    shout() -> string { return this.describe().toUpperCase() }
}
enum Shape implements Describe {
    Circle(radius: float)
    Rect(w: float, h: float)
    Empty

    area() -> float {
        return match (this) {
            Shape.Circle(r) => 3.0 * r * r,
            Shape.Rect(w, h) => w * h,
            Shape.Empty => 0.0
        }
    }
    describe() -> string { return \`\${this.$tag}\` }
}
enum Dir {
    Up
    Down
    flip() -> Dir { return this == Dir.Up ? Dir.Down : Dir.Up }
}
func loud(x: Describe) -> string { return x.shout() }
log(Shape.Rect(2.0, 3.0).area(), loud(Shape.Empty), Dir.Up.flip())
`)
    assert.equal(output, "6 EMPTY Dir.Down")
    const SHAPE = `enum Shape {\n    Circle(radius: float)\n    area() -> float { return 1.0 }\n    scaled(k: float) -> Shape { return this }\n}\n`
    rejected(`${SHAPE}let a: string = Shape.Circle(1.0).area()`, /"a" expects string, got float/)
    rejected(`${SHAPE}Shape.Circle(1.0).scaled("x")`, /argument "k" of "Shape\.scaled" expects float, got string/)
    rejected(`trait Describe { describe() -> string }\nenum Color implements Describe {\n    Red\n    Green\n}`, /"Color" doesn't implement "describe\(\) -> string" from trait "Describe"/)
})

test("traits take type arguments and struct parameters take constraints", () => {
    const COMPARABLE = `trait Comparable<T> {\n    compare(other: T) -> int\n}\n`
    assert.equal(run("generic-trait", `${COMPARABLE}struct Money implements Comparable<Money> {\n    cents: int\n    compare(other: Money) -> int { return this.cents - other.cents }\n}\nlog(Money.new({ cents: 5 }).compare(Money.new({ cents: 3 })))`), "2")
    rejected(`${COMPARABLE}struct Money implements Comparable<Money> {\n    cents: int\n    compare(other: string) -> int { return 0 }\n}`, /doesn't match "compare\(other: Money\) -> int"/)
    rejected(`${COMPARABLE}struct Other implements Comparable {\n    compare(o: int) -> int { return 0 }\n}`, /trait "Comparable" takes 1 type argument, got 0/)
    const PAGE = `struct Named { name: string }\nstruct Page<T extends Named> {\n    items: T[]\n}\n`
    rejected(`${PAGE}let bad: Page<int> = { items: [] }`, /type argument int of "Page" must fit Named/)
    accepted(`${PAGE}let ok: Page<Named> = { items: [] }`)
})

test("variant fields are read after narrowing", () => {
    const SHAPE = `enum Shape {\n    Circle(radius: float)\n    Rect(w: float, h: float)\n}\n`
    assert.equal(run("variant-fields", `${SHAPE}func f(s: Shape) -> float {\n    if (s.$tag == "Circle") return s.radius\n    return s.w\n}\nlog(f(Shape.Circle(2.0)), f(Shape.Rect(3.0, 1.0)))`), "2 3")
    rejected(`${SHAPE}func f(s: Shape) { log(s.radius) }`, /"Shape\.Rect" has no field "radius" — narrow it to "Shape\.Circle" first/)
    rejected(`${SHAPE}func f(s: Shape) { log(s.radus) }`, /"Shape" has no field "radus" — did you mean "radius"\?/)
    accepted(`enum Ev {\n    Click(at: int)\n    Key(at: int, key: string)\n}\nfunc at(e: Ev) -> int { return e.at }`)
})

test("fromJSON rebuilds data enums, attempt and fromPromise build Results", () => {
    const output = run("from-json", `
enum Tree<T> {
    Leaf(value: T)
    Node(left: Tree<T>, right: Tree<T>)
}
func sum(t: Tree<int>) -> int { return match (t) { Tree.Leaf(v) => v, Tree.Node(l, r) => sum(l) + sum(r) } }
const json = JSON.stringify(Tree.Node(Tree.Leaf(1), Tree.Node(Tree.Leaf(2), Tree.Leaf(3))))
const back: Tree<int> = Tree.fromJSON(JSON.parse(json))
log(sum(back))
try { Tree.fromJSON({ $tag: "Nope" }) } catch (e) { log(e.message) }
log(Result.attempt(() => JSON.parse("{bad")).isErr(), Result.attempt(() => 5))
const failed = await Result.fromPromise(Promise.reject(new Error("boom")))
log(failed.isErr(), Option.from(null), Option.from(5))
`)
    assert.equal(output, `6\n"Nope" is not a member of enum "Tree"\ntrue Result.Ok(5)\ntrue Option.None Option.Some(5)`)
    rejected(`const r = Result.attempt(() => 5)\nlet s: string = r.unwrap()`, /"s" expects string, got int/)
})

test("Option leaves the DOM's Option constructor alone", () => {
    const { code } = transform(`log(Option.Some(1))`, "option.slim")
    assert.match(code, /__Option__\.Some\(1\)/)
    assert.equal(run("option-global", `log(Option.Some(1), typeof globalThis.Option, typeof globalThis.__Option__)`), "Option.Some(1) undefined object")
})

test("release builds skip variant payload checks", () => {
    assert.equal(run("release-variant", `enum E { A(x: int) }\nconst v: any = "s"\nlog(E.A(v))`, { release: true }), "E.A('s')")
})

test("a function with ? and no return type returns the failure too", () => {
    rejected(`func parse(raw: string) -> Result<int, string> { return Result.Ok(1) }\nfunc twice(raw: string) {\n    const n = parse(raw)?\n    return Result.Ok(n * 2)\n}\nlet bad: int = twice("1")`, /"bad" expects int, got \(Result<int, any> \| Result<any, string>\)/)
})

test("warnings report unused names and unreachable code without failing", () => {
    const { errors, warnings } = diagnostics(`func f() -> int {\n    let x = 1\n    const _skip = 2\n    func helper() { }\n    for (const item of [1]) { }\n    return 1\n    log("never")\n}\nlog(f())`)
    assert.deepEqual(errors, [])
    assert.deepEqual(warnings, [
        `"x" is declared but never used`,
        `function "helper" is declared but never used`,
        `"item" is declared but never used`,
        "unreachable code: nothing after return runs"
    ])
    assert.deepEqual(diagnostics(`component Card({ title }) { return <b>\${title}</b> }\ncomponent Page() {\n    const Inner = Card\n    return <Inner title="x" />\n}\nlog(Page())`).warnings, [])
    assert.deepEqual(transform(`func f() { let x = 1 }`, "w.slim", { warnings: false }).warnings, [])
})

test("an import nothing uses is reported, and warnings can be turned off", () => {
    const files = {
        "models.slim": `export struct User { name: string }\nexport func greet(u: User) -> string { return u.name }\n`,
        "index.slim": `use { User, greet } from "./models"\n\nconst u: User = { name: "a" }\nlog(u)\n`
    }
    const on = project(files)
    try {
        assert.equal(on.status, 0, on.output)
        assert.match(on.output, /Warning: "greet" is imported but never used/)
        assert.doesNotMatch(on.output, /"User" is imported but never used/)
    } finally {
        rmSync(on.dir, { recursive: true, force: true })
    }
    const off = project(files, { warnings: false })
    try {
        assert.doesNotMatch(off.output, /Warning:/)
    } finally {
        rmSync(off.dir, { recursive: true, force: true })
    }
})

test("a typo in a struct literal gives one error, object types print short", () => {
    assert.deepEqual(diagnostics(`struct U {\n    name: string\n    age: int\n}\nconst u: U = { nmae: "a", age: 1 }`).errors, [`"U" has no field "nmae" — did you mean "name"?`])
    rejected(`func connect(o: { host: string, port?: int }) { log(o.hots) }`, /"\{ host, port\? \}" has no field "hots"/)
})

test("source maps can be written to files or left out", () => {
    const file = project({ "index.slim": `func f(n: int) -> int { return n * 2 }\nlog(f(2))\n` }, { sourceMaps: "file" })
    try {
        const output = readFileSync(path.join(file.dir, "slim-dist", "index.js"), "utf8")
        assert.match(output, /\/\/# sourceMappingURL=index\.js\.map$/)
        assert.equal(JSON.parse(readFileSync(path.join(file.dir, "slim-dist", "index.js.map"), "utf8")).version, 3)
    } finally {
        rmSync(file.dir, { recursive: true, force: true })
    }
    assert.doesNotMatch(transform(`log(1)`, "n.slim", { sourceMaps: false }).code, /sourceMappingURL/)
})

test("the formatter keeps the new syntax stable", () => {
    const source = "enum Shape<T> implements Named {\nCircle(radius: float)\nEmpty\narea() -> float {\nreturn match (this) {\nShape.Circle(r) => r,\n_ => 0.0\n}\n}\n}\ntrait Named {\nname: string\ndescribe() -> string\n}\nconst x = data\n|> parse\n|> (v => v?)\n"
    const once = formatSlim(source)
    assert.match(once, /\n {4}Circle\(radius: float\)\n/)
    assert.match(once, /\n {4}\|> parse\n/)
    assert.equal(formatSlim(once), once)
})

test("the REPL waits for the end of a multi-line declaration", () => {
    const input = "enum S {\n A(x: int)\n B\n}\nlog(match (S.A(4)) { S.A(v) => v, S.B => 0 })\nstruct P {\n x: int\n}\nlog(P.new({ x: 2 }).x)\n.exit\n"
    const result = spawnSync(process.execPath, [path.join(root, "src", "bin", "cli.js"), "repl"], { cwd: root, encoding: "utf8", input })
    assert.match(result.stdout, /\b4\b/)
    assert.match(result.stdout, /\b2\b/)
    assert.doesNotMatch(result.stdout + result.stderr, /Unclosed/)
})

const tscBin = path.join(root, "node_modules", "typescript", "bin", "tsc")

test("tsc accepts the JSDoc and declarations of the new types", existsSync(tscBin) ? {} : { skip: "typescript not installed" }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "slim-tsc-"))
    try {
        const { code, declarations } = transform(`
export enum Tree<T> {
    Leaf(value: T)
    Node(left: Tree<T>, right: Tree<T>)
}
export trait Named {
    name: string
    describe() -> string
}
export struct User implements Named {
    name: string
    describe() -> string { return this.name }
}
export func opts(o: { timeout: int, retries?: int }) -> int { return o.timeout }
export func total(xs: readonly int[]) -> int { return xs.length }
export func scores(m: Record<string, int>) -> int { return 0 }
export func parse(raw: string) -> Result<int, string> { return Result.Ok(1) }
export func first(xs: int[]) -> Option<int> { return Option.None }
export func fail(m: string) -> never { throw new Error(m) }
log(opts({ timeout: 1 }), total([1]), scores({ a: 1 }), parse("1"), first([]), Tree.Leaf(1))
`, path.join(dir, "index.slim"), { jsdoc: true, declarations: true, check: false })
        writeFileSync(path.join(dir, "index.js"), code.replace(/^import\s+[^;]*(?:defaults|core)\.js";$/m, ""))
        writeFileSync(path.join(dir, "index.d.ts"), declarations)
        cpSync(path.join(root, "src", "external", "slim-globals.d.ts"), path.join(dir, "slim-globals.d.ts"))
        const options = { noEmit: true, skipLibCheck: true, target: "es2020", module: "esnext", moduleResolution: "bundler" }
        writeFileSync(path.join(dir, "js.json"), JSON.stringify({ compilerOptions: { ...options, allowJs: true, checkJs: true }, include: ["index.js", "slim-globals.d.ts"] }))
        writeFileSync(path.join(dir, "dts.json"), JSON.stringify({ compilerOptions: { ...options, strict: true }, include: ["index.d.ts"] }))
        for (const config of ["js.json", "dts.json"]) {
            const result = spawnSync(process.execPath, [tscBin, "-p", path.join(dir, config)], { cwd: dir, encoding: "utf8" })
            assert.equal((result.stdout + result.stderr).trim(), "", config)
        }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
