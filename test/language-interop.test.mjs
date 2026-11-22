import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__interop_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href
const cli = path.join(root, "src", "bin", "cli.js")

function run(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const file = path.join(outputDir, `${name}.js`)
    const { code } = transform(source, path.join(root, "__interop_tests__", `${name}.slim`), { outFile: file, warnings: false })
    writeFileSync(file, code.replace(/^import\s+[^;]*(?:defaults|core)\.js";$/m, `import ${JSON.stringify(runtimeImport)};`))
    const result = spawnSync(process.execPath, ["--no-warnings", file], { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
}

function errors(source) {
    try {
        transform(source, "interop.slim", { warnings: false })
        return []
    } catch (error) {
        if (error.slimTypeErrors) return error.slimTypeErrors.map(diagnostic => diagnostic.message)
        return [error.message.split("\n")[0]]
    }
}

const accepted = source => assert.deepEqual(errors(source), [])
const rejected = (source, pattern) => assert.match(errors(source).join("\n"), pattern)

test("a variable or parameter named type doesn't break typed code", () => {
    assert.equal(run("type-name", `
func label(type: string, n: int) -> string { return type + n }
const type = "x"
func same(n: int) -> int { return n }
log(label("a", 1), same(2), type, kindof 1)
`), "a1 2 x int")
})

test("kindof and type() still narrow", () => {
    accepted(`func f(v: int | string) -> int {\n    if (kindof v == "int") { return v }\n    return 0\n}`)
    accepted(`func f(v: int | string) -> int {\n    if (type(v) == "int") { return v }\n    return 0\n}`)
})

test("the core modules compile", () => {
    const folder = path.join(root, "src", "lib")
    const files = readdirSync(folder, { recursive: true }).filter(file => file.endsWith(".slim"))
    assert.ok(files.length > 0)
    for (const file of files) {
        const full = path.join(folder, file)
        assert.doesNotThrow(() => transform(readFileSync(full, "utf8"), full, { warnings: false }), file)
    }
})

test("arguments exists inside a function, and only there", () => {
    assert.equal(run("arguments", `func count() { return arguments.length }\nlog(count(1, 2))`), "2")
    rejected(`log(arguments)`, /"arguments" is not defined/)
    rejected(`const f = () => arguments`, /"arguments" is not defined/)
})

test("a class fits a trait by its members", () => {
    accepted(`trait Named { name: string\n    hello() -> string }
class User { name = "a"
    age = 1
    hello() -> string { return this.name } }
func show(item: Named) -> string { return item.hello() }
show(new User())`)
    rejected(`trait Named { name: string }\nclass Empty { size = 1 }\nfunc show(item: Named) { return item.name }\nshow(new Empty())`, /expects Named, got Empty/)
    accepted(`trait Box<T> { value: T }\nclass IntBox { value = 1 }\nfunc read(box: Box<int>) { return box.value }\nread(new IntBox())`)
})

test("a value with extra fields fits a trait, statically and at runtime", () => {
    assert.equal(run("trait-open", `
trait Point { x: int
    move(by: int) -> int }
func go(p: Point) -> int { return p.move(1) }
const wide = { x: 1, move(by: int) { return by + 1 }, label: "extra" }
log(go(wide), go(JSON.parse('{"x":2}').x ? wide : wide))
const base = { x: 1, label: "a" }
const full: { x: int, label: string } = { ...base }
log(full.x)
`), "2 2\n1")
    rejected(`trait Point { x: int }\nfunc go(p: Point) { return p.x }\nconst a = { y: 1 }\ngo(a)`, /expects Point/)
})

test("a key that can't be a trait field is allowed in a literal", () => {
    accepted(`trait Aria { role: string }\nconst a: Aria = { role: "x", "aria-live": "off" }\nlog(a)`)
})

test("a generic trait checks its fields with the given type", () => {
    assert.equal(run("trait-generic", `trait Box<T> { value: T }\nconst box: Box<int> = { value: 1 }\nlog(box.value)`), "1")
    const failure = spawnFailure("trait-generic-bad", `trait Box<T> { value: T }\nconst box: Box<int> = JSON.parse('{"value":"x"}')\nlog(box)`)
    assert.match(failure, /Box<int>/)
})

function spawnFailure(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const file = path.join(outputDir, `${name}.js`)
    const { code } = transform(source, path.join(root, "__interop_tests__", `${name}.slim`), { outFile: file, warnings: false })
    writeFileSync(file, code.replace(/^import\s+[^;]*(?:defaults|core)\.js";$/m, `import ${JSON.stringify(runtimeImport)};`))
    const result = spawnSync(process.execPath, ["--no-warnings", file], { cwd: root, encoding: "utf8" })
    assert.notEqual(result.status, 0)
    return result.stderr + result.stdout
}

test("as and ! change what the checker sees", () => {
    accepted(`const a = 1\nlog((a as any).foo)`)
    accepted(`const a = [1].find(x => x > 0)!\nlog(a + 1)`)
    accepted(`const m = new Map<string, int>()\nconst v: int = m.get("a")!\nlog(v)`)
    accepted(`struct U { a: int }\nfunc f() -> U { return {} as U }\nf()`)
    rejected(`const a = [1].find(x => x > 0)\nlog(a + 1)`, /may be undefined/)
    rejected(`const a = 1 as string\nconst n: int = a`, /expects int, got string/)
})

test("a class field can promise to be set later", () => {
    accepted(`class A { name!: string }`)
    rejected(`class A { name: string }`, /has no starting value/)
})

test("native classes work as types", () => {
    assert.equal(run("native-types", `
func size(bytes: Uint8Array, url: URL, map: WeakMap<object, int>) -> int { return bytes.length + url.href.length }
log(size(new Uint8Array(2), new URL("http://a.b"), new WeakMap()))
`), "13")
    assert.match(spawnFailure("native-bad", `func f(bytes: Uint8Array) { return 1 }\nf(JSON.parse("[1]"))`), /Uint8Array/)
})

test("an optional parameter takes a value that may be undefined", () => {
    accepted(`func f(a?: string) { return a }\nfunc g(b?: string) { return f(b) }\ng()`)
    accepted(`class T { constructor(a: int, b?: string | null) {} }\nfunc g(c?: string) { return new T(1, c) }\ng()`)
    rejected(`func f(a: string) { return a }\nfunc g(b?: string) { return f(b) }`, /expects string, got/)
})

test("a default can read a name destructured before it", () => {
    accepted(`const [first = 1, second = first] = [2]\nlog(second)`)
    rejected(`log(later)\nconst later = 1`, /used before its declaration/)
})

test("a class reads itself in its own static fields", () => {
    accepted(`class Links {
    static BASE = "https://x"
    static FULL = Links.BASE + "/y"
}
log(Links.FULL)`)
    rejected(`log(Later.BASE)
class Later {
    static BASE = "x"
}`, /used before its declaration/)
})

test("an arrow function's default argument can be left out", () => {
    accepted(`const ctx = { url: (path = "") => "/a" + path }
log(ctx.url())`)
    rejected(`const ctx = { url: (path) => "/a" + path }
log(ctx.url())`, /expects 1 argument, got 0/)
})

test("an async function that returns a promise is awaited once", () => {
    accepted(`async func load() { return Promise.resolve(1) }\nasync func main() { const a: int = await load()\n    log(a) }\nvoid main()`)
    accepted(`async func load() { const r = await fetch("x")\n    return r.json() }\nasync func main() { const a = await load()\n    log(a.name) }\nvoid main()`)
    accepted(`async func load() { const data = JSON.parse("1")\n    return data }\nasync func main() { const a = await load()\n    log(a.b) }\nvoid main()`)
})

test("a class can be named Option or Result", () => {
    assert.equal(run("option-class", `class Option { name = "mine" }\nconst o = new Option()\nlog(o.name)`), "mine")
    rejected(`const o = new Option()`, /is an enum, not a class/)
})

const CLICK = `
const click = (el, selector) => {
    const event = el.ownerDocument.createEvent("Event")
    event.initEvent("click", true, true)
    el.querySelector(selector).dispatchEvent(event)
}
`
const S = "$"

test("a const stays up to date whatever way it reads a state", () => {
    assert.equal(run("derived-kinds", CLICK + `
const TABS = [{ id: 1, text: "one" }, { id: 2, text: "two" }]
component App() {
    state active = 1
    const tab = TABS.find(item => item.id == active)!
    const label = (() => {
        let text = "low"
        if (active > 1) text = "high"
        return text
    })()
    func count() { return active * 2 }
    const twice = count()
    const { text } = tab
    return <p onClick=${S}{() => active = 2}>${S}{tab.text} ${S}{label} ${S}{twice} ${S}{text}</p>
}
const el = App()
log(el.outerHTML)
click(el.ownerDocument.createElement("div").appendChild(el).parentNode, "p")
log(el.outerHTML)
`), "<p>one low 2 one</p>\n<p>two high 4 two</p>")
})

test("a callback that only runs later doesn't make a const recompute", () => {
    assert.equal(run("derived-later", CLICK + `
component App() {
    state n = 0
    let made = 0
    const make = fn => { made++
        return fn }
    const later = make(() => n)
    return <p onClick=${S}{() => n++}>${S}{later()} ${S}{made}</p>
}
const el = App()
click(el.ownerDocument.createElement("div").appendChild(el).parentNode, "p")
log(el.outerHTML)
`), "<p>1 1</p>")
})

test("destructuring props or inject stays live", () => {
    assert.equal(run("derived-pattern", CLICK + `
const Theme = createContext({ tone: "none" })
component Show(props) {
    const { value, unit = "px", ...rest } = props
    const { tone } = inject(Theme)
    return <i>${S}{value}${S}{unit}${S}{rest.extra}${S}{tone}</i>
}
component App() {
    state n = 1
    provide(Theme, { tone: "t" + n })
    return <p onClick=${S}{() => n++}><Show value=${S}{n} extra=${S}{n * 2} /></p>
}
const el = App()
click(el.ownerDocument.createElement("div").appendChild(el).parentNode, "p")
log(el.outerHTML)
`), "<p><i>2px4t2</i></p>")
})

test("an object spread on an element brings its handlers and React names", () => {
    assert.equal(run("spread-handlers", CLICK + `
component App() {
    state n = 0
    const attrs = { id: "a", className: "c", htmlFor: "x", children: "no", onClick: () => n++ }
    return <label ${S}{attrs}>${S}{n}</label>
}
const el = App()
click(el.ownerDocument.createElement("div").appendChild(el).parentNode, "label")
log(el.outerHTML)
`), `<label for="x" class="c" id="a">1</label>`)
})

test("a state compared with the item of a row works with plain items", () => {
    assert.equal(run("row-compare", CLICK + `
component App() {
    state pick = "x"
    return <ul>${S}{["x", "y"].map(item => <li class=${S}{pick === item ? "on" : "off"} onClick=${S}{() => pick = item}>${S}{item}</li>)}</ul>
}
const el = App()
log(el.outerHTML)
click(el, "li:nth-child(2)")
log(el.outerHTML)
`), `<ul><li class="on">x</li><li class="off">y</li></ul>\n<ul><li class="off">x</li><li class="on">y</li></ul>`)
})

test("a use... function can hold state", () => {
    assert.equal(run("hook-state", CLICK + `
func useCounter(start: () => int) {
    state count = start()
    const twice = count * 2
    return { get value() { return { count, twice, inc: () => count++ } } }
}
component App() {
    const counter = useCounter(() => 2)
    const { count, inc } = counter.value
    return <p onClick=${S}{inc}>${S}{count} ${S}{counter.value.twice}</p>
}
const el = App()
click(el.ownerDocument.createElement("div").appendChild(el).parentNode, "p")
log(el.outerHTML)
`), "<p>3 6</p>")
    rejected(`func plain() {\n    state a = 1\n    return a\n}`, /state can only be declared/)
})

test("children are built inside the component they are given to", () => {
    assert.equal(run("lazy-children", `
const Theme = createContext("default")
component Show() { return <b>${S}{inject(Theme)}</b> }
component Dark({ children }) {
    provide(Theme, "dark")
    return <div>${S}{children}${S}{children}</div>
}
component Hidden({ children }) { return <i></i> }
component Loud() {
    log("built")
    return <u></u>
}
component App() {
    return <p><Dark><Show /></Dark><Show /><Hidden><Loud /></Hidden></p>
}
log(App().outerHTML)
`), "<p><div><b>dark</b></div><b>default</b><i></i></p>")
})

test("names from use can be exported, and export from pulls the module into the build", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "slim-interop-"))
    try {
        writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }))
        writeFileSync(path.join(dir, "slimconfig.json"), JSON.stringify({ main: "index" }))
        writeFileSync(path.join(dir, "index.slim"), `use { Option, a, b } from "./barrel"\nlog(new Option().name, a, b)\n`)
        writeFileSync(path.join(dir, "barrel.slim"), `use { a, Option } from "./first"\nexport { a, Option }\nexport { b } from "./second.js"\n`)
        writeFileSync(path.join(dir, "first.slim"), `export const a = 1\nexport class Option { name = "mine" }\n`)
        writeFileSync(path.join(dir, "second.slim"), `export const b = 2\n`)
        const built = spawnSync(process.execPath, [cli, "build"], { cwd: dir, encoding: "utf8" })
        assert.equal(built.status, 0, built.stdout + built.stderr)
        const app = spawnSync(process.execPath, [path.join(dir, "slim-dist", "index.js")], { cwd: dir, encoding: "utf8" })
        assert.equal(app.status, 0, app.stderr)
        assert.equal(app.stdout.trim(), "mine 1 2")
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
    rejected(`export { nothing }`, /nothing/)
})
