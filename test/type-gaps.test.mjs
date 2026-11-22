import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href
let folders = 0

function folder() {
    const dir = outputFolder(`type-gaps-${folders++}`)
    mkdirSync(path.join(dir, "slim-dist"), { recursive: true })
    return dir
}

function diagnostics(source, file = path.join(root, "__type_gaps__", "check.slim"), options = {}) {
    try {
        const { warnings } = transform(source, file, { sourceMaps: false, ...options })
        return { errors: [], warnings: warnings.map(warning => warning.message) }
    } catch (error) {
        if (!error.slimTypeErrors) throw error
        return { errors: error.slimTypeErrors.map(item => item.message), warnings: (error.slimWarnings ?? []).map(item => item.message) }
    }
}

function accepted(source, options) {
    assert.deepEqual(diagnostics(source, undefined, options).errors, [])
}

function rejected(source, pattern, options) {
    const { errors } = diagnostics(source, undefined, options)
    assert.ok(errors.some(message => pattern.test(message)), `expected ${pattern}, got ${JSON.stringify(errors)}`)
}

function warned(source, pattern) {
    const { warnings } = diagnostics(source)
    assert.ok(warnings.some(message => pattern.test(message)), `expected ${pattern}, got ${JSON.stringify(warnings)}`)
}

function compileTo(dir, name, source, options = {}) {
    const file = path.join(dir, `${name}.slim`)
    writeFileSync(file, source)
    const outFile = path.join(dir, "slim-dist", `${name}.js`)
    const { code } = transform(source, file, { sourceMaps: false, outFile, ...options })
    const local = code.replace(/ from "[^"]*?([\w-]+)\.js";$/gm, ' from "./$1.js";')
    writeFileSync(outFile, local.replace(/^import\s+"[^"]*(?:defaults|core)\.js";$/m, `import ${JSON.stringify(runtimeImport)};`))
    return outFile
}

function run(outFile) {
    const result = spawnSync(process.execPath, ["--no-warnings", outFile], { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim().split("\n")
}

function runSource(source) {
    return run(compileTo(folder(), "main", source, { check: false }))
}

test("static methods check their arguments and results", () => {
    rejected(`class A { static f(x: int) {} }\nA.f("s")`, /argument "x" of "A\.f" expects int, got string/)
    rejected(`struct User { name: string }\nclass Api { static me() -> User { return User.new({ name: "a" }) } }\nlog(Api.me().Nmae)`, /"User" has no field "Nmae"/)
    rejected(`class A { static make() -> int { return 1 } }\nconst s: string = A.make()`, /"s" expects string, got int/)
    rejected(`class A { static f(x: int) {} }\nclass B extends A {}\nB.f("s")`, /argument "x" of "B\.f" expects int/)
    accepted(`class A { static f(x: int) -> int { return x } }\nconst n: int = A.f(2)\nlog(n)`)
})

test("an imported class keeps its static signatures", () => {
    const dir = folder()
    compileTo(dir, "api", `export struct User { name: string }\nexport class Api { static me() -> User { return User.new({ name: "a" }) } }`)
    assert.throws(() => compileTo(dir, "main", `use { Api } from "./api"\nlog(Api.me().nmae)`), /"User" has no field "nmae"/)
})

test("then and catch carry the promised type", () => {
    rejected(`struct User { name: string }\nfunction load() { return fetch("x").then(r => User.verify(r)) }\nconst p: Promise<int> = load()`, /"p" expects Promise<int>, got Promise<User>/)
    rejected(`const p: Promise<string> = Promise.resolve(1).then(n => n + 1)`, /expects Promise<string>, got Promise<int>/)
    accepted(`const p: Promise<int | string> = Promise.resolve(1).catch(e => "x")\nconst q: Promise<int> = Promise.resolve(1).finally(() => {})\nlog(p, q)`)
    accepted(`async function f() -> int { return await Promise.resolve(2).then(n => Promise.resolve(n * 2)) }\nlog(f)`)
})

test("Struct<T> takes a struct and gives back its instances", () => {
    const model = `struct User { name: string }\nstruct Other { id: int }\nfunc wrap<T>(model: Struct<T>, v: any) -> T { return model.verify(v) }\n`
    rejected(`${model}const n: int = wrap(User, { name: "a" })`, /"n" expects int, got User/)
    rejected(`${model}wrap(5, {})`, /argument "model" of "wrap" expects Struct<any>, got int/)
    rejected(`${model}const s: Struct<User> = Other`, /"s" expects Struct<User>, got Struct<Other>/)
    accepted(`${model}const u: User = wrap(User, { name: "a" })\nconst s: Struct = Other\nlog(u, s)`)
    const lines = runSource(`${model}const u = wrap(User, { name: "a" })\nlog(u.name)\nfunc plain(m: Struct<User>) -> string { return m.name }\nlog(plain(User))\ntry { wrap(5, {}) } catch (e) { log(e.message.includes("Struct<any>")) }`)
    assert.deepEqual(lines, ["a", "User", "true"])
})

test("writes to declared globals are checked", () => {
    const head = `struct Run { step: int }\nglobal let b: Run | undefined\nglobal kit: Run\n`
    rejected(`${head}b = { step: "x" }`, /"Run\.step" expects int, got string/)
    rejected(`${head}kit = Run.new({ step: 1 })`, /"kit" is a read-only global/)
    rejected(`${head}kit++`, /"kit" is a read-only global/)
    rejected(`${head}globalThis.kit = 5`, /"globalThis\.kit" expects Run, got int/)
    rejected(`${head}globalThis["b"] = 5`, /"globalThis\.b" expects Run\?|"globalThis\.b" expects \(Run \| undefined\)/)
    accepted(`${head}b = undefined\nb = { step: 2 }\nglobalThis.kit = Run.new({ step: 1 })\nglobalThis.other = 5\nlog(b, kit)`)
})

test("writes to a global declared in the host are checked", () => {
    const dir = folder()
    const host = path.join(dir, "host.slim")
    writeFileSync(host, `global speed: int\nglobal let mode: string\n`)
    const options = { host, warnings: false, outFile: path.join(dir, "slim-dist", "index.js") }
    const check = source => {
        try {
            transform(source, path.join(dir, "index.slim"), options)
            return []
        } catch (error) {
            return error.slimTypeErrors?.map(item => item.message) ?? [error.message]
        }
    }
    assert.ok(check(`speed = 2`).some(message => /"speed" is a read-only global/.test(message)))
    assert.ok(check(`mode = 2`).some(message => /"mode" expects string, got int/.test(message)))
    assert.deepEqual(check(`mode = "fast"\nglobalThis.speed = 3`), [])
})

test("keyof, indexed access and rest parameters work in types", () => {
    const events = `trait Events {\n    tick: (dt: float) => void\n    chat: (who: string, text: string) => void\n}\n`
    const on = `${events}func on<K extends keyof Events>(e: K, h: Events[K]) {}\n`
    accepted(`${on}on("tick", (dt: float) => {})\non("chat", (who, text) => { const s: string = text })`)
    rejected(`${on}on("tick", (a: string, b: float) => {})`, /argument "h" of "on" expects Events\["tick"\]/)
    rejected(`${on}on("nope", () => {})`, /type parameter "K" of "on" must fit keyof Events, got "nope"/)
    rejected(`${events}trait Game { on<K extends keyof Events>(e: K, h: Events[K]) }\nglobal game: Game\ngame.on("tick", (a: string) => {})`, /expects Events\["tick"\]/)
    rejected(`struct Cfg { size: int, name: string }\nconst k: keyof Cfg = "x"`, /"k" expects keyof Cfg, got "x"/)
    rejected(`struct Cfg { size: int, name: string }\nconst v: Cfg["name"] = 1`, /"v" expects Cfg\["name"\], got int/)
    accepted(`struct Cfg { size: int, name: string }\nconst k: keyof Cfg = "size"\nconst v: Cfg["size"] = 2\nconst r: keyof Record<string, int> = "any"\nlog(k, v, r)`)
    accepted(`type Log = (...args: any[]) => void\nconst l: Log = (a, b) => {}\nl(1, "2", true)\ntrait Core { log: (...args: any[]) => void }\nglobal core: Core\ncore.log("a", 1)`)
    rejected(`type Strs = (...args: string[]) => void\nconst s: Strs = (a: int) => {}`, /"s" expects Strs/)
    rejected(`const f: (first: int, ...rest: string[]) => void = (x: int) => {}\nf(1, 2)`, /argument "rest" of "f" expects string, got int/)
    assert.throws(() => transform(`type Bad = (...args: int[], last: int) => void`, path.join(root, "__type_gaps__", "rest.slim")), /Rest element must be last|rest parameter/)
    assert.throws(() => transform(`type Bad = (...args: int) => void`, path.join(root, "__type_gaps__", "rest.slim")), /a rest parameter needs an array type/)
})

test("keyof and indexed access types are checked at runtime", () => {
    const lines = runSource(`struct Cfg { size: int, name: string }
trait Events { tick: (dt: float) => void }
func on<K extends keyof Events>(e: K, h: Events[K]) { log(e) }
on("tick", (dt: float) => {})
const k: keyof Cfg = "size"
const v: Cfg["size"] = 4
const l: (...args: any[]) => void = (a, b) => {}
l(1, 2, 3)
try { const bad: keyof Cfg = "zzz" } catch (e) { log("keyof") }
try { const bad: Cfg["name"] = 5 } catch (e) { log("index") }
log(k, v)`)
    assert.deepEqual(lines, ["tick", "keyof", "index", "size 4"])
})

test("an imported JSON file has the type of its contents", () => {
    const dir = folder()
    writeFileSync(path.join(dir, "data.json"), JSON.stringify({ techs: [1, 2], count: 3, ratio: 0.5, items: [{ id: 1, tag: "a" }, { id: 2 }] }))
    const check = source => {
        try {
            transform(source, path.join(dir, "main.slim"), { warnings: false, sourceMaps: false })
            return []
        } catch (error) {
            return error.slimTypeErrors.map(item => item.message)
        }
    }
    const head = `import d from "./data.json"\n`
    assert.ok(check(`${head}const n: number = d.techs`).some(message => /"n" expects number, got int\[\]/.test(message)))
    assert.ok(check(`${head}const r: int = d.ratio`).some(message => /"r" expects int, got float/.test(message)))
    assert.ok(check(`${head}const t: string = d.items[0].tag`).some(message => /may be|undefined/.test(message)))
    assert.ok(check(`${head}log(d.nope)`).some(message => /has no field "nope"/.test(message)))
    assert.deepEqual(check(`${head}const c: int = d.count\nconst ids: int[] = d.items.map(item => item.id)\nlog(c, ids)`), [])
})

test("an imported struct keeps the field types of its own module", () => {
    const dir = folder()
    compileTo(dir, "m", `export struct Ingredient { item: int }\nexport struct Recipe { id: int, inputs: Ingredient[], table: Record<string, Ingredient> }`)
    const main = `use { Recipe } from "./m"\ntrait Ingredient { name: string }\n`
    const good = compileTo(dir, "good", `${main}const r: Recipe = Recipe.new({ id: 1, inputs: [{ item: 1 }], table: { a: { item: 2 } } })\nconst i: Ingredient = { name: "a" }\nlog(r.id, i.name)`)
    assert.deepEqual(run(good), ["1 a"])
    assert.throws(() => compileTo(dir, "bad", `${main}const r: Recipe = Recipe.new({ id: 1, inputs: [{ name: "x" }], table: {} })\nlog(r)`), /m\.Ingredient/)
    const aliased = compileTo(dir, "aliased", `use { Recipe, Ingredient as Part } from "./m"\ntrait Ingredient { name: string }\nconst p: Part = Part.new({ item: 3 })\nconst r: Recipe = Recipe.new({ id: 2, inputs: [p], table: {} })\nlog(r.inputs[0].item)`)
    assert.deepEqual(run(aliased), ["3"])
    const wrong = compileTo(dir, "wrong", `${main}try { Recipe.new({ id: 1, inputs: [], table: { a: { name: "x" } } }) } catch (e) { log("rejected") }`, { check: false })
    assert.deepEqual(run(wrong), ["rejected"])
})

test("a broken host file is reported again instead of breaking later files", () => {
    const dir = folder()
    const host = path.join(dir, "host.slim")
    writeFileSync(host, `global terrain: int\nconst = broken\n`)
    const options = { host, warnings: false, outFile: path.join(dir, "slim-dist", "index.js") }
    for (const name of ["a", "b"]) {
        assert.throws(() => transform(`log(terrain)`, path.join(dir, `${name}.slim`), options), error => !/"terrain" is not defined/.test(error.message))
    }
    writeFileSync(host, `global terrain: int\n`)
    transform(`log(terrain)`, path.join(dir, "c.slim"), options)
})

test("k in rec and the keys of a const Record literal narrow away undefined", () => {
    accepted(`func f(rec: Record<string, int>, name: string) -> int {\n    if (name in rec) return rec[name] + 1\n    if ("x" in rec) return rec.x + rec["x"]\n    return 0\n}`)
    accepted(`func g(rec: Record<string, int>, name: string) -> int {\n    if (!(name in rec)) return 0\n    return rec[name]\n}`)
    rejected(`func h(rec: Record<string, int>, name: string) -> int { return rec[name] }`, /may be undefined|check it for undefined/)
    rejected(`func h(rec: Record<string, int | undefined>, name: string) -> int {\n    if (name in rec) return rec[name]\n    return 0\n}`, /undefined/)
    const table = `struct W { temp: int }\nconst table: Record<string, W> = { sunny: W.new({ temp: 30 }), "rain": W.new({ temp: 10 }) }\n`
    accepted(`${table}const a: int = table.sunny.temp\nconst b: int = table["rain"].temp\nlog(a, b)`)
    rejected(`${table}const c: int = table.snow.temp`, /"table\.snow" may be undefined/)
    rejected(`${table}delete table.sunny\nconst a: int = table.sunny.temp`, /"table\.sunny" may be undefined/)
})

test("markup has the Html type", () => {
    const item = `func item(x: string) { return <a href="#">\${x}</a> }\n`
    rejected(`${item}const n: int = item("a")`, /"n" expects int, got Html/)
    rejected(`${item}const e: Element = item("a")`, /"e" expects Element, got Html/)
    rejected(`const s: string = <b>hi</b>`, /"s" expects string, got Html/)
    accepted(`${item}const h: Html = item("a")\nconst o: object = item("b")\nconst safe: SafeHtml = <i/>\nconst list: Html[] = ["a"].map(item)\nlog(h, o, safe, list)`)
    warned(`${item}const s = item("a") + "x"\nlog(s)`, /"\+" turns markup into a plain string.*raw\.join/)
    warned(`${item}const s = item("a") + item("b")\nlog(s)`, /"\+" turns markup into a plain string/)
    warned(`${item}const j = ["a", "b"].map(item).join("")\nlog(j)`, /"\.join" turns markup into a plain string.*\$\{list\}.*raw\.join\(list, separator\)/)
    const { warnings } = diagnostics(`const n = 1 + 2\nconst j = ["a"].join("")\nlog(n, j)`)
    assert.ok(!warnings.some(message => /markup/.test(message)))
    assert.deepEqual(runSource(`func item(x: string) -> Html { return <a>\${x}</a> }\nlog(String(item("b")))\ntry { const bad: Html = "x" } catch (e) { log("rejected") }`), ["<a>b</a>", "rejected"])
})

test("a function that changes a parameter warns when the argument comes from state", () => {
    const head = `state dialogs = [{ members: 1 }]\nfunc bump(d) { d.members += 1 }\nconst add = (list) => list.push({ members: 0 })\nfunc read(d) { return d.members }\nfunc fresh(d) { d = { members: 2 }\n return d }\n`
    warned(`${head}bump(dialogs[0])\nlog(add, read, fresh)`, /"bump" changes its parameter "d", and "dialogs\[0\]" comes from state "dialogs"/)
    warned(`${head}add(dialogs)\nlog(bump, read, fresh)`, /"add" changes its parameter "list"/)
    const { warnings } = diagnostics(`${head}read(dialogs[0])\nfresh(dialogs[0])\nconst plain = [{ members: 1 }]\nbump(plain[0])\nlog(add)`)
    assert.ok(!warnings.some(message => /changes its parameter/.test(message)), JSON.stringify(warnings))
})

test("the embedded environment hides DOM and Node globals", () => {
    const source = `setTimeout(() => {}, 1)\nlog(document, process, fetch)\nlet e: HTMLElement | null = null\nlog(e)`
    accepted(source)
    const { errors } = diagnostics(source, undefined, { env: "embedded" })
    for (const name of ["setTimeout", "document", "process", "fetch"]) assert.ok(errors.some(message => message.startsWith(`"${name}" is not defined`)), name)
    assert.ok(errors.some(message => /unknown type "HTMLElement"/.test(message)))
    accepted(`log(Math.max(1, 2), JSON.stringify({}), globalThis, console, new Map(), Promise.resolve(1), parseInt("2"))`, { env: "embedded" })
    accepted(`global setTimeout: (f: () => void, ms: int) => int\nsetTimeout(() => {}, 1)`, { env: "embedded" })
})

test("slimconfig env reaches the checker", () => {
    const dir = folder()
    writeFileSync(path.join(dir, "slimconfig.json"), JSON.stringify({ main: "index", env: "embedded" }))
    writeFileSync(path.join(dir, "index.slim"), `setTimeout(() => {}, 1)\n`)
    const result = spawnSync(process.execPath, [path.join(root, "src", "compile.js")], { cwd: dir, encoding: "utf8" })
    assert.notEqual(result.status, 0)
    assert.match(result.stdout + result.stderr, /"setTimeout" is not defined/)
    assert.ok(readFileSync(path.join(dir, "slimconfig.json"), "utf8").includes("embedded"))
})
