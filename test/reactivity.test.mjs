import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { preprocess } from "../src/syntax/index.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__reactivity_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href
const ROUTER = `use { Router, Link, navigate, route, matchRoute } from ${JSON.stringify(pathToFileURL(path.join(root, "src", "external", "router.js")).href)}\n`
const FORMS = `use { createForm } from ${JSON.stringify(pathToFileURL(path.join(root, "src", "external", "runtime-core.js")).href)}\n`
const S = "$"

function compile(source, name = "input") {
    return transform(source, path.join(root, "__reactivity_tests__", `${name}.slim`)).code
}

const CLICK = `
const click = (el, selector) => {
    const event = el.ownerDocument.createEvent("Event")
    event.initEvent("click", true, true)
    const target = selector ? el.querySelector(selector) : el
    target.dispatchEvent(event)
}
`

function run(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const code = compile(CLICK + source, name)
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

test("a state updates the text that shows it, and only that", () => {
    const lines = run("counter", `
component Counter() {
    state count = 0
    const double = count * 2
    return <div>
        <button class="inc" onClick=${S}{() => count++}>${S}{count}</button>
        <span>${S}{double}</span>
        <p>static</p>
    </div>
}
const el = Counter()
const p = el.querySelector("p")
const span = el.querySelector("span").firstChild
click(el, ".inc")
click(el, ".inc")
log(el.querySelector(".inc").textContent, el.querySelector("span").textContent)
log(el.querySelector("p") === p, el.querySelector("span").firstChild === span)
`)
    assert.deepEqual(lines, ["2 4", "true true"])
})

test("a handler is one batch and an effect follows what it read", () => {
    const lines = run("batch", `
let runs = []
component Pair() {
    state a = 1
    state b = 1
    effect(() => { runs.push(a + b) })
    return <button onClick=${S}{() => { a = 10; b = 20 }}>${S}{a + b}</button>
}
const el = Pair()
click(el)
log(runs.join(","), el.textContent)
`)
    assert.deepEqual(lines, ["2,30 30"])
})

test("methods that change a state notify what reads it", () => {
    const lines = run("mutation", `
struct User {
    name: string
}
let api = null
component Team() {
    state users: User[] = [User.new({ name: "a" })]
    state lead: User = User.new({ name: "x" })
    api = {
        add: () => users.push(User.new({ name: "b" })),
        rename: () => { lead.name = "y" },
        sort: () => users.sort((p, q) => q.name.localeCompare(p.name))
    }
    return <p>${S}{lead.name}: ${S}{users.map(u => u.name).join(",")}</p>
}
const el = Team()
api.add()
api.rename()
log(el.textContent)
api.sort()
log(el.textContent)
`)
    assert.deepEqual(lines, ["y: a,b", "y: b,a"])
})

test("a keyed list keeps rows, moves them, and updates what changed inside", () => {
    const lines = run("list", `
struct Todo {
    id: int
    title: string
    done: bool = false
}
let api = null
component Todos() {
    state todos: Todo[] = [1, 2, 3].map(id => Todo.new({ id, title: "t" + id }))
    api = {
        toggle: (i) => { todos[i].done = true },
        reverse: () => todos.reverse(),
        drop: () => todos.shift(),
        add: () => todos.push(Todo.new({ id: 9, title: "t9" })),
        clear: () => { todos = [] }
    }
    return <ul>${S}{todos.map((todo, i) => <li key=${S}{todo.id} class=${S}{todo.done ? "done" : "open"}>${S}{i}:${S}{todo.title}</li>)}</ul>
}
const el = Todos()
const rows = () => [...el.querySelectorAll("li")]
const first = rows()[0]
api.toggle(0)
log(rows().map(li => li.className).join(","))
api.reverse()
log(rows().map(li => li.textContent).join(","), rows()[2] === first)
api.drop()
api.add()
log(rows().map(li => li.textContent).join(","))
api.clear()
log(el.outerHTML)
`)
    assert.deepEqual(lines, [
        "done,open,open",
        "0:t3,1:t2,2:t1 true",
        "0:t2,1:t1,2:t9",
        "<ul></ul>"
    ])
})

test("a branch is built when the condition flips, and its effects stop with it", () => {
    const lines = run("branch", `
let events = []
let api = null
component Timer({ label }) {
    effect(() => {
        events.push("start")
        return () => events.push("stop")
    })
    return <i>${S}{label}</i>
}
component Panel() {
    state open = true
    state n = 1
    api = { toggle: () => { open = !open }, bump: () => { n++ } }
    return <div>${S}{open ? Timer({ label: "n" + n }) : <em>closed</em>}${S}{n > 1 && <b>big</b>}</div>
}
const el = Panel()
const timer = el.querySelector("i")
api.bump()
log(el.innerHTML, el.querySelector("i") === timer)
api.toggle()
log(el.innerHTML, events.join(","))
`)
    assert.deepEqual(lines, [
        "<i>n2</i><b>big</b> true",
        "<em>closed</em><b>big</b> start,stop"
    ])
})

test("props passed from a state stay live, defaults are made once", () => {
    const lines = run("props", `
let made = 0
let api = null
const fresh = () => { made++; return [] }
component Badge({ count, tags = fresh() }) {
    tags.push(count)
    return <span title="n${S}{count}">${S}{count}</span>
}
component Shop() {
    state items = 1
    api = { add: () => { items++ } }
    return <div>${S}{Badge({ count: items })}</div>
}
const el = Shop()
const badge = el.querySelector("span")
api.add()
api.add()
log(el.innerHTML, el.querySelector("span") === badge, made)
`)
    assert.deepEqual(lines, ['<span title="n3">3</span> true 1'])
})

test("attributes, properties and spreads follow their values", () => {
    const lines = run("attributes", `
let api = null
component Form() {
    state name = "a"
    state off = false
    state extra = "data-x=\\"1\\""
    api = { set: () => { name = "b"; off = true; extra = "" } }
    return <form class="f ${S}{name}" data-off=${S}{off}>
        <input value=${S}{name} disabled=${S}{off} ${S}{extra}>
    </form>
}
const el = Form()
const input = el.querySelector("input")
log(el.className, el.getAttribute("data-off"), input.value, input.hasAttribute("disabled"), input.getAttribute("data-x"))
api.set()
log(el.className, el.getAttribute("data-off"), input.value, input.hasAttribute("disabled"), input.hasAttribute("data-x"))
`)
    assert.deepEqual(lines, ["f a false a false 1", "f b true b true false"])
})

test("svg markup is built in the svg namespace, also when it comes from a hole", () => {
    const lines = run("svg", `
component Chart({ points }) {
    return <svg viewBox="0 0 10 10">${S}{points.map(p => <circle r=${S}{p}></circle>)}</svg>
}
const el = Chart({ points: [1, 2] })
log(el.namespaceURI, [...el.querySelectorAll("circle")].map(c => c.namespaceURI === el.namespaceURI).join(","))
`)
    assert.deepEqual(lines, ["http://www.w3.org/2000/svg true,true"])
})

test("watch only reacts to its source, untrack reads without subscribing", () => {
    const lines = run("watch", `
let seen = []
let api = null
component W() {
    state a = 1
    state b = 1
    watch(() => a, (next, previous) => { seen.push(previous + ">" + next + "/" + b) })
    api = { a: () => { a++ }, b: () => { b++ } }
    return <p>${S}{a + untrack(() => b)}</p>
}
const el = W()
api.b()
api.a()
log(seen.join(","), el.textContent)
`)
    assert.deepEqual(lines, ["undefined>1/1,1>2/2 4"])
})

test("a component compiles to a cloned template, without parsing HTML at runtime", () => {
    const code = compile(`component Card({ title }) {\n    return <div class="card"><h2>${S}{title}</h2></div>\n}`)
    assert.match(code, /const __tpl1__ = __template__\(\[\["div", \{\s*"class": "card"\s*\}, \["h2", 0, ""\]\]\]\)/)
    assert.match(code, /__insert__\(__n\d+__, \(\) => __props__\.title\)/)
    assert.doesNotMatch(code, /htmlToVdom|__html__/)
})

test("state is checked like a typed let and only lives in components", () => {
    assert.match(failure(`component C() {\n    state count: int = 0\n    count = "x"\n    return <b>${S}{count}</b>\n}`),
        /"count" expects int, got string/)
    assert.match(failure(`func f() {\n    state x = 1\n}`), /state can only be declared at the top of a component body/)
    assert.match(failure(`component C() {\n    state x\n    return <b></b>\n}`), /A state needs a name and a starting value/)
    assert.match(failure(`isolated component C() {\n    state x = 1\n    return <b></b>\n}`), /An isolated component can't have state/)
    assert.match(failure(`component C({ label }) {\n    label = "x"\n    return <b>${S}{label}</b>\n}`), /"label" is a prop and can't be assigned/)
    compile(`component C() {\n    const state = 1\n    log(state)\n    return <b></b>\n}`)
})

test("a state at the top of a module is shared with the modules that use it", () => {
    const dir = path.join(outputDir, "store")
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "slimconfig.json"), JSON.stringify({ main: "index" }))
    writeFileSync(path.join(dir, "store.slim"), [
        "export state count: int = 0",
        "state items: string[] = []",
        "export const total = items.length + count",
        "export { items }",
        "export func bump() { count++ }"
    ].join("\n"))
    writeFileSync(path.join(dir, "index.slim"), [
        `use { count, items, total, bump } from "./store"`,
        "component View() {",
        `    return <p>${S}{count} / ${S}{total} / ${S}{items.join(",")}</p>`,
        "}",
        "const el = View()",
        "bump()",
        `items.push("a")`,
        "count = count + 10",
        "log(el.textContent)"
    ].join("\n"))

    const build = spawnSync(process.execPath, [path.join(root, "src", "compile.js")], { cwd: dir, encoding: "utf8", env: { ...process.env, SLIM_FORCE: "1" } })
    assert.equal(build.status, 0, build.stderr)
    const result = spawnSync(process.execPath, [path.join(dir, "slim-dist", "index.js")], { cwd: dir, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "11 / 12 / a")
})

test("bind:value and bind:checked keep a field and an input in sync", () => {
    const lines = run("bind", `
struct Profile {
    name: string
    admin: bool = false
}
let api = null
component Form() {
    state profile: Profile = Profile.new({ name: "Ann" })
    api = { rename: () => { profile.name = "Eve" } }
    return <form>
        <input class="name" bind:value=${S}{profile.name}>
        <input class="admin" type="checkbox" bind:checked=${S}{profile.admin}>
        <p>${S}{profile.name} ${S}{String(profile.admin)}</p>
    </form>
}
const el = Form()
const fire = (selector, type, set) => {
    const input = el.querySelector(selector)
    set(input)
    const event = el.ownerDocument.createEvent("Event")
    event.initEvent(type, true, true)
    input.dispatchEvent(event)
}
fire(".name", "input", input => { input.value = "Bob" })
fire(".admin", "change", input => { input.checked = true })
log(el.querySelector("p").textContent)
api.rename()
log(el.querySelector(".name").value)
`)
    assert.deepEqual(lines, ["Bob true", "Eve"])
    assert.match(failure(`component C() {\n    return <input bind:value=${S}{1 + 2}>\n}`), /bind:value needs something it can assign to/)
})

test("resource loads again when what it read changes, and a stale answer is dropped", () => {
    const lines = run("resource", `
let api = null
const wait = (ms, value) => new Promise((resolve, reject) => setTimeout(() => value instanceof Error ? reject(value) : resolve(value), ms))
component User() {
    state id = 1
    const user = resource(() => wait(id == 2 ? 60 : 10, id == 3 ? new Error("gone") : "user " + id))
    api = { open: (next) => { id = next } }
    return <p>${S}{user.loading ? "loading" : user.error ? user.error.message : user.value}</p>
}
const el = User()
const steps = [el.textContent]
setTimeout(() => { steps.push(el.textContent); api.open(2); api.open(4) }, 30)
setTimeout(() => { steps.push(el.textContent); api.open(3) }, 120)
setTimeout(() => { steps.push(el.textContent); log(steps.join(" | ")) }, 200)
`)
    assert.deepEqual(lines, ["loading | user 1 | user 4 | gone"])
})

test("a selection in a list only runs the rows whose answer changed", () => {
    const lines = run("selection", `
let api = null
let runs = 0
component Rows() {
    state rows = [1, 2, 3, 4].map(id => ({ id }))
    state selected = 0
    api = { pick: (id) => { selected = id } }
    return <ul>${S}{rows.map(row => <li class=${S}{selected == row.id ? "on" : (runs++, "")}>${S}{row.id}</li>)}</ul>
}
const el = Rows()
const before = runs
api.pick(2)
api.pick(3)
log([...el.querySelectorAll("li")].map(li => li.className || "-").join(","), runs - before)
`)
    assert.deepEqual(lines, ["-,-,on,- 1"])
})

test("rows that are components are kept by item", () => {
    const lines = run("component-rows", `
let api = null
component Item({ name }) {
    return <li>${S}{name}</li>
}
component List() {
    state names = ["a", "b"]
    api = { add: () => names.push("c") }
    return <ul>${S}{names.map(name => Item({ name }))}</ul>
}
const el = List()
const first = el.querySelector("li")
api.add()
log(el.textContent, el.querySelector("li") === first)
`)
    assert.deepEqual(lines, ["abc true"])
})

test("hydrate takes over what renderToString rendered, keeping its nodes", () => {
    const lines = run("hydrate", `
component Item({ name }) {
    return <li><b>${S}{name}</b>!</li>
}
component App({ title, items }) {
    state count = 0
    state list = items
    return <main>
        <h1>Hi ${S}{title}, ${S}{count}</h1>
        <button onClick=${S}{() => { count++; list.push("z") }}>add</button>
        ${S}{count > 0 ? <p>clicked</p> : <p>idle</p>}
        <ul>${S}{list.map(item => Item({ name: item }))}</ul>
    </main>
}
const props = { title: "Ann", items: ["a", "b"] }
const html = renderToString(() => App(props))
log(html.includes("<!--[-->Ann<!--]-->"))
const container = htmlToVdom("<div></div>").toElement()
container.innerHTML = html
const h1 = container.querySelector("h1")
const li = container.querySelector("li")
hydrate(() => App(props), container)
log(container.querySelector("h1") === h1, container.querySelector("li") === li, container.querySelectorAll("li").length)
click(container, "button")
log(container.querySelector("h1").textContent, container.querySelector("p").textContent, container.querySelector("ul").textContent)
`)
    assert.deepEqual(lines, ["true", "true true 2", "Hi Ann, 1 clicked a!b!z!"])
})

test("calls check props, and markup names get a did-you-mean", () => {
    const badge = `component Badge({ count: int, label?: string, tone = "x" }) {\n    return <span>${S}{count}</span>\n}\n`
    compile(`${badge}Badge({ count: 1, tone: "y" })`)
    assert.match(failure(`${badge}Badge({ cont: 1 })`), /"Badge" has no prop "cont" — did you mean "count"\?/)
    assert.match(failure(`${badge}Badge({ count: "1" })`), /prop "count" of "Badge" expects int, got string/)
    assert.match(failure(`${badge}Badge({ label: "a" })`), /"Badge" is missing prop "count" of type int/)
    assert.match(failure(`component C() {\n    return <button onClik=${S}{() => 1}>x</button>\n}`), /unknown event "onClik" — did you mean "onClick"\?/)
    assert.match(failure(`component C() {\n    return <a herf="/">x</a>\n}`), /unknown attribute "herf" on <a> — did you mean "href"\?/)
    compile(`component C() {\n    return <div data-id="1" onMyEvent=${S}{() => 1} my-thing="x"><svg viewBox="0 0 1 1"></svg></div>\n}`)
})

test("components can be written as tags, with children", () => {
    const lines = run("tags", `
component Card({ title, children }) {
    return <section>
        <h2>${S}{title}</h2>
        ${S}{children}
    </section>
}
component Row({ item }) {
    return <li>${S}{item.name}</li>
}
let api = null
component Page() {
    state n = 1
    state items = [{ id: 1, name: "a" }, { id: 2, name: "b" }]
    api = { bump: () => { n++ }, add: () => items.push({ id: 3, name: "c" }) }
    return <main>
        <Card title="Count ${S}{n}">
            <p>n is ${S}{n}</p>
        </Card>
        <ul>${S}{items.map(item => <Row key=${S}{item.id} item=${S}{item} />)}</ul>
    </main>
}
const el = Page()
const p = el.querySelector("p")
const li = el.querySelector("li")
api.bump()
api.add()
log(el.outerHTML)
log(el.querySelector("p") === p, el.querySelector("li") === li)
`)
    assert.deepEqual(lines, [
        "<main><section><h2>Count 2</h2><p>n is 2</p></section><ul><li>a</li><li>b</li><li>c</li></ul></main>",
        "true true"
    ])
})

test("text in markup follows JSX: line breaks between tags go, a line of text keeps its spaces", () => {
    const lines = run("whitespace", `
component C() {
    return <div>
        <b>a</b> <i>b</i>
        two
        lines
        <pre>  keep
  this</pre>
    </div>
}
log(JSON.stringify(C().innerHTML))
`)
    assert.deepEqual(lines, [JSON.stringify("<b>a</b> <i>b</i>two lines<pre>  keep\n  this</pre>")])
})

test("context reaches what a component renders and follows a provided state", () => {
    const lines = run("context", `
const Theme = createContext("light")
let api = null
component Label() {
    const theme = inject(Theme)
    return <span class=${S}{theme}>${S}{theme}</span>
}
component App() {
    state theme = "dark"
    provide(Theme, theme)
    api = { light: () => { theme = "light" } }
    return <div><Label /></div>
}
log(Label().textContent)
const el = App()
const span = el.querySelector("span")
api.light()
log(el.innerHTML, el.querySelector("span") === span)
`)
    assert.deepEqual(lines, ["light", '<span class="light">light</span> true'])
})

test("catchError shows a fallback for errors while building and in later updates", () => {
    const lines = run("errors", `
let api = null
component Risky({ fail = true }) {
    if (fail) throw new Error("boom")
    return <b>fine</b>
}
component Later() {
    state broken = false
    api = { breakIt: () => { broken = true } }
    return <i>${S}{broken ? JSON.parse("{") : "ok"}</i>
}
component App() {
    return <div>
        ${S}{catchError(() => Risky(), error => <em>${S}{error.message}</em>)}
        ${S}{catchError(() => Later(), error => <em>later</em>)}
    </div>
}
const el = App()
log(el.innerHTML)
api.breakIt()
log(el.innerHTML)
`)
    assert.deepEqual(lines, ["<em>boom</em><i>ok</i>", "<em>boom</em><em>later</em>"])
})

test("enter and leave put classes on for animations", () => {
    const lines = run("animations", `
let api = null
component C() {
    state shown = true
    api = { hide: () => { shown = false } }
    return <div>${S}{shown && <p enter="fade-in" leave="fade-out">x</p>}</div>
}
const el = C()
log(JSON.stringify(el.innerHTML))
api.hide()
log(JSON.stringify(el.innerHTML))
`)
    assert.deepEqual(lines, [JSON.stringify('<p class="fade-in">x</p>'), JSON.stringify("")])
})

test("event handlers know their event, a change through a copy of a state is an error", () => {
    assert.match(failure(`component C() {\n    state age: int = 0\n    return <input onInput=${S}{e => { age = e.target.value }}>\n}`),
        /"age" expects int, got string/)
    compile(`component C() {\n    state name = ""\n    return <input onInput=${S}{e => { name = e.target.value; e.preventDefault(); log(e.key, e.detail) }}>\n}`)
    assert.match(failure(`component C() {\n    state items = [1]\n    const add = () => {\n        const list = items\n        list.push(2)\n    }\n    return <b>${S}{items.length}</b>\n}`),
        /"list" holds the state "items": a change through "list" doesn't update the page/)
    assert.match(failure(`component C() {\n    state items = [1]\n    const sorted = items.slice()\n    const f = () => sorted.sort((a, b) => a - b)\n    return <b>${S}{sorted.length}</b>\n}`),
        /"sorted" is recomputed from a state or props/)
})

test("hydration leaves the server's nodes in place", () => {
    const lines = run("hydrate-in-place", `
component Pair({ n }) {
    return
        <i>${S}{n}</i>
        <i>two</i>
}
component App() {
    state n = 1
    return <div><button onClick=${S}{() => { n++ }}>+</button>${S}{Pair({ n })}<input></div>
}
const container = htmlToVdom("<div></div>").toElement()
container.innerHTML = renderToString(() => App())
const input = container.querySelector("input")
const first = container.querySelector("i")
hydrate(() => App(), container)
click(container, "button")
log(container.querySelector("input") === input, container.querySelector("i") === first, container.textContent)
log(container.innerHTML.includes("<!--[-->"))
`)
    assert.deepEqual(lines, ["true true +2two", "false"])
})

test("props are checked when the component comes from another module", () => {
    const dir = path.join(outputDir, "cross-props")
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "slimconfig.json"), JSON.stringify({ main: "index" }))
    writeFileSync(path.join(dir, "badge.slim"), `export component Badge({ count: int }) {\n    return <b>${S}{count}</b>\n}\n`)
    writeFileSync(path.join(dir, "index.slim"), `use { Badge } from "./badge"\nlog(Badge({ cont: 1 }))\n`)
    const build = spawnSync(process.execPath, [path.join(root, "src", "compile.js")], { cwd: dir, encoding: "utf8", env: { ...process.env, SLIM_FORCE: "1" } })
    assert.match(build.stderr, /"Badge" has no prop "cont" — did you mean "count"\?/)
})

test("a form from a struct checks each field and submits a struct", () => {
    const lines = run("forms", `${FORMS}
type email(value: string) { return value.includes("@") }
type positive(value) { return typeof value == "number" && value > 0 }
struct Signup {
    name: string
    email: email
    age: positive
    nick?: string
}
let saved = null
component SignupForm() {
    const form = createForm(Signup, { messages: { age: "Age must be above zero" } })
    return <form onSubmit=${S}{form.submit(data => { saved = data })}>
        <input class="name" bind:value=${S}{form.name}>
        <input class="email" bind:value=${S}{form.email}>
        <p class="email-error">${S}{form.errors.email}</p>
        <input class="age" bind:value=${S}{form.age}>
        <p class="age-error">${S}{form.errors.age}</p>
        <button disabled=${S}{!form.valid}>Sign up</button>
    </form>
}
const el = SignupForm()
const fire = (selector, type, value) => {
    const node = selector == "form" ? el : el.querySelector(selector)
    if (value !== undefined) node.value = value
    const event = el.ownerDocument.createEvent("Event")
    event.initEvent(type, true, true)
    node.dispatchEvent(event)
}
log(JSON.stringify(el.querySelector(".email-error").textContent), el.querySelector("button").hasAttribute("disabled"))
fire(".email", "input", "ann")
fire(".age", "input", "0")
log(el.querySelector(".email-error").textContent, "|", el.querySelector(".age-error").textContent)
fire("form", "submit")
log(saved)
fire(".name", "input", "Ann")
fire(".email", "input", "ann@x.io")
fire(".age", "input", "30")
fire("form", "submit")
log(JSON.stringify(saved), el.querySelector("button").hasAttribute("disabled"))
`)
    assert.deepEqual(lines, [
        '"" true',
        "expected email | Age must be above zero",
        "null",
        '{"name":"Ann","email":"ann@x.io","age":30} false'
    ])
    const S2 = `${FORMS}struct Signup {\n    name: string\n}\ncomponent C() {\n    const form = createForm(Signup)\n`
    assert.match(failure(`${S2}    return <input bind:value=${S}{form.nmae}>\n}`), /"form of Signup" has no field "nmae" — did you mean "name"\?/)
    assert.match(failure(`${S2}    log(form.errors.nam)\n    return <b></b>\n}`), /"errors of Signup" has no field "nam"/)
})

test("renderToStringAsync waits for resources and hydrate starts from their data", () => {
    const lines = run("async-ssr", `
let calls = 0
const load = (id) => { calls++; return new Promise(resolve => setTimeout(() => resolve({ name: "user " + id, friend: id + 1 }), 5)) }
component Friend({ id }) {
    const friend = resource(() => id, id => load(id))
    return <i>${S}{friend.loading ? "…" : friend.value.name}</i>
}
component Profile({ id }) {
    const user = resource(() => id, id => load(id))
    return <section>
        ${S}{user.loading ? <p>Loading</p> : <h2>${S}{user.value.name}</h2>}
        ${S}{user.loading ? null : Friend({ id: user.value.friend })}
    </section>
}
const rendered = await renderToStringAsync(() => Profile({ id: 1 }))
log(rendered.html.replace(/<!--[^>]*-->/g, ""), calls)
log(rendered.script.startsWith("<script>window.__slimData = JSON.parse("))
const container = htmlToVdom("<div></div>").toElement()
container.innerHTML = rendered.html
const h2 = container.querySelector("h2")
calls = 0
hydrate(() => Profile({ id: 1 }), container, rendered.data)
log(container.querySelector("h2") === h2, container.textContent, calls)
`)
    assert.deepEqual(lines, [
        "<section><h2>user 1</h2><i>user 2</i></section> 2",
        "true",
        "true user 1user 2 0"
    ])
})

test("provideData hands server values to hydrate and keeps concurrent renders apart", () => {
    const lines = run("provide-data", `
let computed = 0
component Page({ who }) {
    const user = resource(() => who, who => new Promise(resolve => setTimeout(() => resolve(who), 5)))
    const stamp = provideData("stamp", () => { computed++; return who + "-stamp" })
    return <p>${S}{user.loading ? "…" : user.value}:${S}{stamp}</p>
}
const [a, b] = await Promise.all([
    renderToStringAsync(() => Page({ who: "a" })),
    renderToStringAsync(() => Page({ who: "b" }))
])
const text = html => html.replace(/<!--[^>]*-->/g, "")
log(text(a.html), text(b.html), computed)
log(JSON.stringify(a.store), a.script.includes("window.__slimStore = JSON.parse(") && a.script.includes("a-stamp"))
const container = htmlToVdom("<div></div>").toElement()
container.innerHTML = a.html
computed = 0
hydrate(() => Page({ who: "a" }), container, a.data, a.store)
log(container.textContent, computed, Page.__module__.startsWith("file:"))
`)
    assert.deepEqual(lines, [
        "<p>a:a-stamp</p> <p>b:b-stamp</p> 4",
        '{"stamp":"a-stamp"} true',
        "a:a-stamp 0 true"
    ])
})

test("a row whose component swaps its root can still be reordered and removed", () => {
    const lines = run("fragment-rows", `
let toggles = {}
let setItems
component Item(props) {
    state on = true
    toggles[props.name] = () => on = !on
    return on ? <b>${S}{props.name}</b> : <i>${S}{props.name}</i>
}
component App() {
    state items = ["a", "b", "c"]
    setItems = v => items = v
    return <ul>${S}{items.map(n => <Item name=${S}{n} />)}</ul>
}
const el = App()
toggles.a()
log(el.innerHTML)
setItems(["c", "b", "a"])
log(el.innerHTML)
setItems([])
log(JSON.stringify(el.innerHTML))
`)
    assert.deepEqual(lines, ["<i>a</i><b>b</b><b>c</b>", "<b>c</b><b>b</b><i>a</i>", '""'])
})

test("hiding a branch removes what its child component swapped in", () => {
    const lines = run("fragment-branch", `
let toggle
component Item() {
    state on = true
    toggle = () => on = !on
    return on ? <b>x</b> : <i>x</i>
}
component App() {
    state show = true
    return <div><button onClick=${S}{() => show = !show}>h</button>${S}{show ? <Item /> : null}</div>
}
const el = App()
toggle()
log(el.innerHTML)
click(el, "button")
log(el.innerHTML)
`)
    assert.deepEqual(lines, ["<button>h</button><i>x</i>", "<button>h</button>"])
})

test("a Portal keeps track of content that changes and renders after hydration", () => {
    const lines = run("portal-live", `
let api = null
const host = htmlToVdom("<aside></aside>").toElement()
component App() {
    state open = true
    state step = 1
    api = { close: () => { open = false }, next: () => { step = 2 } }
    return <div>${S}{open && <Portal to=${S}{host}>${S}{step == 1 ? <p>step1</p> : <p>step2</p>}</Portal>}</div>
}
App()
api.next()
log(host.innerHTML)
api.close()
log(JSON.stringify(host.innerHTML))
const other = htmlToVdom("<aside></aside>").toElement()
component Modal() {
    return <div><Portal to=${S}{other}><p>hi</p></Portal><span>x</span></div>
}
const container = htmlToVdom("<div></div>").toElement()
container.innerHTML = renderToString(() => Modal())
hydrate(() => Modal(), container)
log(other.innerHTML)
`)
    assert.deepEqual(lines, ["<p>step2</p>", '""', "<p>hi</p>"])
})

test("server resources keep their own data when another resource appears between passes", () => {
    const lines = run("resource-keys", `
const later = (v) => new Promise(resolve => setTimeout(() => resolve(v), 5))
component Friend() {
    const f = resource(() => later("friend-data"))
    return <i>${S}{f.loading ? "…" : f.value}</i>
}
component Ads() {
    const ad = resource(() => later("ad-data"))
    return <u>${S}{ad.loading ? "…" : ad.value}</u>
}
component Page() {
    const user = resource(() => later("user-data"))
    return <div>
        <b>${S}{user.loading ? "…" : user.value}</b>
        ${S}{user.loading ? null : <Friend />}
        <Ads />
    </div>
}
const r = await renderToStringAsync(() => Page())
log(r.html.replace(/<!--[^>]*-->/g, ""))
log(JSON.stringify(r.data))
`)
    assert.deepEqual(lines, [
        "<div><b>user-data</b><i>friend-data</i><u>ad-data</u></div>",
        '[{"value":"user-data"},{"value":"friend-data"},{"value":"ad-data"}]'
    ])
})

test("a branch is replaced before its old content re-runs on the same change", () => {
    const lines = run("owner-first", `
component App() {
    state user = { name: "Ann" }
    state show = true
    return <div>
        <button onClick=${S}{() => { user = null; show = false }}>out</button>
        ${S}{show ? <p>${S}{user.name}</p> : <p>bye</p>}
    </div>
}
const el = App()
click(el, "button")
log(el.innerHTML)
`)
    assert.deepEqual(lines, ["<button>out</button><p>bye</p>"])
})

test("server rendering escapes textarea and title text and guards style and script", () => {
    const lines = run("raw-text-ssr", `
const evil = "</textarea><img src=x onerror=alert(1)>"
component Page() {
    return <div><textarea>${S}{evil}</textarea><title>${S}{evil}</title><style>${S}{"</style><b>"}</style></div>
}
log(renderToString(() => Page()).replace(/<!--[^>]*-->/g, ""))
`)
    assert.deepEqual(lines, [
        "<div><textarea>&lt;/textarea&gt;&lt;img src=x onerror=alert(1)&gt;</textarea><title>&lt;/textarea&gt;&lt;img src=x onerror=alert(1)&gt;</title><style><\\/style><b></style></div>"
    ])
})

test("a string spread never sets inline event handler attributes", () => {
    const lines = run("spread-handlers", `
component Img(props) {
    state n = 0
    return <img src="x.png" ${S}{props.extra} data-n=${S}{n}>
}
log(renderToString(() => Img({ extra: "alt=photo onerror=alert(1)" })))
`)
    assert.deepEqual(lines, ['<img data-n="0" alt="photo" src="x.png">'])
})

test("a loose comparison against the selected value updates both rows", () => {
    const lines = run("loose-selection", `
component App() {
    state selected = 1
    state ids = ["1", "2"]
    return <ul>
        <button onClick=${S}{() => selected = 2}>x</button>
        ${S}{ids.map(id => <li class=${S}{selected == id ? "on" : "off"}>${S}{id}</li>)}
    </ul>
}
const el = App()
click(el, "button")
log(el.innerHTML)
`)
    assert.deepEqual(lines, ['<button>x</button><li class="off">1</li><li class="on">2</li>'])
})

test("provideData sends the value from the final server pass", () => {
    const lines = run("provide-final", `
component Page() {
    const user = resource(() => new Promise(r => setTimeout(() => r({ name: "Ann" }), 5)))
    const title = provideData("title", () => user.loading ? "Loading" : "Profile of " + user.value.name)
    return <h1>${S}{title}</h1>
}
const r = await renderToStringAsync(() => Page())
log(r.html.replace(/<!--[^>]*-->/g, ""), JSON.stringify(r.store))
`)
    assert.deepEqual(lines, ['<h1>Profile of Ann</h1> {"title":"Profile of Ann"}'])
})

test("route() follows the Router's url and lazy routes are awaited on the server", () => {
    const lines = run("router-ssr", `${ROUTER}
component User({ params }) {
    const r = route()
    return <h1>${S}{params.id}/${S}{r.params.id}</h1>
}
component Home() {
    return <h1>Home</h1>
}
const routes = { "/users/:id": User }
const lazy = { "/": () => Promise.resolve({ default: Home }) }
component Users() {
    return <div><Router routes=${S}{routes} url="/users/7" /></div>
}
component Lazy() {
    return <div><Router routes=${S}{lazy} url="/" fallback="loading" /></div>
}
log(renderToString(() => Users()).replace(/<!--[^>]*-->/g, ""))
const page = await renderToStringAsync(() => Lazy())
log(page.html.replace(/<!--[^>]*-->/g, ""))
`)
    assert.deepEqual(lines, ["<div><h1>7/7</h1></div>", "<div><h1>Home</h1></div>"])
})

test("components record their module except in script lowering for the REPL", () => {
    const source = "component A() {\n    return <b></b>\n}"
    assert.match(preprocess(source, "a.slim").code, /A\.__module__ = import\.meta\.url/)
    assert.doesNotMatch(preprocess(source, "repl", { script: true }).code, /import\.meta/)
})

test("the router shows the page for the path, links and navigate change it", () => {
    const lines = run("router", `${ROUTER}
component Home() {
    return <h1>Home</h1>
}
component User({ params }) {
    return <h1>User ${S}{params.id}</h1>
}
component NotFound({ path }) {
    return <h1>No page at ${S}{path}</h1>
}
const routes = { "/": Home, "/users/:id": User, "/lazy": () => Promise.resolve({ default: Home }), "*": NotFound }
component App() {
    return <div>
        <nav><Link href="/users/7" active="on">Ann</Link></nav>
        <Router routes=${S}{routes} />
    </div>
}
const el = App()
const title = () => el.querySelector("h1").textContent
log(title())
navigate("/users/7")
const page = el.querySelector("h1")
log(title(), el.querySelector("a").className, route().params.id)
navigate("/users/8?tab=2")
log(title(), el.querySelector("h1") === page, route().query.tab)
navigate("/nope")
log(title())
navigate("/lazy")
setTimeout(() => log("lazy", title()), 10)
log(matchRoute("/files/*rest", "/files/a/b").rest, JSON.stringify(matchRoute("/a/:x", "/b/1")))
`)
    assert.deepEqual(lines, ["Home", "User 7 on 7", "User 8 true 2", "No page at /nope", "a/b null", "lazy Home"])
})

test("a portal shows its children elsewhere and takes them along when it goes", () => {
    const lines = run("portal", `
let api = null
const host = htmlToVdom("<aside></aside>").toElement()
component App() {
    state open = false
    api = { toggle: () => { open = !open } }
    return <div>${S}{open && <Portal to=${S}{host}><p class="modal">hi</p></Portal>}</div>
}
const el = App()
api.toggle()
log(host.innerHTML, JSON.stringify(el.innerHTML))
api.toggle()
log(JSON.stringify(host.innerHTML))
`)
    assert.deepEqual(lines, ['<p class="modal">hi</p> ""', '""'])
})

test("component tags are checked against their props", () => {
    const badge = `component Badge({ count: int, children }) {\n    return <b>${S}{count}${S}{children}</b>\n}\n`
    compile(`${badge}component C() {\n    return <div><Badge count=${S}{1}>x</Badge></div>\n}`)
    assert.match(failure(`${badge}component C() {\n    return <div><Badge cont=${S}{1} /></div>\n}`), /"Badge" has no prop "cont" — did you mean "count"\?/)
    assert.match(failure(`${badge}component C() {\n    return <div><Badge /></div>\n}`), /"Badge" is missing prop "count" of type int/)
    assert.match(compile(`component C() {\n    state rows = [1]\n    return <ul>${S}{rows.map(row => <li key=${S}{row} move>${S}{row}</li>)}</ul>\n}`), /__move__\(__r__, 200\)/)
})

test("server resources of the same code in different components keep their own data", () => {
    const lines = run("resource-owners", `
const later = (v) => new Promise(resolve => setTimeout(() => resolve(v), 5))
component User(props) {
    const u = resource(() => later("user-" + props.id))
    return <i>${S}{props.id}=${S}{u.loading ? "…" : u.value}</i>
}
component Gate() {
    const g = resource(() => later("ok"))
    return <span>${S}{g.loading ? null : <User id="admin" />}</span>
}
component Page() {
    return <div><Gate /><User id="guest" /></div>
}
const r = await renderToStringAsync(() => Page())
log(r.html.replace(/<!--[^>]*-->/g, ""))
`)
    assert.deepEqual(lines, ["<div><span><i>admin=user-admin</i></span><i>guest=user-guest</i></div>"])
})

test("a list row whose data is gone is removed before it re-runs", () => {
    const lines = run("row-first", `
component App() {
    state ids = [1, 2, 3]
    state byId = { 1: { name: "a" }, 2: { name: "b" }, 3: { name: "c" } }
    const removeTwo = () => {
        byId = { 1: byId[1], 3: byId[3] }
        ids = ids.filter(x => x != 2)
    }
    return <ul><button onClick=${S}{removeTwo}>x</button>${S}{ids.map(id => <li>${S}{byId[id].name}</li>)}</ul>
}
const el = App()
click(el, "button")
log(el.innerHTML)
`)
    assert.deepEqual(lines, ["<button>x</button><li>a</li><li>c</li>"])
})

test("a hidden component that swaps its root updates and shows the new content", () => {
    const lines = run("hidden-fragment", `
let api = {}
component Live() {
    state k = 0
    api.k = v => k = v
    return k == 0 ? <u>a</u> : <i>b</i>
}
component App() {
    state show = true
    api.show = v => show = v
    const kept = <Live />
    return <div>${S}{show ? kept : null}</div>
}
const el = App()
api.show(false)
api.k(1)
api.show(true)
log(el.innerHTML)
`)
    assert.deepEqual(lines, ["<i>b</i>"])
})

test("children keep reacting after the component showing them hides and shows them again", () => {
    const lines = run("children-owner", `
let api = {}
component Panel(props) {
    state open = true
    api.open = v => open = v
    return <section>${S}{open ? props.children : null}</section>
}
component Counter() {
    state n = 0
    api.inc = () => n++
    return <b>${S}{n}</b>
}
component App() {
    return <Panel><Counter /></Panel>
}
const el = App()
api.inc()
api.open(false)
api.open(true)
api.inc()
api.inc()
log(el.outerHTML)
`)
    assert.deepEqual(lines, ["<section><b>3</b></section>"])
})

test("a resource inside a Portal does not take the data of the next resource while hydrating", () => {
    const lines = run("portal-resource", `
let calls = []
const later = (v) => { calls.push(v); return new Promise(resolve => setTimeout(() => resolve(v), 5)) }
const host = htmlToVdom("<aside></aside>").toElement()
component Modal() {
    const m = resource(() => later("modal-data"))
    return <p>${S}{m.loading ? "…" : m.value}</p>
}
component Main() {
    const r = resource(() => later("main-data"))
    return <b>${S}{r.loading ? "…" : r.value}</b>
}
component App() {
    return <div><Portal to=${S}{host}><Modal /></Portal><Main /></div>
}
const out = await renderToStringAsync(() => App())
const container = htmlToVdom("<div></div>").toElement()
container.innerHTML = out.html
calls = []
hydrate(() => App(), container, out.data)
log(container.textContent, host.textContent, calls.join(","))
`)
    assert.match(lines[0], /^main-data … modal-data/)
})

test("title and textarea with dynamic text hydrate and keep updating", () => {
    const lines = run("raw-text-hydrate", `
let api = {}
component Q() {
    state name = "Cart"
    api.name = v => name = v
    return <div><title>Shop - ${S}{name}</title><textarea>${S}{name}</textarea><p>x</p></div>
}
const container = htmlToVdom("<div></div>").toElement()
container.innerHTML = renderToString(() => Q())
hydrate(() => Q(), container)
api.name("Checkout")
log(container.querySelector("title").textContent, container.querySelector("textarea").textContent)
`)
    assert.deepEqual(lines, ["Shop - Checkout Checkout"])
})

test("catchError shows its fallback even when a cleanup in the failing part throws", () => {
    const lines = run("catch-cleanup", `
let api = {}
component Widget() {
    state n = 1
    api.n = v => n = v
    onCleanup(() => { throw new Error("cleanup failed") })
    return <b>${S}{n.toFixed(1)}</b>
}
component App() {
    return <section>${S}{catchError(() => <Widget />, (e) => <i>fallback</i>)}</section>
}
const el = App()
api.n(null)
log(el.innerHTML)
`)
    assert.deepEqual(lines, ["<i>fallback</i>"])
})

test("JSON in a script tag stays valid and server data keeps a __proto__ key as data", () => {
    const lines = run("script-json", `
component Head() {
    return <div><script type="application/ld+json">${S}{JSON.stringify({ name: "a <!-- b </script>" })}</script></div>
}
const html = renderToString(() => Head())
const text = html.slice(html.indexOf(">", html.indexOf("<script")) + 1, html.lastIndexOf("</script>"))
log(JSON.parse(text).name)
const out = await renderToStringAsync(() => { provideData("__proto__", () => ({ isAdmin: true })); return "" })
const run = new Function("window", out.script.slice(8, -9))
const fake = {}
run(fake)
log(Object.hasOwn(fake.__slimStore, "__proto__"), fake.__slimStore.isAdmin === undefined)
`)
    assert.deepEqual(lines, ["a <!-- b </script>", "true true"])
})

test("reassigning a struct variable with an object literal builds the struct", () => {
    const lines = run("struct-reassign", `
struct E {
    n: int
    tag: string = "t"
    dbl() -> int { return this.n * 2 }
}
let e: E = { n: 1 }
e = { n: 2 }
log(e.dbl(), e.tag)
`)
    assert.deepEqual(lines, ["4 t"])
})

test("a generic type alias checks its argument at runtime", () => {
    const lines = run("generic-alias", `
type L<T> = T | L<T>[]
const good: any = JSON.parse("[1, [2, 3]]")
const wrong: any = JSON.parse("[1, [\\"a\\"]]")
let ok: L<int> = good
log(JSON.stringify(ok))
try {
    let bad: L<int> = wrong
    log("accepted", JSON.stringify(bad))
} catch (e) {
    log("rejected")
}
`)
    assert.deepEqual(lines, ["[1,[2,3]]", "rejected"])
})

test("nested routers with kept pages render on the server and hydrate into the same nodes", () => {
    const lines = run("router-keep-hydrate", `${ROUTER}
component Overview() {
    return <h2>overview</h2>
}
component Files({ params }) {
    return <h2>files ${S}{params.id}</h2>
}
const inner = { "/": Overview, "/files": Files }
component Project({ params }) {
    state opened = 0
    return <section><h1>P ${S}{params.id}</h1><button onClick=${S}{() => opened++}>${S}{opened}</button><Router routes=${S}{inner} keep /></section>
}
component Home() {
    return <h1>Home</h1>
}
const routes = { "/": Home, "/projects/:id/*": Project }
component Server() {
    return <div><Router routes=${S}{routes} url="/projects/7/files" keep /></div>
}
component Client() {
    return <div><Router routes=${S}{routes} keep /></div>
}
const html = renderToString(() => Server())
log(html.replace(/<!--[^>]*-->/g, ""))
const container = htmlToVdom("<main></main>").toElement()
container.innerHTML = html
const files = container.querySelector("h2")
navigate("/projects/7/files")
hydrate(() => Client(), container)
log(container.querySelector("h2") === files, container.querySelector("h2").textContent)
click(container, "button")
navigate("/projects/7")
log(container.querySelector("h2").textContent)
navigate("/projects/7/files")
log(container.querySelector("h2") === files)
navigate("/")
log(container.querySelector("h1").textContent)
navigate("/projects/7/files")
log(container.querySelector("button").textContent, container.querySelector("h2") === files)
`)
    assert.deepEqual(lines, [
        "<div><section><h1>P 7</h1><button>0</button><h2>files 7</h2></section></div>",
        "true files 7",
        "overview",
        "true",
        "Home",
        "1 true"
    ])
})

test("an element component with <host> renders on the server as its own tag", () => {
    const lines = run("host-ssr", `
element("x-pill") component Pill({ label }) {
    return <host class="pill" data-label=${S}{label}><b>${S}{label}</b></host>
}
log(renderToString(() => Pill.__render__({ label: "a" })).replace(/<!--[^>]*-->/g, ""))
`)
    assert.deepEqual(lines, ['<x-pill data-label="a" class="pill"><b>a</b></x-pill>'])
})

test("links keep their text and active class through hydration, and . and .. resolve without a trailing slash", () => {
    const lines = run("link-hydrate", `${ROUTER}
component Project({ params }) {
    return <section><Link href="." active="on">Overview</Link><Link href=".." active="on">All</Link><Link href="files">Files</Link></section>
}
const routes = { "/projects/:id/*": Project }
component App(props) {
    return <div><nav><Link href="/projects/7" active="on" prefix>Projects</Link></nav><Router routes=${S}{routes} url=${S}{props.url} /></div>
}
const html = renderToString(() => App({ url: "/projects/7" }))
const container = htmlToVdom("<main></main>").toElement()
container.innerHTML = html
const nav = container.querySelector("nav a")
navigate("/projects/7")
hydrate(() => App({ url: "/projects/7" }), container)
const links = [...container.querySelectorAll("a")]
log(container.querySelector("nav a") === nav, links.map(a => a.textContent + "|" + a.getAttribute("href") + "|" + (a.className || "-")).join(" "))
`)
    assert.deepEqual(lines, ["true Projects|/projects/7|on Overview|/projects/7|on All|/projects|- Files|/projects/7/files|-"])
})
