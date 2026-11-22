import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__dom_lifecycle__")
const runtime = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href
const linkedom = pathToFileURL(path.join(root, "node_modules", "linkedom", "esm", "index.js")).href

const PRELUDE = `import { parseHTML } from ${JSON.stringify(linkedom)};
const page = parseHTML("<!doctype html><html><head></head><body></body></html>");
Object.assign(globalThis, { window: page, document: page.document, HTMLElement: page.HTMLElement, MutationObserver: page.MutationObserver, customElements: page.customElements, Event: page.Event });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
`

function live(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const { code } = transform(source, path.join(root, "__dom_lifecycle__", `${name}.slim`), { sourceMaps: false, globals: ["tick"] })
    const body = code.replace(/^import\s+[^;]*(?:defaults|core)\.js";$/m, `await import(${JSON.stringify(runtime)});`)
    const file = path.join(outputDir, `${name}.mjs`)
    writeFileSync(file, PRELUDE + body)
    const result = spawnSync(process.execPath, ["--no-warnings", file], { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim().split(/\r?\n/)
}

function compileError(source) {
    try {
        transform(source, path.join(root, "__dom_lifecycle__", "error.slim"), { sourceMaps: false })
    } catch (error) {
        return error.message
    }
    return ""
}

test("expose inside onMount runs once and the API is there", () => {
    const out = live("expose", `
        component Nav(props) {
            onMount(() => {
                log("mount")
                expose({ hello: () => "hi" })
            })
            return <nav>x</nav>
        }
        const nav = Nav({})
        log(nav.hello())
    `)
    assert.deepEqual(out, ["mount", "hi"])
})

test("a removed component runs onUnmount and stops its effects; a move does not unmount", () => {
    const out = live("removal", `
        state count = 0
        component Row(props) {
            effect(() => { log("effect " + count) })
            onConnect(() => log("connect"))
            onUnmount(() => log("unmount"))
            return <div>row</div>
        }
        const one = document.createElement("div")
        const two = document.createElement("div")
        document.body.append(one, two)
        const row = Row({})
        one.appendChild(row)
        await tick()
        two.appendChild(row)
        await tick()
        log("moved")
        row.remove()
        await tick()
        count = 1
        await tick()
        log("done")
    `)
    assert.deepEqual(out, ["effect 0", "connect", "moved", "unmount", "done"])
})

test("keepAlive keeps a component across removals, and a late onUnmount is not lost", () => {
    const out = live("keep", `
        component Kept(props) {
            keepAlive()
            onConnect(() => log("connect"))
            onUnmount(() => log("unmount"))
            return <p>k</p>
        }
        component Late(props) {
            onMount(async () => {
                await null
                onUnmount(() => log("late unmount"))
            })
            return <p>l</p>
        }
        const kept = Kept({})
        const late = Late({})
        document.body.append(kept, late)
        await tick()
        kept.remove()
        late.remove()
        await tick()
        document.body.append(kept)
        await tick()
    `)
    assert.deepEqual(out, ["connect", "unmount", "late unmount", "connect"])
})

test("render replaces the previous view and disposes it", () => {
    const out = live("render", `
        component Page(props) {
            onUnmount(() => log("unmount " + props.n))
            return <section>${"${props.n}"}</section>
        }
        const target = document.createElement("main")
        document.body.append(target)
        render(() => Page({ n: 1 }), target)
        const stop = render(() => Page({ n: 2 }), target)
        log(target.innerHTML)
        stop()
        log(target.innerHTML === "" ? "empty" : target.innerHTML)
    `)
    assert.deepEqual(out, ["unmount 1", "<section>2</section>", "unmount 2", "empty"])
})

test("onRemove and listen clean up after plain DOM", () => {
    const out = live("plain", `
        const box = document.createElement("div")
        document.body.append(box)
        onRemove(box, () => log("removed"))
        const stop = listen(box, "ping", () => log("ping"))
        box.dispatchEvent(new Event("ping"))
        stop()
        box.dispatchEvent(new Event("ping"))
        box.remove()
        await tick()
    `)
    assert.deepEqual(out, ["ping", "removed"])
})

test("an element component returns its host, renders before it is attached and keeps its children", () => {
    const out = live("element", `
        element("x-card") component Card(props) {
            onMount(() => expose({ title: () => props.video?.title ?? "none" }))
            onConnect(() => log("connect"))
            onUnmount(() => log("unmount"))
            return <div class="card">${"${props.children}"}</div>
        }
        const host = Card({ video: { title: "Clip" } })
        log(host.tagName.toLowerCase() + " " + host.title())
        const made = document.createElement("x-card")
        made.props = { video: { title: "Made" } }
        log(made.title())
        component Parent(props) {
            onMount((el) => log("parent sees " + el.querySelector("x-card").title()))
            return <section><x-card video=${"${{ title: \"Obj\" }}"}><b>kid</b></x-card></section>
        }
        const parent = Parent({})
        log(parent.querySelector("x-card").innerHTML)
        const one = document.createElement("div")
        const two = document.createElement("div")
        document.body.append(one, two)
        one.append(host)
        await tick()
        two.append(host)
        await tick()
        host.remove()
        await tick()
        two.append(host)
        await tick()
        log(host.title())
    `)
    assert.deepEqual(out, [
        "x-card Clip",
        "Made",
        "parent sees Obj",
        "<div class=\"card\"><b>kid</b></div>",
        "connect",
        "unmount",
        "connect",
        "Clip"
    ])
})

test("handlers bind to their element: stopPropagation above them and non-bubbling events don't lose them", () => {
    const out = live("events", `
        component Menu(props) {
            return <div class="menu"><button onClick=${"${() => log(\"button\")}"}>b</button></div>
        }
        const menu = Menu({})
        document.body.append(menu)
        menu.addEventListener("click", e => e.stopPropagation())
        document.body.addEventListener("click", () => log("body"))
        menu.querySelector("button").dispatchEvent(new Event("click", { bubbles: true }))
        const view = <p><img onError=${"${() => log(\"error\")}"} src="x"/></p>
        const node = htmlToVdom(view).toElement()
        node.querySelector("img").dispatchEvent(new Event("error"))
        component Once(props) {
            return <button onClick:once=${"${() => log(\"once\")}"}>o</button>
        }
        const once = Once({})
        once.dispatchEvent(new Event("click"))
        once.dispatchEvent(new Event("click"))
    `)
    assert.deepEqual(out, ["button", "error", "once"])
})

test("raw.join and raw of an array keep markup safe and unescaped", () => {
    const out = live("join", `
        func item(x) {
            return <a>${"${x}"}</a>
        }
        log(raw.join(["a", "<b>"].map(item), ", ").value)
        log(raw.join(["<i>"]).value)
        log(raw(["<hr>", item("c")]).value)
    `)
    assert.deepEqual(out, ["<a>a</a>, <a>&lt;b&gt;</a>", "&lt;i&gt;", "<hr><a>c</a>"])
})

test("class= changes only its own classes and bind:value never writes the value attribute", () => {
    const out = live("attrs", `
        component Row(props) {
            state active = "on"
            state secret = "s3"
            return <div class=${"${active}"}><input type="password" bind:value=${"${secret}"}/><button onClick=${"${() => { active = \"off\"; secret = \"t4\" }}"}>x</button></div>
        }
        const row = Row({})
        const input = row.querySelector("input")
        const attributes = []
        let current = input.value
        Object.defineProperty(input, "value", { get: () => current, set: value => { current = value } })
        const set = input.setAttribute
        input.setAttribute = function (name, value) {
            attributes.push(name)
            return set.call(this, name, value)
        }
        row.classList.add("outside")
        row.querySelector("button").dispatchEvent(new Event("click"))
        log(row.className)
        log(input.value + " " + attributes.includes("value"))
    `)
    assert.deepEqual(out, ["outside off", "t4 false"])
})

test("dynamic tags render elements and components and follow the tag", () => {
    const out = live("dynamic", `
        component Tab(props) {
            return <em>${"${props.label}"}</em>
        }
        component Panel(props) {
            state tag = "section"
            const kind = Tab
            return <div><${"${tag}"} class="box">in</${"${tag}"}><${"${kind}"} label="tab"/><button onClick=${"${() => { tag = \"article\" }}"}>x</button></div>
        }
        const panel = Panel({})
        log(panel.innerHTML)
        panel.querySelector("button").dispatchEvent(new Event("click"))
        log(panel.querySelector(".box").tagName.toLowerCase())
        const name = "h2"
        log(String(<${"${name}"} id="h">Head</${"${name}"}>))
    `)
    assert.deepEqual(out, ["<section class=\"box\">in</section><em>tab</em><button>x</button>", "article", "<h2 id=\"h\">Head</h2>"])
})

test("an unknown prefix or event modifier is a compile error", () => {
    assert.match(compileError("component A(props) {\n    return <div class:muted=${true}></div>\n}\n"), /Unknown attribute "class:muted"/)
    assert.match(compileError("component A(props) {\n    return <div onClick:later=${() => 1}></div>\n}\n"), /Unknown event modifier "later"/)
})

test("setHtml brings back components and handlers placed in markup", () => {
    const out = live("sethtml", `
        component Badge(props) {
            return <b onClick=${"${() => log(\"badge\")}"}>${"${props.n}"}</b>
        }
        const box = document.createElement("div")
        setHtml(box, <p>count: ${"${Badge({ n: 3 })}"}</p>)
        log(box.innerHTML)
        box.querySelector("b").dispatchEvent(new Event("click"))
    `)
    assert.deepEqual(out, ["<p>count: <b>3</b></p>", "badge"])
})

test("keepAlive keeps the components inside it too, and dispose ends them all", () => {
    const out = live("keep-tree", `
        element("x-badge") component Badge(props) {
            state hits = 0
            onMount(() => expose({ hit: () => { hits++ } }))
            onUnmount(() => log("badge unmount"))
            return <b>${"${hits}"}</b>
        }
        component Counter(props) {
            state count = 0
            onUnmount(() => log("counter unmount"))
            return <button class="count" onClick=${"${() => count++}"}>${"${count}"}</button>
        }
        component Panel(props) {
            keepAlive()
            onUnmount(() => log("panel unmount"))
            return <section><x-badge></x-badge><Counter /></section>
        }
        const panel = Panel({})
        document.body.append(panel)
        await tick()
        panel.querySelector("x-badge").hit()
        panel.querySelector(".count").click()
        const badge = panel.querySelector("x-badge")
        const body = document.createElement("div")
        document.body.append(body)
        body.append(panel)
        await tick()
        body.remove()
        await tick()
        document.body.append(panel)
        await tick()
        log(panel.querySelector("x-badge") === badge, panel.querySelector("x-badge").textContent, panel.querySelector(".count").textContent)
        panel.remove()
        await tick()
        dispose(panel)
        await tick()
        log("disposed")
    `)
    assert.deepEqual(out, ["panel unmount", "true 1 1", "panel unmount", "counter unmount", "badge unmount", "disposed"])
})

test("listen after an await inside a component is removed with the component", () => {
    const out = live("late-listen", `
        const target = document.createElement("div")
        component Watcher(props) {
            onMount(async () => {
                await null
                listen(target, "ping", () => log("ping"))
            })
            return <p>w</p>
        }
        const watcher = Watcher({})
        document.body.append(watcher)
        await tick()
        target.dispatchEvent(new Event("ping"))
        watcher.remove()
        await tick()
        target.dispatchEvent(new Event("ping"))
        log("after")
    `)
    assert.deepEqual(out, ["ping", "after"])
})

test("upgrade builds element components in markup that is not in the document", () => {
    const out = live("upgrade-detached", `
        element("x-hello") component Hello(props) {
            return <i>hello ${"${props.name}"}</i>
        }
        const box = document.createElement("div")
        box.innerHTML = '<x-hello name="Ann"></x-hello>'
        upgrade(box)
        log(box.querySelector("x-hello").innerHTML)
        box.querySelector("x-hello").setAttribute("name", "Bob")
        await tick()
        log(box.querySelector("x-hello").innerHTML)
    `)
    assert.deepEqual(out, ["<i>hello Ann</i>", "<i>hello Bob</i>"])
})

test("a kept component that is thrown away can be collected", () => {
    mkdirSync(outputDir, { recursive: true })
    const { code } = transform(`
        component Panel(props) {
            keepAlive()
            state count = 0
            onUnmount(() => log("unmount"))
            return <section>${"${count}"}</section>
        }
        let panel = Panel({})
        document.body.append(panel)
        await tick()
        panel.remove()
        await tick()
        let collected = false
        const registry = new FinalizationRegistry(() => { collected = true })
        registry.register(panel, "panel")
        panel = null
        for (let i = 0; i < 20 && !collected; i++) {
            globalThis.gc()
            await tick()
        }
        log(collected)
    `, path.join(root, "__dom_lifecycle__", "collect.slim"), { sourceMaps: false, globals: ["tick"] })
    const body = code.replace(/^import\s+[^;]*(?:defaults|core)\.js";$/m, `await import(${JSON.stringify(runtime)});`)
    const file = path.join(outputDir, "collect.mjs")
    writeFileSync(file, PRELUDE + body)
    const result = spawnSync(process.execPath, ["--no-warnings", "--expose-gc", file], { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), ["unmount", "true"])
})

test("markup kept in a variable before it is returned upgrades without errors", () => {
    const out = live("markup-variable", `
        component Box({ a }) {
            const el = <div class="box" data-a=${"${a}"}><span>${"${a}"}</span></div>
            return el
        }
        log(Box({ a: 1 }).outerHTML)
    `)
    assert.deepEqual(out, ['<div data-a="1" class="box"><span>1</span></div>'])
})

test("markup kept in a variable keeps updating its own bindings", () => {
    const out = live("markup-variable-live", `
        component Counter() {
            state count = 0
            const button = <button onClick=${"${() => count++}"}>${"${count}"}</button>
            return button
        }
        const el = Counter()
        el.click()
        el.click()
        log(el.tagName.toLowerCase(), el.textContent)
    `)
    assert.deepEqual(out, ["button 2"])
})

test("a fragment groups several elements without a wrapper", () => {
    const out = live("fragments", `
        component Pair({ label }) {
            return <><dt>${"${label}"}</dt><dd>value</dd></>
        }
        component List() {
            state open = true
            return <dl>
                <Pair label="a" />
                ${"${open ? <><dt>x</dt><dd>y</dd></> : <dt>closed</dt>}"}
                <button onClick=${"${() => open = !open}"}>t</button>
            </dl>
        }
        const list = List()
        log(list.querySelectorAll("dt").length, list.querySelectorAll("dd").length)
        list.querySelector("button").click()
        log(list.querySelectorAll("dt").length, list.querySelectorAll("dd").length)
    `)
    assert.deepEqual(out, ["2 2", "2 1"])
})

test("draggable, spellcheck and contenteditable spell out true and false", () => {
    const out = live("spelled-booleans", `
        component Row() {
            state on = true
            return <div draggable=${"${on}"} spellcheck=${"${!on}"} contenteditable=${"${on}"} hidden=${"${!on}"} onClick=${"${() => on = !on}"}>r</div>
        }
        const row = Row()
        log(row.getAttribute("draggable"), row.getAttribute("spellcheck"), row.getAttribute("contenteditable"), row.hasAttribute("hidden"))
        row.click()
        log(row.getAttribute("draggable"), row.getAttribute("spellcheck"), row.getAttribute("contenteditable"), row.hasAttribute("hidden"))
    `)
    assert.deepEqual(out, ["true false true false", "false true false true"])
})

test("<host> puts attributes and bindings on the element of an element component", () => {
    const out = live("host-tag", `
        element("x-bar") component Bar() {
            state pins = 0
            return <host class="bar ${"${pins ? \"full\" : \"\"}"}" hidden=${"${pins == 0}"}><b onClick=${"${() => pins++}"}>${"${pins}"}</b></host>
        }
        const bar = Bar({})
        bar.classList.add("mine")
        log(bar.tagName.toLowerCase(), bar.className, bar.hasAttribute("hidden"), bar.innerHTML)
        bar.querySelector("b").click()
        log(bar.className, bar.hasAttribute("hidden"), bar.querySelector("b").textContent)
        const made = document.createElement("x-bar")
        document.body.append(made)
        await tick()
        log(made.className, made.querySelectorAll("x-bar, host").length)
    `)
    assert.deepEqual(out, [
        "x-bar bar mine true <b>0</b>",
        "bar mine full false 1",
        "bar 0"
    ])
})
