import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__reactivity_extras__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href
const S = "$"

function compile(source, name = "input") {
    return transform(source, path.join(root, "__reactivity_extras__", `${name}.slim`)).code
}

function run(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const code = compile(source, name)
    const file = path.join(outputDir, `${name}.js`)
    writeFileSync(file, code.replace(/^import\s+[^;]*(?:defaults|core)\.js";$/m, `import ${JSON.stringify(runtimeImport)};`))
    const result = spawnSync(process.execPath, ["--no-warnings", file], { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim().split("\n")
}

function failure(source) {
    try {
        compile(source)
    } catch (error) {
        return error.message
    }
    assert.fail("expected a compile error")
}

test("touch updates the rows and states that hold an object changed through an alias", () => {
    const lines = run("touch", `
component Row(props) {
    return <li>${S}{props.d.Name}:${S}{props.d.Unread}</li>
}
component List() {
    state dialogs = [{ ID: 1, Name: "a", Unread: 0 }, { ID: 2, Name: "b", Unread: 0 }]
    function bumpAlias(d) { d.Unread = 5 }
    function bumpInside(d) {
        d.Unread = 7
        touch(d)
    }
    expose({
        alias() { bumpAlias(dialogs[0]) },
        touched() { touch(dialogs[0]) },
        inside() { bumpInside(dialogs[1]) },
        copy() { bumpAlias(dialogs[1]); dialogs = [...dialogs] }
    })
    return <div>
        <b>${S}{dialogs[0].Unread}</b>
        <ul>${S}{dialogs.map(d => <Row key=${S}{d.ID} d=${S}{d} />)}</ul>
        <ol>${S}{dialogs.map(d => <li key=${S}{d.ID}>${S}{d.Unread}</li>)}</ol>
    </div>
}
const el = List()
const first = el.querySelector("ol li")
el.alias()
log(el.querySelector("b").textContent, el.querySelector("ul").textContent, el.querySelector("ol").textContent)
el.touched()
log(el.querySelector("b").textContent, el.querySelector("ul").textContent, el.querySelector("ol").textContent, el.querySelector("ol li") === first)
el.inside()
log(el.querySelector("ul").textContent, el.querySelector("ol").textContent)
el.copy()
log(el.querySelector("ol").textContent)

const shared = { n: 1 }
component Badge() {
    state current = shared
    return <i>${S}{current.n}</i>
}
const badge = Badge()
shared.n = 2
log(touch(shared) === shared, badge.textContent, touch(null), touch(3))
`)
    assert.deepEqual(lines, [
        "0 a:0b:0 00",
        "5 a:5b:0 50 true",
        "a:5b:7 57",
        "57",
        "true 2 null 3"
    ])
})

test("touch reaches lists whose source is not a state and skips disposed ones", () => {
    const lines = run("touch-lists", `
const items = [{ id: 1, n: 0 }]
component Inner({ rows }) {
    return <ul>${S}{rows.map(row => <li key=${S}{row.id}>${S}{row.n}</li>)}</ul>
}
component Outer() {
    state open = true
    expose({ close() { open = false } })
    return <div>${S}{open ? <Inner rows=${S}{items} /> : null}</div>
}
const el = Outer()
items[0].n = 4
touch(items[0])
log(el.textContent)
el.close()
items[0].n = 5
touch(items[0])
log(JSON.stringify(el.textContent))
`)
    assert.deepEqual(lines, ["4", '""'])
})

test("state with equals skips updates the comparison calls equal", () => {
    const lines = run("state-equals", `
const sameSet = (a: string[], b: string[]) => a.length == b.length && a.every(x => b.includes(x))
state total: int = 0 with equals((a, b) => Math.abs(a - b) < 10)
const runs = []
func useNear() {
    state near = { at: 1 } with equals((a, b) => a.at == b.at)
    return { get value() { return near }, set(next) { near = next } }
}
component Speakers() {
    state speakers: string[] = [] with equals(sameSet)
    const near = useNear()
    effect(() => { runs.push(speakers.join(",")) })
    expose({ set(list) { speakers = list }, move(at) { near.set({ at }) } })
    return <p>${S}{total}:${S}{near.value.at}</p>
}
const el = Speakers()
el.set(["a", "b"])
el.set(["b", "a"])
el.set(["c"])
total = 5
log(runs.join("|"), el.textContent)
total = 12
el.move(1)
log(el.textContent)
el.move(2)
log(el.textContent)
`)
    assert.deepEqual(lines, ["|a,b|c 0:1", "12:1", "12:2"])
})

test("state with equals keeps the type check and reports a wrong clause", () => {
    assert.match(compile(`component C() {\n    state n: int = 1 with equals((a, b) => a == b)\n    return <b>${S}{n}</b>\n}`), /__signal__\((?:__typed_variable__\(1, .*\)|1), \(a, b\) => a == b\)/)
    assert.match(failure(`component C() {\n    state n: int = "x" with equals((a, b) => a == b)\n    return <b>${S}{n}</b>\n}`), /int/)
    assert.match(failure(`component C() {\n    state n = 1 with same(1)\n    return <b>${S}{n}</b>\n}`), /Expected "equals\(\.\.\.\)" after "with"/)
    assert.match(failure(`component C() {\n    state n = 1 with equals((a, b) => a == missing)\n    return <b>${S}{n}</b>\n}`), /"missing" is not defined/)
})

test("raw html with the same string keeps its nodes", () => {
    const lines = run("same-html", `
component Msg() {
    state m = { text: "<b>hi</b>", read: false }
    expose({
        read() { m = { ...m, read: true } },
        readInPlace() { m.read = false },
        change() { m = { ...m, text: "<b>bye</b>" } }
    })
    return <div><span>${S}{raw(m.text)}${S}{[raw("<u>x</u>"), raw("<u>x</u>")]}</span><i>${S}{m.read ? "r" : "u"}</i></div>
}
const el = Msg()
const b = el.querySelector("b")
const [u1, u2] = el.querySelectorAll("u")
el.read()
log(el.querySelector("b") === b, el.querySelectorAll("u").length, el.querySelectorAll("u")[0] === u1, el.querySelectorAll("u")[1] === u2, el.querySelector("i").textContent)
el.readInPlace()
log(el.querySelector("b") === b)
el.change()
log(el.querySelector("b") === b, el.querySelector("span").innerHTML)
`)
    assert.deepEqual(lines, ["true 2 true true r", "true", "false <b>bye</b><u>x</u><u>x</u>"])
})

test("raw with fresh builds its nodes again each time the binding runs", () => {
    const lines = run("fresh-html", `
component Toast() {
    state shown = 0
    expose({ again() { shown++ } })
    return <div>${S}{shown >= 0 ? raw("<b class='pop'>saved</b>", { fresh: true }) : null}<i>${S}{shown}</i></div>
}
const el = Toast()
const first = el.querySelector("b")
el.again()
const second = el.querySelector("b")
log(first === second, first.isConnected, el.querySelectorAll("b").length, el.querySelector("i").textContent)
`)
    assert.deepEqual(lines, ["false false 1 1"])
})

test("a binding in a list row runs again only when the item fields it reads change", () => {
    const lines = run("row-fields", `
let made = 0
const parse = (s: string) => raw("<em id='e" + (++made) + "'>" + s + "</em>")
let titles = 0
const title = (s: string) => { titles++; return s.toUpperCase() }
component List() {
    state people = []
    expose({
        set(list) { people = list },
        rename() { people[0].name = "Cy" },
        tag() { people[0].tags.push("x") }
    })
    return <ul>${S}{people.map(p => <li key=${S}{p.id} title=${S}{title(p.name)}>${S}{parse(p.name)}<i>${S}{p.off ? "off" : "on"}</i><b>${S}{p.tags.join(",")}</b></li>)}</ul>
}
const el = List()
el.set([{ id: 1, name: "Ann", off: false, tags: [] }])
const em = el.querySelector("em")
el.set([{ id: 1, name: "Ann", off: true, tags: [] }])
log(el.querySelector("em") === em, titles, el.innerHTML)
el.set([{ id: 1, name: "Bob", off: true, tags: [] }])
log(el.querySelector("em") === em, titles, el.querySelector("li").title, el.querySelector("em").textContent)
el.rename()
log(titles, el.querySelector("em").textContent)
el.tag()
log(el.querySelector("b").textContent)
`)
    assert.deepEqual(lines, [
        'true 1 <li title="ANN"><em id="e1">Ann</em><i>off</i><b></b></li>',
        "false 2 BOB Bob",
        "3 Cy",
        "x"
    ])
})

test("item field reads are hoisted only from bindings that call something", () => {
    const code = compile(`const fmt = (x, y) => x + y\ncomponent C() {\n    state rows = [{ id: 1, a: { b: "x" } }]\n    return <ul>${S}{rows.map(row => <li key=${S}{row.id} class=${S}{row.a.b}>${S}{row.a.b}${S}{fmt(row.a.b, row.a["b"])}${S}{row.a.b.trim()}</li>)}</ul>\n}`)
    assert.match(code, /__field__\(\(\) => row\.v\.a\.b\)/)
    assert.match(code, /__field__\(\(\) => row\.v\.a\["b"\]\)/)
    assert.equal(code.match(/__field__\(\(\) => row\.v\.a\.b\)/g).length, 1)
    assert.match(code, /__attr__\(__r__, "class", \(\) => row\.v\.a\.b\)/)
    assert.match(code, /\.v\.trim\(\)/)
})

test("a kept list keeps rows that leave and reuses them when their key comes back", () => {
    const lines = run("keep-rows", `
const log2 = []
component Item({ item }) {
    onCleanup(() => log2.push("gone " + item.id))
    return <span>${S}{item.name}</span>
}
component List() {
    state items = []
    state limited = []
    expose({ set(list) { items = list }, limit(list) { limited = list } })
    return <div>
        <ul>${S}{items.map((item, i) => <li key=${S}{item.id} keep>${S}{i}:<Item item=${S}{item} /></li>)}</ul>
        <ol>${S}{limited.map(item => <li key=${S}{item.id} keep=${S}{1}>${S}{item.id}</li>)}</ol>
    </div>
}
const el = List()
el.set([{ id: 1, name: "a" }, { id: 2, name: "b" }])
const second = el.querySelectorAll("ul li")[1]
el.set([{ id: 1, name: "a" }])
log(el.querySelector("ul").textContent, log2.join(","))
el.set([])
el.set([{ id: 2, name: "B" }, { id: 1, name: "a" }])
log(el.querySelector("ul li") === second, el.querySelector("ul").textContent, log2.join(","))
el.limit([{ id: 1 }, { id: 2 }, { id: 3 }])
const one = el.querySelector("ol li")
el.limit([])
el.limit([{ id: 3 }, { id: 1 }])
log(el.querySelector("ol").textContent, el.querySelectorAll("ol li")[1] === one)
`)
    assert.deepEqual(lines, ["0:a ", "true 0:B1:a ", "31 false"])
})

test("a portal can prepend, go before or after a node, and follow a changing target", () => {
    const lines = run("portal-position", `
let api = null
const page = htmlToVdom("<main><header></header><section><p>old</p></section></main>").toElement()
const header = page.querySelector("header")
const section = page.querySelector("section")
component App() {
    state to = section
    state position = "prepend"
    api = { to: (next) => { to = next }, at: (next) => { position = next } }
    return <div>
        <Portal to=${S}{to} position=${S}{position}><i>a</i><b>b</b></Portal>
        <Portal to=${S}{header} position="after"><u>after</u></Portal>
        <Portal to=${S}{header} position="before"><s>before</s></Portal>
    </div>
}
const el = App()
log(page.innerHTML)
api.at("append")
log(section.innerHTML)
api.to(header)
log(page.innerHTML)
`)
    assert.deepEqual(lines, [
        "<s>before</s><header></header><u>after</u><section><i>a</i><b>b</b><p>old</p></section>",
        "<p>old</p><i>a</i><b>b</b>",
        "<s>before</s><header><i>a</i><b>b</b></header><u>after</u><section><p>old</p></section>"
    ])
})

test("resource.pages loads more pages and drops pages for a query that changed", () => {
    const lines = run("resource-pages", `
let api = null
const wait = (ms, value) => new Promise(resolve => setTimeout(() => resolve(value), ms))
const load = (query, page = 0) => wait(query == "slow" ? 60 : 10, {
    items: [query + page * 2, query + (page * 2 + 1)],
    next: page < 2 ? page + 1 : null
})
component Feed() {
    state query = "a"
    const feed = resource.pages(() => query, load)
    api = { more: () => feed.more(), search: (next) => { query = next }, feed }
    return <p>${S}{feed.items.join(",")}${S}{feed.loading ? "…" : ""}${S}{feed.done ? "." : ""}</p>
}
const el = Feed()
const steps = [el.textContent]
setTimeout(async () => {
    steps.push(el.textContent)
    const asked = api.more()
    log(await api.more())
    log(await asked)
    steps.push(el.textContent)
    await api.more()
    steps.push(el.textContent)
    log(await api.more())
    api.search("slow")
    api.search("b")
    setTimeout(() => {
        steps.push(el.textContent)
        const late = api.more()
        api.search("c")
        setTimeout(async () => {
            log(await late)
            steps.push(el.textContent, String(api.feed.pages.length))
            log(steps.join(" | "))
        }, 100)
    }, 100)
}, 30)
`)
    assert.deepEqual(lines, [
        "false",
        "true",
        "false",
        "false",
        "… | a0,a1 | a0,a1,a2,a3 | a0,a1,a2,a3,a4,a5. | b0,b1 | c0,c1 | 1"
    ])
})
