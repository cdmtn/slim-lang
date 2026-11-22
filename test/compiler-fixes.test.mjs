import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { formatSlim } from "../src/format.js"
import { parseSlim } from "../src/syntax/plugin.js"
import { projectExports } from "../src/autoImport.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__compiler_fixes__")
const S = "$"
const RUNTIME = /"[^"]*external\/((?:runtime-dom|runtime-core|defaults|core)\.js)"/g
const linkRuntime = code => code.replace(RUNTIME, (match, file) => JSON.stringify(pathToFileURL(path.join(root, "src", "external", file)).href))

const CLICK = `
const click = (el, selector) => {
    const event = el.ownerDocument.createEvent("Event")
    event.initEvent("click", true, true)
    const target = selector ? el.querySelector(selector) : el
    target.dispatchEvent(event)
}
`

function compile(source, name = "input", options = {}) {
    return transform(source, path.join(root, "__compiler_fixes__", `${name}.slim`), { sourceMaps: false, ...options }).code
}

function execute(file) {
    const result = spawnSync(process.execPath, ["--no-warnings", file], { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim().split("\n")
}

function run(name, source, options = {}) {
    mkdirSync(outputDir, { recursive: true })
    const file = path.join(outputDir, `${name}.js`)
    writeFileSync(file, linkRuntime(compile(CLICK + source, name, options)))
    return execute(file)
}

function project(files, main = "main.slim") {
    const dir = path.join(outputDir, `project_${Math.random().toString(36).slice(2)}`)
    const out = path.join(dir, "out")
    mkdirSync(out, { recursive: true })
    for (const [name, source] of Object.entries(files)) writeFileSync(path.join(dir, name), source)
    try {
        for (const name of Object.keys(files)) {
            const file = path.join(dir, name)
            const { code } = transform(readFileSync(file, "utf8"), file, { sourceMaps: false })
            writeFileSync(path.join(out, name.replace(/\.slim$/, ".js")), linkRuntime(code))
        }
        return execute(path.join(out, main.replace(/\.slim$/, ".js")))
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

test("await and yield work inside match arms", () => {
    const lines = run("match_suspend", `
async function g() { return 5 }
async function f(x) {
    return match (x) {
        1 => await g(),
        2 => match (x) { 2 => await g() + 1, _ => 0 },
        _ => 0
    }
}
function* gen(x) {
    const v = match (x) {
        1 => yield 10,
        _ => 0
    }
    yield v
}
function plain(x) {
    return match (x) { 1 => "one", _ => "other" }
}
async function main() {
    log(await f(1), await f(2), await f(3), [...gen(1)].join(","), plain(1))
}
main()
`)
    assert.deepEqual(lines, ["5 6 0 10, one"])
})

test("a component declared inside another component is reactive and reads the outer state", () => {
    const lines = run("nested_component", `
component Outer() {
    state shared = 1
    component Inner({ k }) {
        state n = 0
        return <i onClick=${S}{() => { n++; shared++ }}>${S}{k}${S}{n}${S}{shared}</i>
    }
    return <div><Inner k="a" /><b>${S}{shared}</b></div>
}
const el = Outer()
click(el, "i")
log(el.innerHTML)
`)
    assert.deepEqual(lines, ["<i>a12</i><b>2</b>"])
})

test("destructuring assignment and for-of targets write to state", () => {
    const lines = run("destructure_state", `
component Swap() {
    state a = 1
    state b = 2
    state c = 0
    return <button onClick=${S}{() => {
        const value = ([a, b] = [b, a])
        ;({ x: c } = { x: value.length + 3 })
        for (b of [7, 8]) {}
    }}>${S}{a}-${S}{b}-${S}{c}</button>
}
const el = Swap()
click(el)
log(el.textContent)
`)
    assert.deepEqual(lines, ["2-8-5"])
})

test("an exported value is reactive exactly when its module makes it a signal or computed", () => {
    const lines = project({
        "cart.slim": `export state count = 1
const other = { count: 5 }
export const label = other.count
function twice() { return count * 2 }
export const doubled = twice()
`,
        "main.slim": `use { count, label, doubled } from "./cart"
log(label, doubled)
count = 4
log(label, doubled)
`
    })
    assert.deepEqual(lines, ["5 2", "5 8"])
})

test("state stays reactive through re-exports and namespace imports", () => {
    const lines = project({
        "cart.slim": `export state count = 1\nexport func inc() { count++ }\n`,
        "re.slim": `export { count } from "./cart.js"\nexport * from "./cart"\n`,
        "re2.slim": `use { count as c2 } from "./cart"\nexport { c2 }\n`,
        "main.slim": `use { count, inc } from "./re"
use { c2 } from "./re2"
use * as cart from "./cart"
log(count, c2, cart.count)
cart.inc()
inc()
log(count, c2, cart.count)
cart.count = 10
log(count)
`
    })
    assert.deepEqual(lines, ["1 1 1", "3 3 3", "10"])
})

test("consts that read imported state or call functions reading it stay up to date", () => {
    const lines = project({
        "cart.slim": `export state items = [1]\nexport func total() { return items.length }\n`,
        "main.slim": `use { items, total } from "./cart"
const count = items.length
component Badge() {
    const t = total()
    return <p>${S}{count}|${S}{t}|${S}{total()}</p>
}
const el = Badge()
items.push(2)
log(el.textContent)
`
    })
    assert.deepEqual(lines, ["2|2|2"])
})

test("a const that calls an imported function changing state still runs right away", () => {
    const lines = project({
        "cart.slim": `export state items = [1]\nexport func bump() { items.push(0); return items.length }\n`,
        "main.slim": `use { items, bump } from "./cart"\nconst pushed = bump()\nlog(items.length)\n`
    })
    assert.deepEqual(lines, ["2"])
})

test("a top-level const with await that reads state is evaluated once", () => {
    const lines = run("await_const", `
state page = 1
async function load(p) { return [p] }
const data = await load(page)
log(data.length, data[0])
`)
    assert.deepEqual(lines, ["1 1"])
})

test("consts in a block-bodied row follow in-place changes of the item", () => {
    const lines = run("row_const", `
component L() {
    state items = [{ id: 1, n: "a" }, { id: 2, n: "b" }]
    return <div><button onClick=${S}{() => { items[0].n = "z" }}>x</button><ul>${S}{items.map(item => {
        const label = item.n.toUpperCase()
        return <li key=${S}{item.id}>${S}{label}</li>
    })}</ul></div>
}
const el = L()
click(el, "button")
log(el.querySelector("ul").innerHTML)
`)
    assert.deepEqual(lines, ["<li>Z</li><li>B</li>"])
})

test("changes through iteration variables and Object.assign update the page", () => {
    const lines = run("item_alias", `
component Todos() {
    state todos = [{ t: "a", done: false }, { t: "b", done: false }]
    state user = { name: "a" }
    return <div>
        <button class="each" onClick=${S}{() => todos.forEach(x => { x.done = true })}>all</button>
        <button class="loop" onClick=${S}{() => { for (const x of todos) x.done = false }}>none</button>
        <button class="assign" onClick=${S}{() => Object.assign(user, { name: "b" })}>x</button>
        <ul>${S}{todos.map(x => <li>${S}{x.t}:${S}{x.done ? "y" : "n"}</li>)}</ul>
        <p>${S}{user.name}</p>
    </div>
}
const el = Todos()
click(el, ".each")
log(el.querySelector("ul").textContent)
click(el, ".loop")
log(el.querySelector("ul").textContent)
click(el, ".assign")
log(el.querySelector("p").textContent)
`)
    assert.deepEqual(lines, ["a:yb:y", "a:nb:n", "b"])
})

test("a change through an optional chain on a null state is skipped", () => {
    const lines = run("optional_mutation", `
component C() {
    state user: any = null
    return <button onClick=${S}{() => { user?.tags.push(1); log("ok") }}>x</button>
}
click(C())
`)
    assert.deepEqual(lines, ["ok"])
})

test("comments between use specifiers are ignored", () => {
    const lines = project({
        "lib.slim": `export const a = 1\nexport const b = 2\n`,
        "main.slim": `use {\n    a, // first one\n    b /* second */\n} from "./lib"\nlog(a, b)\n`
    })
    assert.deepEqual(lines, ["1 2"])
})

test("a quoted event handler is attached", () => {
    const lines = run("quoted_event", `
component C() {
    state n = 0
    return <button onClick="${S}{() => n++}">${S}{n}</button>
}
const el = C()
click(el)
log(el.outerHTML)
`)
    assert.deepEqual(lines, ["<button>1</button>"])
})

test("operator words followed by a binary operator are plain names", () => {
    const lines = run("operator_words", `
const empty = 0
let sizeof = 4
sizeof++
log(empty + 1, empty - 1, sizeof / 5, empty < 1)
log(empty [1], sizeof [1, 2])
`)
    assert.deepEqual(lines, ["1 -1 1 true", "false 2"])
})

test("the postfix ? parses in linear time and before , and )", () => {
    const terms = Array.from({ length: 40 }, () => "p()?").join(" + ")
    const started = performance.now()
    compile(`func p() { return Result.Ok(1) }\nfunc f() {\n    const x = ${terms}\n    return Result.Ok(x)\n}\n`, "try_linear")
    assert.ok(performance.now() - started < 1000)
    const lines = run("try_args", `
func p(x) { return Result.Ok(x) }
func add(a, b) { return a + b }
func f() { return Result.Ok(add(p(1)?, p(2)?) + p(3)?) }
const g = (a?, b) => [a, b]
log(f(), g(1, 2).length)
`)
    assert.deepEqual(lines, ["Result.Ok(6) 2"])
})

test("the formatter keeps multi-line attribute values, string markup and script bodies", () => {
    const attribute = `component C() {\n    return <p title="first\n         second">x</p>\n}\n`
    assert.equal(formatSlim(attribute), attribute)
    const stringMarkup = `const s = <div>\n        a\n    </div>\n`
    assert.equal(formatSlim(stringMarkup), stringMarkup)
    const script = `component C() {\n    return <div><script>\n  const t = \`a\n      b\`\n</script></div>\n}\n`
    assert.equal(formatSlim(script), script)
})

test("the formatter keeps CRLF line endings", () => {
    const source = "func f() {\r\n    return 1\r\n}\r\n"
    assert.equal(formatSlim(source), source)
    assert.equal(formatSlim("func f() {\r\nreturn 1\r\n}"), source)
})

test("the formatter indents markup inside a hole by one level", () => {
    const source = `component A() {
    return <div>
        ${S}{items.map(x => <p>
            ${S}{x}
        </p>)}
        <span>after</span>
    </div>
}
foo(() => {
    body()
})
`
    assert.equal(formatSlim(source), source)
})

test("JSDoc goes before export and typed lets keep their @type", () => {
    const code = compile(`export func greet(name: string) -> string { return name }
let counter: int = 1
export const limit: int = 5
`, "jsdoc_export", { jsdoc: true })
    assert.match(code, /\*\/\nexport function greet/)
    assert.doesNotMatch(code, /export \/\*\*/)
    assert.match(code, /@type \{number\}\s*\*\/\nlet counter;/)
    assert.match(code, /@type \{number\}\s*\*\/\nexport let limit;/)
})

test("a component parameter keeps its default", () => {
    const lines = run("param_default", `
component A(props = { n: 1 }) {
    return <p>${S}{props.n}</p>
}
log(A().outerHTML)
`)
    assert.deepEqual(lines, ["<p>1</p>"])
})

test("extensionless relative imports and re-exports point at .js", () => {
    const code = compile(`import "./lib"\nimport { a } from "./lib"\nexport { b } from "./lib"\nexport * from "./other"\nconst m = import("./lib")\nimport data from "./data.json" with { type: "json" }\n`, "extensions", { check: false })
    assert.doesNotMatch(code, /"\.\/lib"|"\.\/other"/)
    assert.match(code, /import "[^"]*lib\.js";/)
    assert.match(code, /export \* from "[^"]*other\.js"/)
    assert.match(code, /import\("[^"]*lib\.js"\)/)
    assert.match(code, /"\.\/data\.json"/)
})

test("a struct used only as a type is auto-imported", () => {
    const dir = path.join(outputDir, `auto_${Math.random().toString(36).slice(2)}`)
    mkdirSync(path.join(dir, "models"), { recursive: true })
    try {
        writeFileSync(path.join(dir, "models", "user.slim"), `export struct User {\n    name: string\n}\n`)
        const source = `func show(user: User) -> string { return user.name }\nlog(show({ name: "x" }))\n`
        const { code } = transform(source, path.join(dir, "index.slim"), { autoImport: projectExports(dir), outFile: path.join(dir, "out", "index.js"), sourceMaps: false })
        assert.match(code, /import \{ User \} from "[^"]*models\/user\.js"/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("the runtime is imported by URL when the output is on another drive", { skip: process.platform !== "win32" }, () => {
    const drive = root[0].toUpperCase() === "C" ? "D" : "C"
    const code = compile("log(1)\n", "drive", { outFile: `${drive}:\\elsewhere\\out\\drive.js` })
    assert.match(code.split("\n")[0], /^import "file:\/\/\//)
})

test("an isolated component runs with the real runtime in both runtime modes", () => {
    const source = `
isolated component H(props: { n: int }) {
    func hi() -> string { return "Hi" }
    const x: int = props.n
    return <h1>${S}{hi()} ${S}{x}</h1>
}
log(H({ n: 1 }).outerHTML)
isolated component B(props = { n: 3 }) {
    return <p>${S}{props.n}</p>
}
log(String(B()))
`
    assert.deepEqual(run("isolated_globals", source), ["<h1>Hi 1</h1>", "<p>3</p>"])
    assert.deepEqual(run("isolated_imports", source, { runtime: "imports" }), ["<h1>Hi 1</h1>", "<p>3</p>"])
})

test("a nested component reads the outer component's destructured props", () => {
    const lines = run("nested_props", `
component Outer({ label }) {
    state n = 1
    component Inner({ m }) {
        return <i>${S}{label}|${S}{m}</i>
    }
    return <div><b onClick=${S}{() => n++}>b</b><Inner m=${S}{n} /></div>
}
const el = Outer({ label: "L" })
click(el, "b")
log(el.innerHTML)
`)
    assert.deepEqual(lines, ["<b>b</b><i>L|2</i>"])
})

test("a component hands its raw props to the runtime", () => {
    const code = compile(`component A({ a = 1 }) {\n    return <p>${S}{a}</p>\n}\ncomponent B(props) {\n    return <p>${S}{props.x}</p>\n}\n`, "raw_props")
    assert.match(code, /\}, __props__\);/)
    assert.match(code, /\}, props\);/)
})

test("a row key can come from a const of a block-bodied row", () => {
    const lines = run("row_key_const", `
component L() {
    state items = [{ id: 1, n: "a" }, { id: 2, n: "b" }]
    return <div><button onClick=${S}{() => { items = [items[1], items[0]] }}>x</button><ul>${S}{items.map(item => {
        const k = item.id
        return <li key=${S}{k}>${S}{item.n}</li>
    })}</ul></div>
}
const el = L()
click(el, "button")
log(el.querySelector("ul").innerHTML)
`)
    assert.deepEqual(lines, ["<li>b</li><li>a</li>"])
})

test("modules importing each other get complete reactive exports", () => {
    const lines = project({
        "a.slim": `use { bval, bump } from "./b"\nexport state aval = 1\nexport const aDouble = bval * 2\nexport func readA() { return aval }\n`,
        "b.slim": `use { aval, readA } from "./a"\nexport state bval = 10\nexport const bPlus = readA() + 1\nexport func bump() { bval++ }\n`,
        "main.slim": `use { aDouble } from "./a"\nuse { bPlus } from "./b"\nlog(typeof aDouble === "number" ? aDouble : "RAW", bPlus)\n`
    })
    assert.deepEqual(lines, ["20 2"])
})

test("changes through aliases of state items notify the state, and copies don't", () => {
    const lines = run("item_aliases", `
let runs = 0
component T() {
    state todos = [{ t: "a", done: false }, { t: "b", done: false }]
    const open = todos.filter(x => !x.done)
    effect(() => { runs++; todos.length })
    return <div>
        <button class="first" onClick=${S}{() => { const first = todos[0]; first.done = true }}>f</button>
        <button class="find" onClick=${S}{() => { const f = todos.find(x => x.t == "b"); if (f) f.done = true }}>g</button>
        <button class="open" onClick=${S}{() => open.forEach(x => { x.t = x.t.toUpperCase() })}>o</button>
        <button class="copy" onClick=${S}{() => todos.map(x => ({ ...x })).forEach(y => { y.t = "z" })}>c</button>
        <button class="shadow" onClick=${S}{() => {
            for (const row of todos) {
                const todos = 1
                row.done = false
            }
        }}>s</button>
        <ul>${S}{todos.map(x => <li>${S}{x.t}:${S}{x.done ? "y" : "n"}</li>)}</ul>
    </div>
}
const el = T()
const text = () => el.querySelector("ul").textContent
click(el, ".first")
log(text())
click(el, ".find")
log(text())
click(el, ".shadow")
click(el, ".open")
log(text())
await Promise.resolve()
const before = runs
click(el, ".copy")
await Promise.resolve()
log(text(), runs - before)
`)
    assert.deepEqual(lines, ["a:yb:n", "a:yb:y", "A:nB:n", "A:nB:n 0"])
})

test("operator words are names only where the file declares them", () => {
    const lines = run("operator_words_scope", `
const x = 3
log(kindof -1, kindof -x, kindof +1, kindof /ab/, sizeof [1, 2] + 1)
let n = 1
log(kindof ++n, n)
`)
    assert.deepEqual(lines, ["int int int regexp 3", "int 2"])
    const declared = run("operator_words_declared", `
const empty = 5
log(empty % 2, empty ** 2, empty - 1, empty < 6)
`)
    assert.deepEqual(declared, ["1 25 4 true"])
})

test("the postfix ? works in arrays, objects and ternary branches", () => {
    const lines = run("try_positions", `
func p(s: string) -> Result<int, string> {
    const n = Number(s)
    return Number.isInteger(n) ? Result.Ok(n) : Result.Err("bad")
}
func f(s: string, ok: bool) -> Result<any, string> {
    return Result.Ok([[p(s)?, 1], ok ? p(s)? : 0, ok ? p(s)? + 1 : p(s)?, { a: p(s)? }])
}
log(JSON.stringify(f("2", true).unwrap()), JSON.stringify(f("2", false).unwrap()), f("x", true).isErr())
`)
    assert.deepEqual(lines, [`[[2,1],2,3,{"a":2}] [[2,1],0,2,{"a":2}] true`])
})

test("long flat expression chains parse without deep recursion", () => {
    for (const operator of ["+", "&&", "and", "|>"]) {
        const chain = Array.from({ length: 3000 }, () => "s").join(` ${operator} `)
        assert.doesNotThrow(() => parseSlim(`const s = 1\nconst x = ${chain}\n`))
    }
})

test("namespace imports unwrap destructured and computed members", () => {
    const lines = project({
        "cart.slim": `export state count = 1\nexport const label = "L"\nexport const total = count * 10\n`,
        "main.slim": `use * as cart from "./cart"
const { count, label } = cart
const k = "count"
log(count, label, cart[k], cart["label"])
cart.count = 7
log(count, cart[k], cart.total)
`
    })
    assert.deepEqual(lines, ["1 L 1 L", "7 7 70"])
})

test("a default export of a derived const stays reactive", () => {
    const lines = project({
        "cart.slim": `export state count = 2\nconst doubled = count * 2\nexport default doubled\n`,
        "main.slim": `use total from "./cart"\nuse { count } from "./cart"\nlog(total)\ncount = 5\nlog(total)\n`
    })
    assert.deepEqual(lines, ["4", "10"])
})

test("relative imports resolve like use: queries, dotted names, folders and .slim", () => {
    const dir = path.join(outputDir, `paths_${Math.random().toString(36).slice(2)}`)
    mkdirSync(path.join(dir, "folder"), { recursive: true })
    try {
        writeFileSync(path.join(dir, "data.min.slim"), "export const b = 1\n")
        writeFileSync(path.join(dir, "lib.slim"), "export const a = 1\n")
        writeFileSync(path.join(dir, "folder", "index.slim"), "export const c = 1\n")
        const source = "import { a } from \"./lib?v=1\"\nimport { b } from \"./data.min\"\nimport { c } from \"./folder\"\nimport \"./lib.slim\"\nconst m = import(`./lib`)\nuse { b as b2 } from \"./data.min\"\n"
        const { code } = transform(source, path.join(dir, "main.slim"), { sourceMaps: false, check: false })
        assert.match(code, /from "\.\/lib\.js\?v=1"/)
        assert.match(code, /from "\.\/data\.min\.js"/)
        assert.match(code, /from "\.\/folder\/index\.js"/)
        assert.match(code, /import "\.\/lib\.js";/)
        assert.match(code, /import\("\.\/lib\.js"\)/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("arguments inside a generator match arm is the generator's", () => {
    const lines = run("match_arguments", `
function* gen(a, b, c) {
    const v = match (a) {
        1 => arguments.length * 100 + (yield 10),
        _ => 0
    }
    log("v", v)
}
const it = gen(1, 2, 3)
it.next()
it.next(5)
`)
    assert.deepEqual(lines, ["v 305"])
})

test("a quoted event handler with spaces around it is attached", () => {
    const lines = run("quoted_event_spaces", `
component C() {
    state n = 0
    return <i onClick=" ${S}{() => n += 10} ">${S}{n}</i>
}
const el = C()
click(el)
log(el.outerHTML)
`)
    assert.deepEqual(lines, ["<i>10</i>"])
})

test("a struct's own type parameter is not auto-imported", () => {
    const dir = path.join(outputDir, `auto_params_${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    try {
        writeFileSync(path.join(dir, "models.slim"), "export struct Item {\n    n: int\n}\nexport struct T {\n    name: string\n}\n")
        const source = "func first<T>(xs: T[]) -> T { return xs[0] }\nstruct Box<Item> {\n    value: Item\n}\nlog(first([1]))\n"
        const { code } = transform(source, path.join(dir, "main.slim"), { autoImport: projectExports(dir), sourceMaps: false })
        assert.doesNotMatch(code, /models\.js/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("the formatter indents tag attributes and operator continuation lines", () => {
    const source = `component A() {
    const big = 1
    return <div
        class="a"
        title=${S}{big}>
        <input
            type="text" />
    </div>
}
const r = cond
    ? a
    : b
const t = x
    || y
`
    assert.equal(formatSlim(source), source)
})

test("generic type aliases keep their parameters and constraints keep their names", () => {
    const code = compile("type L<T> = T | L<T>[]\nconst x: L<int> = [1]\nlog(x.length)\n", "generic_alias", { check: false })
    assert.match(code, /"params": "T"/)
    assert.match(code, /"generic": "T \| L<T>\[\]"/)
})

test("assigning an object literal to a struct-typed binding builds the struct", () => {
    const source = `
struct E {
    n: int
    tag: string = "t"
    dbl() -> int { return this.n * 2 }
}
let e: E = { n: 1 }
e = { n: 2 }
log(e.dbl(), e.tag)
`
    assert.deepEqual(run("struct_assign", source), ["4 t"])
    assert.deepEqual(run("struct_assign_release", source, { release: true }), ["4 t"])
})

test("type parameters take defaults on traits, structs, enums, functions and aliases", () => {
    const code = compile(`trait Box<T = number> {
    v: T
}
struct S<T = int> {
    v: T
}
func f<T = int>(x: T) -> T { return x }
type A<T = int> = T[]
log(S.new({ v: 1 }).v, f(2))
`, "type_defaults")
    assert.match(code, /"defaults": "\{\\"T\\":\\"int\\"\}"/)
    assert.deepEqual(run("type_defaults_run", `struct S<T = int> {\n    v: T\n}\nfunc f<T = int>(x: T) -> T { return x }\nlog(S.new({ v: 1 }).v, f(2))\n`), ["1 2"])
})

test("generic arrows parse with a Slim return arrow, async or not", () => {
    const lines = run("generic_arrows", `
const f = async <T>(x: T) -> T => x
const g = <T>(x: T) -> T => x
const h = async <T,>(x: T): Promise<T> => x
async function main() {
    log(await f(1), g(2), await h(3))
}
main()
`)
    assert.deepEqual(lines, ["1 2 3"])
})

test("constraint labels keep the written type parameter names", () => {
    const code = compile(`trait Cmp<T> {\n    cmp(o: T) -> int\n}\nfunc m<T extends Cmp<T>>(a: T) -> T { return a }\nfunc n<K, V extends K[]>(k: K, v: V) -> V { return v }\n`, "constraint_labels", { check: false })
    assert.match(code, /__typed_parameter__\(a, _slimSpec\d+ \|\| \(_slimSpec\d+ = __type_spec__\(__type_ref__\("Cmp<any>"/)
    assert.doesNotMatch(code, /Cmp<Cmp/)
    assert.match(code, /_slimSpec\d+ = __type_spec__\(__type_ref__\("any\[\]"\)\)/)
    assert.match(code, /__typed_parameter__\(v, _slimSpec\d+,/)
})

test("state stays reactive through export * as", () => {
    const lines = project({
        "cart.slim": `export state count = 1\nexport func inc() { count++ }\n`,
        "re.slim": `export * as store from "./cart"\n`,
        "main.slim": `use { store } from "./re"\nlog(store.count)\nstore.inc()\nlog(store.count)\nstore.count = 9\nlog(store.count)\n`
    })
    assert.deepEqual(lines, ["1", "2", "9"])
})

test("property names that match DOM runtime names do not pull in the DOM runtime", () => {
    const code = compile(`const config = { route: "/", navigate: 1 }\nlog(config.route, globalThis.HTMLElement == undefined)\n`, "dom_props")
    assert.match(code, /external\/core\.js/)
    assert.doesNotMatch(code, /defaults\.js/)
    assert.match(compile(`log(HTMLElement)\n`, "dom_real"), /external\/defaults\.js/)
})

test("a function named after a builtin type does not replace the type", () => {
    const lines = run("builtin_shadow", `func bigint(value: string | int) -> bigint { return BigInt(value) }\nfunc symbol(value: string) -> symbol { return Symbol(value) }\nlog(bigint("12"), typeof symbol("a"))\n`)
    assert.deepEqual(lines, ["12n symbol"])
})

test("undefined in an optional field counts as a missing field", () => {
    const lines = run("optional_undefined", `struct A { b?: string }
struct B { b?: string = undefined }
struct D { b?: string = "d" }
trait T { b?: string }
type Sh = { b?: string }
const t: T = { b: undefined }
const sh: Sh = { b: undefined }
log(JSON.stringify([A.new({ b: undefined }), B.new({}), D.new({ b: undefined }), t, sh]))
let failed = false
try { A.new(JSON.parse('{ "b": 1 }')) } catch (e) { failed = true }
log(failed)
`)
    assert.deepEqual(lines, [`[{},{},{"b":"d"},{},{}]`, "true"])
})
