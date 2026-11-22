import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__router_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href
const ROUTER = `use { Router, Link, navigate, route, onShow, onHide, onLeave, title, forget, onVisit, head, navigating } from ${JSON.stringify(pathToFileURL(path.join(root, "src", "external", "router.js")).href)}\n`
const S = "$"

const PRELUDE = `import { parseHTML } from "linkedom"
const dom = parseHTML("<!doctype html><html><head></head><body></body></html>")
let current = new URL(process.env.START_URL)
const visits = []
const location = {
    get href() { return current.href },
    get origin() { return current.origin },
    get pathname() { return current.pathname },
    get search() { return current.search },
    get hash() { return current.hash },
    assign(href) { visits.push("assign " + new URL(href, current).pathname) },
    replace(href) { visits.push("replace " + new URL(href, current).pathname) },
    reload() { visits.push("reload") }
}
const history = {
    state: null,
    pushState(state, title, href) { current = new URL(href, current); this.state = state; visits.push("push") },
    replaceState(state, title, href) { current = new URL(href, current); this.state = state; visits.push("replace") }
}
dom.window.scrollTo = () => visits.push("top")
dom.HTMLElement.prototype.scrollIntoView = function () { visits.push("to #" + this.id) }
globalThis.visits = visits
globalThis.goBack = (href, ...state) => {
    current = new URL(href, current)
    if (state.length) history.state = state[0]
    const event = dom.document.createEvent("Event")
    event.initEvent("popstate", false, false)
    dom.window.dispatchEvent(event)
}
globalThis.press = (node, options = {}) => {
    const event = dom.document.createEvent("Event")
    event.initEvent("click", true, true)
    Object.assign(event, { button: 0 }, options)
    node.dispatchEvent(event)
    return event.defaultPrevented
}
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, MutationObserver: dom.MutationObserver, location, history })
`

function run(name, source, start) {
    mkdirSync(outputDir, { recursive: true })
    const code = transform(source, path.join(root, "__router_tests__", `${name}.slim`), { globals: ["visits", "goBack", "press"] }).code
    const file = path.join(outputDir, `${name}.js`)
    const prelude = path.join(outputDir, "prelude.mjs")
    writeFileSync(prelude, PRELUDE)
    writeFileSync(file, code.replace(/^import\s+[^;]*(?:defaults|core)\.js";$/m, `import ${JSON.stringify(runtimeImport)};`))
    const result = spawnSync(process.execPath, ["--no-warnings", "--import", pathToFileURL(prelude).href, file], {
        cwd: root, encoding: "utf8", env: { ...process.env, START_URL: start }
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim().split("\n")
}

test("a router with a base leaves other paths to the server and takes plain links when asked", () => {
    const lines = run("base", `${ROUTER}
component List() {
    return <div><h1>List</h1><p class="html"></p></div>
}
component Item({ params }) {
    return <section><h1>Item ${S}{params.id}</h1><p id="part">x</p></section>
}
const routes = { "/": List, "/:id": Item }
component App() {
    return <main>
        <nav><Link href="/projects" active="on" prefix>All</Link><Link class="m" href="/x" active="on" match="/projects/:id">One</Link></nav>
        <Router base="/projects" routes=${S}{routes} intercept />
    </main>
}
const el = App()
document.body.appendChild(el)
const title = () => el.querySelector("h1").textContent
el.querySelector(".html").innerHTML = '<a class="in" href="/projects/7">7</a><a class="out" href="/articles">a</a><a class="ext" href="https://other.test/x">x</a><a class="new" target="_blank" href="/projects/8">8</a><a class="dl" download href="/projects/9">9</a><a class="no" href="/projects/a/b">n</a>'
const at = selector => el.querySelector(selector)
log(at(".m").className, title(), press(at(".out")), press(at(".ext")), press(at(".new")), press(at(".dl")), press(at(".no")), press(at(".in"), { ctrlKey: true }))
log(press(at(".in")), title(), location.pathname, at("nav a").className, at(".m").className, route().params.id)
await null
log(visits.splice(0).join(","))
navigate("/articles")
navigate("/projects/a/b")
log(title(), visits.splice(0).join(","))
navigate("/projects/8#part")
await null
log(title(), location.hash, route().hash, visits.splice(0).join(","))
const heading = el.querySelector("h1")
goBack("/projects/8#other")
log(el.querySelector("h1") === heading, route().hash)
navigate("/projects/8#other", { reload: true })
await null
log(el.querySelector("h1") === heading, title(), visits.splice(0).join(","))
const again = el.querySelector("h1")
navigate("/projects/8-title", { replace: true, silent: true })
log(el.querySelector("h1") === again, title(), location.pathname, visits.splice(0).join(","))
goBack("/projects")
log(title())
goBack("/articles")
log(visits.splice(0).join(","))
`, "http://site.test/projects")
    assert.deepEqual(lines, [
        "m List false false false false false false",
        "true Item 7 /projects/7 on m on 7",
        "push,top",
        "Item 7 assign /articles,assign /projects/a/b",
        "Item 8 #part #part push,to #part",
        "true #other",
        "false Item 8 replace,top",
        "true Item 8 /projects/8-title replace",
        "List",
        "reload"
    ])
})

test("an async route keeps the old page until it is ready and a later navigation wins", () => {
    const lines = run("pending", `${ROUTER}
component Home() {
    return <h1>Home</h1>
}
component Slow() {
    return <h1>Slow</h1>
}
component Fast() {
    return <h1>Fast</h1>
}
const later = (view, ms) => () => new Promise(resolve => setTimeout(() => resolve({ default: view }), ms))
const routes = { "/": Home, "/slow": later(Slow, 20), "/slower": later(Slow, 40), "/fast": Fast }
component App() {
    return <main><Router routes=${S}{routes} /></main>
}
const el = App()
document.body.appendChild(el)
const title = () => el.querySelector("h1").textContent
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
navigate("/slow")
await null
log(title(), visits.splice(0).join(","))
await wait(40)
log(title(), visits.splice(0).join(","))
navigate("/slower")
navigate("/fast")
await wait(60)
log(title(), location.pathname)
`, "http://site.test/")
    assert.deepEqual(lines, ["Home push", "Slow top", "Fast /fast"])
})

test("a router can route by a query parameter on its page", () => {
    const lines = run("query", `${ROUTER}
component Profile() {
    return <h1>Profile</h1>
}
component Security() {
    return <h1>Security</h1>
}
const tabs = { "profile": Profile, "security": Security, "/": Profile }
component App() {
    return <main>
        <Link class="tab" href="?page=security" active="on">Security</Link>
        <Router query="page" routes=${S}{tabs} />
    </main>
}
const el = App()
document.body.appendChild(el)
const title = () => el.querySelector("h1").textContent
log(title(), JSON.stringify(el.querySelector(".tab").className))
log(press(el.querySelector(".tab")), title(), location.search, el.querySelector(".tab").className)
navigate("/settings")
log(title())
navigate("?page=nope")
navigate("/other?page=security")
log(title(), visits.splice(0).join(","))
`, "http://site.test/settings?page=profile")
    assert.deepEqual(lines, [
        'Profile "tab"',
        "true Security ?page=security tab on",
        "Profile",
        "Profile push,push,assign /settings,assign /other"
    ])
})

test("a router inside a page routes below the part its page matched", () => {
    const lines = run("nested", `${ROUTER}
let builds = 0
component Overview() {
    return <h2>overview</h2>
}
component Files({ params }) {
    return <h2>files ${S}{params.id} ${S}{route().base}</h2>
}
component Settings() {
    return <h2>settings</h2>
}
const inner = { "/": Overview, "/files": Files, "/settings": Settings }
component Project({ params }) {
    builds++
    return <section>
        <h1>Project ${S}{params.id}</h1>
        <nav><Link class="files" href="files" active="on">F</Link><Link class="other" href="../8/settings">S</Link><Link class="top" href="/">H</Link></nav>
        <Router routes=${S}{inner} />
    </section>
}
component Home() {
    return <h1>Home</h1>
}
const routes = { "/": Home, "/projects/:id/*": Project }
component App() {
    return <main><Router routes=${S}{routes} /></main>
}
const el = App()
document.body.appendChild(el)
const text = selector => el.querySelector(selector)?.textContent
const href = selector => el.querySelector(selector).getAttribute("href")
navigate("/projects/7")
log(text("h1"), text("h2"), builds, href(".files"), href(".other"), href(".top"))
log(press(el.querySelector(".files")), text("h2"), builds, location.pathname, el.querySelector(".files").className)
navigate("/projects/7/settings")
log(text("h2"), builds)
navigate("/projects/8/files")
log(text("h1"), text("h2"), builds, href(".files"))
component Server() {
    return <Router routes=${S}{routes} url="/projects/9/files" />
}
const rendered = document.createElement("div")
rendered.innerHTML = renderToString(() => Server())
log(rendered.querySelector("h1").textContent, rendered.querySelector("h2").textContent)
const client = document.createElement("div")
client.appendChild(Server())
log(client.querySelector("h1").textContent)
`, "http://site.test/")
    assert.deepEqual(lines, [
        "Project 7 overview 1 /projects/7/files /projects/8/settings /",
        "true files 7 /projects/7/files 1 /projects/7/files files on",
        "settings 1",
        "Project 8 files 8 /projects/8/files 1 /projects/8/files",
        "Project 9 files 9 /projects/9/files",
        "Project 8"
    ])
})

test("a kept page is hidden instead of removed and comes back as it was", () => {
    const lines = run("keep", `${ROUTER}
const events = []
let feeds = 0
component Clock() {
    onUnmount(() => events.push("unmount"))
    return <span>clock</span>
}
component Feed() {
    feeds++
    state count = 0
    onHide(() => events.push("hide"))
    onShow(() => events.push("show"))
    return <div><h1>Feed</h1><input class="draft" /><button class="more" onClick=${S}{() => count++}>${S}{count}</button><Clock /></div>
}
component Chat({ params }) {
    return <div><h1>Chat ${S}{params.id}</h1><input class="draft" /></div>
}
component About() {
    return <h1>About</h1>
}
const routes = { "/": Feed, "/chat/:id": Chat, "/about": About }
component App() {
    return <main><Router routes=${S}{routes} keep=${S}{["/", "/chat/:id"]} max=${S}{2} /></main>
}
const scrolls = []
window.scrollTo = (x, y) => scrolls.push(y)
const wait = () => new Promise(resolve => setTimeout(resolve, 0))
const el = App()
document.body.appendChild(el)
const title = () => el.querySelector("h1").textContent
const draft = () => el.querySelector(".draft")
const feed = draft()
feed.value = "hello"
press(el.querySelector(".more"))
window.scrollY = 300
navigate("/about")
await wait()
log(title(), events.splice(0).join(","), scrolls.splice(0).join(","), feed.isConnected)
window.scrollY = 0
navigate("/")
await wait()
log(title(), draft() === feed, draft().value, el.querySelector(".more").textContent, feeds, events.splice(0).join(","), scrolls.splice(0).join(","))
navigate("/chat/1")
draft().value = "a"
const first = draft()
navigate("/chat/2")
draft().value = "b"
navigate("/chat/1")
await wait()
log(title(), draft() === first, draft().value, events.splice(0).join(","))
navigate("/chat/3")
await wait()
navigate("/")
await wait()
log(title(), feeds, draft() === feed, events.splice(0).join(","))
navigate("/chat/1", { reload: true })
await wait()
log(title(), draft() === first, JSON.stringify(draft().value))
`, "http://site.test/")
    assert.deepEqual(lines, [
        "About hide 0 false",
        "Feed true hello 1 1 show 300",
        "Chat 1 true a hide",
        "Feed 2 false unmount",
        "Chat 1 false \"\""
    ])
})

test("intercept leaves links inside what ignore names to the browser", () => {
    const lines = run("ignore", `${ROUTER}
component List() {
    return <div><h1>List</h1><p class="html"></p></div>
}
component Item({ params }) {
    return <h1>Item ${S}{params.id}</h1>
}
const routes = { "/": List, "/:id": Item }
component App() {
    return <main><Router base="/projects" routes=${S}{routes} intercept ignore=".editor" /></main>
}
const el = App()
document.body.appendChild(el)
el.querySelector(".html").innerHTML = '<a class="in" href="/projects/7">7</a><span class="editor"><a class="skip" href="/projects/8">8</a></span>'
log(press(el.querySelector(".skip")), el.querySelector("h1").textContent)
log(press(el.querySelector(".in")), el.querySelector("h1").textContent)
`, "http://site.test/projects")
    assert.deepEqual(lines, ["false List", "true Item 7"])
})

test("a reload builds again only the kept page it goes to, and kept pages get their inner scroll back", () => {
    const lines = run("keep-reload", `${ROUTER}
const builds = []
component Feed() {
    builds.push("feed")
    return <div><h1>Feed</h1><div class="pane">x</div></div>
}
component Chat({ params }) {
    builds.push("chat " + params.id)
    return <h1>Chat ${S}{params.id}</h1>
}
const routes = { "/": Feed, "/chat/:id": Chat }
component App() {
    return <main><Router routes=${S}{routes} keep /></main>
}
window.scrollTo = () => {}
const wait = () => new Promise(resolve => setTimeout(resolve, 0))
const el = App()
document.body.appendChild(el)
const pane = el.querySelector(".pane")
pane.scrollTop = 120
navigate("/chat/1")
pane.scrollTop = 0
navigate("/chat/1", { reload: true })
navigate("/")
await wait()
log(builds.join(","), el.querySelector(".pane") === pane, pane.scrollTop)
navigate("/chat/1")
log(builds.join(","))
`, "http://site.test/")
    assert.deepEqual(lines, ["feed,chat 1,chat 1 true 120", "feed,chat 1,chat 1"])
})

test("title names the page, onLeave can keep it, guard sends a route elsewhere", () => {
    const lines = run("guards", `${ROUTER}
let dirty = true
let signedIn = false
component Edit() {
    title("Editing")
    onLeave(to => {
        log("leave to " + to)
        return !dirty
    })
    return <h1>Edit</h1>
}
component Home() {
    title(() => "Home")
    return <h1>Home</h1>
}
component Login() {
    return <h1>Login</h1>
}
component Admin() {
    return <h1>Admin</h1>
}
const routes = { "/": Home, "/edit": Edit, "/login": Login, "/admin": Admin }
component App() {
    return <main><Router routes=${S}{routes} guard=${S}{match => match.pattern != "/admin" || signedIn || "/login"} /></main>
}
window.scrollTo = () => {}
const wait = () => new Promise(resolve => setTimeout(resolve, 0))
const el = App()
document.body.appendChild(el)
const heading = () => el.querySelector("h1").textContent
log(heading(), document.title)
navigate("/edit")
log(heading(), document.title)
log(navigate("/"), heading(), location.pathname)
goBack("/")
log(heading(), location.pathname)
dirty = false
log(navigate("/"), heading(), document.title)
navigate("/admin")
await wait()
log(heading(), location.pathname)
signedIn = true
navigate("/admin")
log(heading())
`, "http://site.test/")
    assert.deepEqual(lines, [
        "Home Home",
        "Edit Editing",
        "leave to /",
        "false Edit /edit",
        "leave to /",
        "Edit /edit",
        "leave to /",
        "true Home Home",
        "Login /login",
        "Admin"
    ])
})

test("forget drops a hidden kept page, and keepBy chooses what a kept page is kept by", () => {
    const lines = run("forget", `${ROUTER}
const builds = []
component Feed() {
    builds.push("feed")
    return <h1>Feed</h1>
}
component Video({ params }) {
    builds.push("video " + params.id)
    return <h1>Video ${S}{params.id}</h1>
}
const routes = { "/": Feed, "/video/:id": Video }
component App() {
    return <main><Router routes=${S}{routes} keep keepBy=${S}{match => match.pattern} /></main>
}
window.scrollTo = () => {}
const el = App()
document.body.appendChild(el)
navigate("/video/1")
navigate("/")
navigate("/video/2")
log(builds.join(","), el.querySelector("h1").textContent)
forget("/video/2")
forget("/")
navigate("/")
log(builds.join(","), el.querySelector("h1").textContent)
`, "http://site.test/")
    assert.deepEqual(lines, ["feed,video 1 Video 2", "feed,video 1,feed Feed"])
})

test("navigate keeps or sets history.state, matches carry it, and onVisit runs after every navigation that shows the page", () => {
    const lines = run("visits", `${ROUTER}
const seen = []
component Tab({ params }) {
    const page = route()
    onVisit(match => seen.push(match.path + " " + JSON.stringify(match.state)))
    return <h1>Tab ${S}{params.id} ${S}{page.pattern}</h1>
}
const routes = { "/tab/:id": Tab }
component App() {
    return <main><Router routes=${S}{routes} keepBy=${S}{match => match.state?.key ?? match.path} keep /></main>
}
window.scrollTo = () => {}
const el = App()
document.body.appendChild(el)
navigate("/tab/1", { state: { key: "a" } })
log(el.querySelector("h1").textContent, JSON.stringify(history.state))
navigate("/tab/1-renamed", { replace: true, silent: true })
log(JSON.stringify(history.state), location.pathname)
navigate("/tab/1-renamed")
log(seen.join(" | "))
`, "http://site.test/")
    assert.deepEqual(lines, [
        "Tab 1 /tab/:id {\"key\":\"a\"}",
        "{\"key\":\"a\"} /tab/1-renamed",
        "/tab/1 {\"key\":\"a\"} | /tab/1-renamed {\"key\":\"a\"}"
    ])
})

test("back and forward between two entries of the same address follow their state", () => {
    const lines = run("same-address", `${ROUTER}
const builds = []
component Feed({ params }) {
    const page = route()
    builds.push(page.state?.key ?? "none")
    return <h1>Feed ${S}{page.state?.key ?? "none"}</h1>
}
component Other() {
    return <h1>Other</h1>
}
const routes = { "/feed": Feed, "/other": Other }
component App() {
    return <main><Router routes=${S}{routes} keep keepBy=${S}{match => match.pattern == "/feed" ? match.state?.key ?? "none" : "other"} /></main>
}
window.scrollTo = () => {}
const el = App()
document.body.appendChild(el)
const title = () => el.querySelector("h1").textContent
navigate("/feed", { state: { key: "a" } })
log(title())
navigate("/other")
navigate("/feed", { state: { key: "b" } })
const b = el.querySelector("h1")
log(title())
goBack("/other", null)
goBack("/feed", { key: "a" })
log(title())
goBack("/other", null)
goBack("/feed", { key: "b" })
log(title(), el.querySelector("h1") === b, builds.join(","))
goBack("/feed", { key: "a" })
log(title())
goBack("/feed", { key: "b" })
log(title(), builds.join(","))
`, "http://site.test/feed")
    assert.deepEqual(lines, ["Feed a", "Feed b", "Feed a", "Feed b true none,a,b", "Feed a", "Feed b none,a,b"])
})

test("a route can load its data first: the old page stays until it comes, a newer navigation cancels it, and head sets the document's tags", () => {
    const lines = run("load-data", `${ROUTER}
const calls = []
const gates = {}
const fetchProject = id => new Promise((resolve, reject) => { gates[id] = { resolve, reject } })
component Project({ data, params }) {
    head(() => ({ title: data.name, description: "About " + data.name, meta: { "og:title": data.name }, link: { canonical: "/p/" + params.id } }))
    return <h1>${S}{data.name}</h1>
}
component Broken({ error }) {
    return <h1>Failed: ${S}{error.message}</h1>
}
component Home() {
    return <h1>Home</h1>
}
const load = ({ params, signal }) => {
    calls.push(params.id)
    signal.addEventListener("abort", () => calls.push("abort " + params.id))
    return fetchProject(params.id)
}
const routes = {
    "/": Home,
    "/p/:id": { page: Project, load },
    "/bad/:id": { page: Broken, load }
}
component App() {
    head({ title: "Site", description: "A site" })
    return <main><Router routes=${S}{routes} /></main>
}
window.scrollTo = () => {}
const wait = () => new Promise(resolve => setTimeout(resolve, 0))
const el = App()
document.body.appendChild(el)
const text = () => el.querySelector("h1").textContent
const tag = (selector, attr) => document.head.querySelector(selector)?.getAttribute(attr) ?? "-"
const tags = () => [document.title, tag("meta[name=description]", "content"), tag("meta[property='og:title']", "content"), tag("link[rel=canonical]", "href")].join(" | ")
log(text(), tags(), navigating())
navigate("/p/1")
await wait()
log(text(), calls.join(","), navigating())
navigate("/p/2")
gates["1"].resolve({ name: "One" })
gates["2"].resolve({ name: "Two" })
await wait()
log(text(), calls.join(","), navigating(), tags())
navigate("/")
log(text(), tags())
navigate("/p/2")
await wait()
log(text(), calls.join(","))
gates["2"].resolve({ name: "Two again" })
await wait()
log(text(), document.title)
navigate("/bad/3")
gates["3"].reject(new Error("no access"))
await wait()
log(text(), document.title, tags())
`, "http://site.test/")
    assert.deepEqual(lines, [
        "Home Site | A site | - | - false",
        "Home 1 true",
        "Two 1,abort 1,2 false Two | About Two | Two | /p/2",
        "Home Site | A site | - | -",
        "Home 1,abort 1,2,2",
        "Two again Two again",
        "Failed: no access Site Site | A site | - | -"
    ])
})

test("a kept page keeps its loaded data until it is reloaded, and route() reads it in nested components", () => {
    const lines = run("load-kept", `${ROUTER}
let calls = 0
const load = ({ params }) => new Promise(resolve => setTimeout(() => resolve({ n: ++calls, id: params.id }), 1))
component Label() {
    const page = route()
    return <b>${S}{page.data.id}#${S}{page.data.n}</b>
}
component Project() {
    return <h1><Label /></h1>
}
component Home() {
    return <h1>Home</h1>
}
const routes = { "/": Home, "/p/:id": { page: Project, load } }
component App() {
    return <main><Router routes=${S}{routes} keep fallback=${S}{<p>wait</p>} /></main>
}
window.scrollTo = () => {}
const wait = () => new Promise(resolve => setTimeout(resolve, 5))
const el = App()
document.body.appendChild(el)
const text = () => el.textContent
navigate("/p/1")
await wait()
log(text(), calls)
navigate("/")
navigate("/p/1")
log(text(), calls)
navigate("/p/1", { reload: true })
log(text())
await wait()
log(text(), calls)
`, "http://site.test/")
    assert.deepEqual(lines, ["1#1 1", "1#1 1", "1#1", "1#2 2"])
})

test("the server waits for route data, puts head tags in the page, and hydration reuses the data", () => {
    const lines = run("load-ssr", `${ROUTER}
let calls = 0
const load = ({ params }) => new Promise(resolve => setTimeout(() => { calls++; resolve({ name: "Project " + params.id }) }, 2))
component Project({ data }) {
    head(() => ({ title: data.name, description: "About <" + data.name + ">" }))
    return <h1>${S}{data.name}</h1>
}
const routes = { "/p/:id": { page: Project, load } }
component App({ url }) {
    return <main><Router routes=${S}{routes} url=${S}{url} /></main>
}
const rendered = await renderToStringAsync(() => App({ url: "/p/3" }), { title: "Default" })
log(rendered.html.replace(/<!--[^>]*-->/g, ""), calls)
log(rendered.head)
const container = document.createElement("div")
container.innerHTML = rendered.html
const h1 = container.querySelector("h1")
calls = 0
hydrate(() => App({ url: "/p/3" }), container, rendered.data, rendered.store)
log(container.querySelector("h1") === h1, container.textContent, calls, document.title)
`, "http://site.test/p/3")
    assert.deepEqual(lines, [
        "<main><h1>Project 3</h1></main> 1",
        '<title data-slim-head="Default">Project 3</title><meta name="description" content="About &lt;Project 3&gt;" data-slim-head>',
        "true Project 3 0 Project 3"
    ])
})

test("head of a hidden kept page steps aside and comes back with the page", () => {
    const lines = run("head-kept", `${ROUTER}
component Tab({ params }) {
    head({ title: "Tab " + params.tab, meta: { robots: params.tab == "b" ? "noindex" : null } })
    return <p>${S}{params.tab}</p>
}
const tabs = { "/:tab": Tab }
component Section() {
    head({ title: "Section" })
    return <section><Router routes=${S}{tabs} base="/s" keep /></section>
}
component Home() {
    return <h1>Home</h1>
}
const routes = { "/": Home, "/s/*": Section }
component App() {
    return <main><Router routes=${S}{routes} keep /></main>
}
window.scrollTo = () => {}
const wait = () => new Promise(resolve => setTimeout(resolve, 0))
document.title = "Start"
const el = App()
document.body.appendChild(el)
const robots = () => document.head.querySelector("meta[name=robots]")?.getAttribute("content") ?? "-"
log(document.title, robots())
navigate("/s/a")
log(document.title, robots())
navigate("/s/b")
log(document.title, robots())
navigate("/")
log(document.title, robots())
navigate("/s/b")
await wait()
log(document.title, robots())
navigate("/s/a")
log(document.title, robots())
`, "http://site.test/")
    assert.deepEqual(lines, ["Start -", "Tab a -", "Tab b noindex", "Start -", "Tab b noindex", "Tab a -"])
})

test("links are active by the request's address on the server, and hydration drops a class the server put that no longer applies", () => {
    const lines = run("link-ssr", `${ROUTER}
component Nav() {
    return <nav><Link href="/" active="on">Home</Link><Link href="/b" active="on" class="tab">B</Link></nav>
}
const classes = root => [...root.querySelectorAll("a")].map(a => a.textContent + ":" + (a.getAttribute("class") ?? "")).join(" ")
const rendered = await renderToStringAsync(() => Nav(), { url: "/" })
const container = document.createElement("div")
container.innerHTML = rendered.html
log(classes(container))
const other = await renderToStringAsync(() => Nav(), { url: "/b" })
const second = document.createElement("div")
second.innerHTML = other.html
log(classes(second))
hydrate(() => Nav(), container, rendered.data, rendered.store)
log(classes(container))
`, "http://site.test/b")
    assert.deepEqual(lines, ["Home:on B:tab", "Home: B:tab on", "Home: B:tab on"])
})

test("a kept page with a rest pattern is kept once for the part it matched, and navigating() covers a first page that is still loading", () => {
    const lines = run("kept-rest", `${ROUTER}
let sections = 0
component Tab({ params }) {
    return <p>${S}{params.tab}</p>
}
const tabs = { "/:tab": Tab }
component Section({ params }) {
    sections++
    return <section><Router routes=${S}{tabs} keep /></section>
}
component Late({ data }) {
    return <p>${S}{data}</p>
}
component Home() {
    return <h1>Home</h1>
}
const routes = {
    "/": Home,
    "/s/*": Section,
    "/late": { page: Late, load: () => new Promise(resolve => setTimeout(() => resolve("late"), 5)) }
}
component App() {
    return <main><Router routes=${S}{routes} keep /></main>
}
window.scrollTo = () => {}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const el = App()
document.body.appendChild(el)
await wait(0)
log(navigating(), JSON.stringify(el.textContent))
await wait(10)
log(navigating(), el.textContent)
navigate("/s/a")
navigate("/s/b")
navigate("/")
navigate("/s/a")
log(el.textContent, sections)
`, "http://site.test/late")
    assert.deepEqual(lines, ['true ""', "false late", "a 1"])
})

test("a route whose module fails stops waiting, shows the fallback, and is tried again on the next visit", () => {
    const lines = run("failed-import", `${ROUTER}
let tries = 0
component Home() {
    return <h1>Home</h1>
}
const routes = {
    "/": Home,
    "/broken": () => { tries++; return Promise.reject(new Error("offline")) }
}
component App() {
    return <main><Router routes=${S}{routes} fallback=${S}{<p>fallback</p>} /></main>
}
window.scrollTo = () => {}
console.error = () => {}
const wait = () => new Promise(resolve => setTimeout(resolve, 5))
const el = App()
document.body.appendChild(el)
navigate("/broken")
await wait()
log(el.textContent, tries, navigating())
navigate("/")
navigate("/broken")
await wait()
log(el.textContent, tries, navigating())
`, "http://site.test/")
    assert.deepEqual(lines, ["fallback 1 false", "fallback 2 false"])
})

test("a parameter ending in ? may be left out at the end of a pattern", () => {
    const lines = run("optional-param", `${ROUTER}
use { matchRoute } from ${JSON.stringify(pathToFileURL(path.join(root, "src", "external", "router.js")).href)}
log(JSON.stringify([matchRoute("/:tab?", "/"), matchRoute("/:tab?", "/files"), matchRoute("/users/:id/:tab?", "/users/7"), matchRoute("/users/:id/:tab?", "/users/7/posts"), matchRoute("/:tab?", "/a/b")]))
`, "http://site.test/")
    assert.deepEqual(lines, ['[{},{"tab":"files"},{"id":"7"},{"id":"7","tab":"posts"},null]'])
})

test("on the server a router without url routes by the request's address", () => {
    const lines = run("server-url", `${ROUTER}
component Tab({ params }) {
    return <b>${S}{params.tab}</b>
}
const tabs = { "/:tab?": Tab }
component Project({ params }) {
    return <section>${S}{params.id}:<Router routes=${S}{tabs} /></section>
}
const routes = { "/p/:id/*": Project }
component App() {
    return <main><Router routes=${S}{routes} /></main>
}
const a = await renderToStringAsync(() => App(), { url: "/p/5/files?x=1" })
const b = await renderToStringAsync(() => App(), { url: "/p/6" })
log(a.html.replace(/<!--[^>]*-->/g, ""), b.html.replace(/<!--[^>]*-->/g, ""))
`, "http://site.test/")
    assert.deepEqual(lines, ["<main><section>5:<b>files</b></section></main> <main><section>6:<b></b></section></main>"])
})

test("onVisit waits while a route is still loading, so the page being left does not see the new address", () => {
    const lines = run("visit-wait", `${ROUTER}
const seen = []
component Old() {
    onVisit(() => seen.push("old " + location.pathname))
    return <h1>Old</h1>
}
component Late() {
    onVisit(() => seen.push("late " + location.pathname))
    return <h1>Late</h1>
}
const routes = {
    "/": Old,
    "/late": () => new Promise(resolve => setTimeout(() => resolve(Late), 5))
}
component App() {
    return <main><Router routes=${S}{routes} keep /></main>
}
window.scrollTo = () => {}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const el = App()
document.body.appendChild(el)
navigate("/late")
await wait(0)
log(el.textContent, seen.join(","))
await wait(20)
log(el.textContent, seen.join(","))
navigate("/")
log(el.textContent, seen.join(","))
`, "http://site.test/")
    assert.deepEqual(lines, ["Old ", "Late late /late", "Old late /late,old /"])
})
