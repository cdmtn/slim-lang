import assert from "node:assert/strict"
import { test } from "node:test"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { once } from "node:events"
import { createServer } from "node:net"

const root = process.cwd()
const compiler = path.join(root, "src", "compile.js")
const cli = path.join(root, "src", "bin", "cli.js")
const runner = path.join(root, "run-slim.js")
const nodeEnv = { ...process.env, NODE_PATH: path.join(root, "node_modules") }

function project(files) {
    const dir = mkdtempSync(path.join(tmpdir(), "slim-tooling-"))
    for (const [name, content] of Object.entries(files)) write(dir, name, content)
    return dir
}

function write(dir, name, content) {
    const file = path.join(dir, name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
}

function run(dir, script, args = [], env = {}) {
    return spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8", env: { ...nodeEnv, ...env } })
}

function withProject(files, body) {
    const dir = project(files)
    try {
        return body(dir)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

test("a dist folder that is the project folder is refused and nothing is deleted", () => {
    withProject({ "slimconfig.json": JSON.stringify({ main: "index", dist: "." }), "README.md": "keep", "index.slim": "log(1)\n" }, dir => {
        const result = run(dir, compiler)
        assert.equal(result.status, 1)
        assert.match(result.stderr, /is the project folder or contains it/)
        assert.equal(readFileSync(path.join(dir, "README.md"), "utf8"), "keep")
        assert.ok(existsSync(path.join(dir, "index.slim")))
        assert.ok(existsSync(path.join(dir, "slimconfig.json")))
    })
})

test("cleaning the dist folder only removes files an earlier build wrote", () => {
    withProject({
        "slimconfig.json": JSON.stringify({ main: "index", dist: "out" }),
        "util.slim": "export const x = 1\n",
        "index.slim": `use { x } from "./util"\nlog(x)\n`
    }, dir => {
        assert.equal(run(dir, compiler).status, 0)
        write(dir, "out/notes.txt", "mine")
        write(dir, "out/hand.js", "export const mine = 1\n")
        assert.ok(existsSync(path.join(dir, "out", "util.js")))

        write(dir, "index.slim", "log(2)\n")
        assert.equal(run(dir, compiler).status, 0)
        assert.ok(!existsSync(path.join(dir, "out", "util.js")))
        assert.ok(existsSync(path.join(dir, "out", "index.js")))
        assert.equal(readFileSync(path.join(dir, "out", "notes.txt"), "utf8"), "mine")
        assert.ok(existsSync(path.join(dir, "out", "hand.js")))
        assert.ok(existsSync(path.join(dir, "util.slim")))
    })
})

test("reverting a file after a failed build compiles it again", () => {
    const good = "export struct User {\n    age: int\n}\n"
    withProject({
        "slimconfig.json": JSON.stringify({ main: "index" }),
        "models.slim": good,
        "index.slim": `use { User } from "./models"\nconst u: User = { age: 1 }\nlog(u.age)\n`
    }, dir => {
        assert.equal(run(dir, compiler).status, 0)
        write(dir, "models.slim", `export struct User {\n    age: string\n}\nlog("BROKEN")\n`)
        assert.equal(run(dir, compiler).status, 1)
        assert.match(readFileSync(path.join(dir, "slim-dist", "models.js"), "utf8"), /BROKEN/)

        write(dir, "models.slim", good)
        assert.equal(run(dir, compiler).status, 0)
        assert.doesNotMatch(readFileSync(path.join(dir, "slim-dist", "models.js"), "utf8"), /BROKEN/)

        writeFileSync(path.join(dir, "slim-dist", "models.js"), "throw new Error('tampered')\n")
        assert.equal(run(dir, compiler).status, 0)
        const ran = spawnSync(process.execPath, ["--no-warnings", path.join(dir, "slim-dist", "index.js")], { cwd: dir, encoding: "utf8", env: nodeEnv })
        assert.equal(ran.stdout.trim(), "1", ran.stderr)
    })
})

test("two sources that compile to the same output fail the build", () => {
    withProject({
        "slimconfig.json": JSON.stringify({ main: "index" }),
        "util.slim": "export const a = 1\n",
        "src/util.slim": "export const b = 2\n",
        "index.slim": `use { a } from "./util"\nuse { b } from "./src/util"\nlog(a, b)\n`
    }, dir => {
        const result = run(dir, compiler)
        assert.equal(result.status, 1)
        assert.match(result.stderr, /util\.slim and .*util\.slim both compile to/)
    })
})

test("runtime files are refreshed by content, not by modification time", () => {
    withProject({ "slimconfig.json": JSON.stringify({ main: "index" }), "index.slim": "log(1)\n" }, dir => {
        assert.equal(run(dir, compiler).status, 0)
        const copied = path.join(dir, "slim-dist", "external", "core.js")
        writeFileSync(copied, "stale")
        const future = new Date(Date.now() + 365 * 24 * 3600 * 1000)
        utimesSync(copied, future, future)
        assert.equal(run(dir, compiler).status, 0)
        assert.equal(readFileSync(copied, "utf8"), readFileSync(path.join(root, "src", "external", "core.js"), "utf8"))
    })
})

test("slmc test leaves no files behind", () => {
    withProject({
        "package.json": "{}",
        "slimconfig.json": JSON.stringify({ main: "index" }),
        "lib/math.slim": "export func add(a: int, b: int) -> int { return a + b }\n",
        "lib/math.test.slim": `use { add } from "./math"\ntest("adds", () => { assert(add(1, 2) == 3) })\n`,
        "index.slim": `use { add } from "./lib/math"\nlog(add(1, 2))\n`
    }, dir => {
        assert.equal(run(dir, compiler).status, 0)
        const built = path.join(dir, "slim-dist", "lib", "math.js")
        const before = readFileSync(built, "utf8")
        const files = readdirSync(path.join(dir, "slim-dist"), { recursive: true }).sort()

        const tested = run(dir, cli, ["test"])
        assert.equal(tested.status, 0, tested.stdout + tested.stderr)
        assert.match(tested.stdout, /1 passed/)
        assert.equal(readFileSync(built, "utf8"), before)
        assert.deepEqual(readdirSync(dir).filter(name => name.startsWith(".slim-tests")), [])
        assert.deepEqual(readdirSync(path.join(dir, "slim-dist"), { recursive: true }).sort(), files)

        const rebuilt = run(dir, compiler)
        assert.match(rebuilt.stdout, /Up to date: 2 of 2 files/)
    })
})

test("slmc test leaves the tests of installed packages out", () => {
    withProject({
        "package.json": "{}",
        "slimconfig.json": JSON.stringify({ main: "index" }),
        "index.slim": "log(1)\n",
        "own.test.slim": `test("own", () => { assert(true) })\n`,
        "packages/kit/tests/kit.test.slim": `test("kit", () => { assert(false) })\n`,
        "vendor/kit/tests/kit.test.slim": `test("vendored", () => { assert(true) })\n`
    }, dir => {
        const tested = run(dir, cli, ["test"])
        assert.equal(tested.status, 0, tested.stdout + tested.stderr)
        assert.match(tested.stdout, /✓ own/)
        assert.match(tested.stdout, /✓ vendored/)
        assert.doesNotMatch(tested.stdout, /packages/)

        const direct = run(dir, cli, ["test", "packages/kit/tests/kit.test.slim"])
        assert.notEqual(direct.status, 0)
    })
})

test("importing the package installs no process-wide error handlers", () => {
    const entry = pathToFileURL(path.join(root, "src", "index.js")).href
    const script = `await import(${JSON.stringify(entry)})\nconsole.log(process.listenerCount("uncaughtException"), process.listenerCount("unhandledRejection"))`
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "0 0")
})

test("run-slim finds the entry in an absolute dist folder", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "slim-out-"))
    try {
        withProject({ "slimconfig.json": JSON.stringify({ main: "index", dist: outside }), "index.slim": `log("ran")\n` }, dir => {
            assert.equal(run(dir, compiler).status, 0)
            const result = run(dir, runner)
            assert.equal(result.status, 0, result.stderr)
            assert.equal(result.stdout.trim(), "ran")
        })
    } finally {
        rmSync(outside, { recursive: true, force: true })
    }
})

test("CLI failures exit with an error code", () => {
    withProject({ "package.json": "{}", "slimconfig.json": JSON.stringify({ main: "missing/index" }) }, dir => {
        const created = run(dir, cli, ["create", "--server"])
        assert.equal(created.status, 1)
        assert.match(created.stderr, /Could not create slimserver\.json/)
        assert.doesNotMatch(created.stderr, /\n\s+at /)

        assert.doesNotMatch(run(dir, cli, ["server", "--help"]).stdout, /--hot/)
    })
})

async function stopServer(server) {
    if (!server) return
    server.ready.catch(() => {})
    if (server.proc.exitCode === null) {
        const exited = once(server.proc, "exit")
        server.proc.kill()
        await exited
    }
}

function startServer(dir, env = {}) {
    const proc = spawn(process.execPath, ["--no-warnings", path.join(dir, "slim-dist", "index.js")], { cwd: dir, env: { ...nodeEnv, ...env } })
    let output = ""
    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 15000)
        const read = chunk => {
            output += chunk
            if (/http:\/\/localhost:\d+/.test(output)) {
                clearTimeout(timer)
                resolve()
            }
        }
        proc.stdout.on("data", read)
        proc.stderr.on("data", read)
        proc.on("exit", code => {
            clearTimeout(timer)
            reject(new Error(`server exited with ${code}: ${output}`))
        })
    })
    return { proc, ready, output: () => output }
}

test("the server rejects bad requests, survives failing pages and serves only client files", async () => {
    const port = await freePort()
    const dir = project({
        "package.json": "{}",
        "slimconfig.json": "﻿" + JSON.stringify({ main: "index", clients: ["app"] }),
        "slimserver.json": JSON.stringify({
            port,
            redirects: [{ from: "/go", to: "https://example.com/a b" }],
            statics: [{ from: "/public", to: "./public" }]
        }),
        "public/my file.txt": "hello",
        "public/docs/index.html": "<h1>docs</h1>",
        "app.slim": `export component App(props) {\n    return <p>Hello \${props.params.name ?? "anon"}</p>\n}\n`,
        "index.slim": [
            `use { Server } from @slim/server`,
            `use { App } from "./app"`,
            `const server = new Server()`,
            `server.page("/", props => App(props), { hydrate: App, title: "</script><b>" })`,
            `server.page("/crash", () => { throw new Error("render crash") })`,
            `server.get("/boom", async (req, res) => { throw new Error("boom") })`,
            `server.get("/user/{id}", (req, res, params) => { res.end("user " + params.id) })`,
            `server.get("/{slug}", (req, res, params) => { res.end("slug " + params.slug) })`,
            `server.start()`,
            ``
        ].join("\n")
    })
    let server = null
    try {
        assert.equal(run(dir, compiler).status, 0)
        assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "slim-dist", ".slim-clients.json"), "utf8")).files, ["app.js"])

        server = startServer(dir)
        await server.ready
        const base = `http://localhost:${port}`
        const get = url => fetch(base + url, { redirect: "manual" })

        assert.equal((await get("/user/%E0%A4%A")).status, 400)
        assert.equal(await (await get("/user/a%20b")).text(), "user a b")
        assert.equal((await get("/crash")).status, 500)
        assert.equal((await get("/boom")).status, 500)
        assert.match(server.output(), /render crash/)

        const page = await get("/")
        assert.equal(page.status, 200)
        const html = await page.text()
        assert.match(html, /hydrate\(\(\) => App\(window\.__slimProps\)/)
        assert.doesNotMatch(html, /<\/script><b>/)

        assert.equal((await get("/__slim_reload__")).status, 404)

        const file = await get("/public/my%20file.txt")
        assert.equal(file.status, 200)
        assert.equal(await file.text(), "hello")
        assert.equal(await (await get("/public/docs/")).text(), "<h1>docs</h1>")
        assert.equal((await get("/public/%E0%A4%A")).status, 400)
        assert.equal((await get("/public/..%2f..%2fslimconfig.json")).status, 403)
        const missing = await get("/public/none.txt")
        assert.equal(missing.status, 404)
        assert.match(missing.headers.get("content-type"), /text\/plain/)

        const redirect = await get("/go")
        assert.equal(redirect.status, 302)
        assert.equal(redirect.headers.get("location"), "https://example.com/a%20b")

        assert.equal((await get("/@slim/app.js")).status, 200)
        assert.equal((await get("/@slim/external/runtime-dom.js")).status, 200)
        for (const hidden of ["/@slim/index.js", "/@slim/.slim-cache.json", "/@slim/.slim-clients.json", "/@slim/@slim/server.js", "/@slim/"]) {
            assert.equal((await get(hidden)).status, 404, hidden)
        }

        assert.equal(server.proc.exitCode, null)
    } finally {
        await stopServer(server)
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
})

test("a hydrated component is served with its imports without listing clients", async () => {
    const port = await freePort()
    const dir = project({
        "package.json": "{}",
        "slimconfig.json": JSON.stringify({ main: "index" }),
        "slimserver.json": JSON.stringify({ port }),
        "format.slim": `export func shout(text: string) -> string {\n    return text.toUpperCase()\n}\n`,
        "secret.slim": `export const key = "server-only"\n`,
        "app.slim": `use { shout } from "./format"\nexport const help = "import './secret.js'; export * from \\"./secret.js\\""\nexport component App(props) {\n    return <p>\${shout("hi")}</p>\n}\n`,
        "index.slim": [
            `use { Server } from @slim/server`,
            `use { App } from "./app"`,
            `use { key } from "./secret"`,
            `const server = new Server()`,
            `server.page("/", props => App(props), { hydrate: App })`,
            `server.get("/key", (req, res) => { res.end(key.length > 0 ? "ok" : "") })`,
            `server.get("/{slug}", (req, res, params) => { res.end("slug " + params.slug) })`,
            `server.start()`,
            ``
        ].join("\n")
    })
    let server = null
    try {
        assert.equal(run(dir, compiler).status, 0)
        const manifestFile = path.join(dir, "slim-dist", ".slim-clients.json")
        const manifest = JSON.parse(readFileSync(manifestFile, "utf8"))
        assert.deepEqual(manifest.graph["app.js"], ["format.js"])
        assert.deepEqual(manifest.graph["index.js"].filter(dep => !dep.startsWith("@slim/")), ["app.js", "secret.js"])
        assert.deepEqual(readdirSync(path.join(dir, "slim-dist")).filter(name => name.endsWith(".tmp")), [])

        server = startServer(dir, { SLIM_DEV: "1" })
        await server.ready
        const get = url => fetch(`http://localhost:${port}${url}`)
        assert.match(await (await get("/")).text(), /hydrate\(\(\) => App\(window\.__slimProps\)/)
        assert.equal((await get("/@slim/app.js")).status, 200)
        assert.equal((await get("/@slim/format.js")).status, 200)
        assert.equal((await get("/@slim/external/runtime-dom.js")).status, 200)
        for (const hidden of ["/@slim/index.js", "/@slim/secret.js", "/@slim/.slim-cache.json"]) {
            assert.equal((await get(hidden)).status, 404, hidden)
        }

        const reload = new AbortController()
        const events = await fetch(`http://localhost:${port}/__slim_reload__`, { signal: reload.signal })
        assert.match(events.headers.get("content-type"), /text\/event-stream/)
        reload.abort()

        writeFileSync(manifestFile, "{ broken")
        assert.equal((await get("/@slim/app.js")).status, 500)
        assert.equal((await get("/@slim/app.js")).status, 500)
        assert.equal(await (await get("/key")).text(), "ok")
        writeFileSync(manifestFile, JSON.stringify(manifest))
        assert.equal((await get("/@slim/app.js")).status, 200)
        assert.equal(server.proc.exitCode, null)
    } finally {
        await stopServer(server)
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
})

test("page loaders fill the store a hydrated component reads", async () => {
    const port = await freePort()
    const dir = project({
        "package.json": "{}",
        "slimconfig.json": JSON.stringify({ main: "index" }),
        "slimserver.json": JSON.stringify({ port }),
        "app.slim": `export component Profile(props) {\n    const user = provideData("user", () => "nobody")\n    const theme = provideData("theme", () => "light")\n    return <p>\${user} \${theme}</p>\n}\n`,
        "index.slim": [
            `use { Server } from @slim/server`,
            `use { Profile } from "./app"`,
            `const server = new Server()`,
            `server.page("/user/{id}", props => Profile(props), {`,
            `    hydrate: Profile,`,
            `    load: [async ({ params }) => ({ user: "user " + params.id }), () => ({ theme: "dark" }), () => 5]`,
            `})`,
            `server.start()`,
            ``
        ].join("\n")
    })
    let server = null
    try {
        assert.equal(run(dir, compiler).status, 0)
        server = startServer(dir, {})
        await server.ready
        const html = await (await fetch(`http://localhost:${port}/user/7`)).text()
        assert.match(html.replace(/<!--[^>]*-->/g, ""), /<p>user 7 dark<\/p>/)
        assert.match(html, /__slimStore = JSON\.parse\(.*user 7.*dark/)
        assert.equal(server.proc.exitCode, null)
    } finally {
        await stopServer(server)
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
})

test("static files: mounts, ranges, types, caching, redirects, methods and body limits", async () => {
    const port = await freePort()
    const dir = project({
        "package.json": "{}",
        "slimconfig.json": JSON.stringify({ main: "index" }),
        "slimserver.json": JSON.stringify({
            port,
            bodyLimit: 64,
            statics: [{ from: "/assets/", to: "./assets" }, { from: "/", to: "./site" }]
        }),
        "assets/digits.txt": "0123456789",
        "assets/mod.wasm": "\0asm\x01\0\0\0",
        "assets/docs/index.html": "<h1>docs</h1>",
        "site/robots.txt": "robots",
        "index.slim": [
            `use { Server } from @slim/server`,
            `const server = new Server()`,
            `server.page("/page", () => "<p>page</p>", { head: ["/assets/style.css?v=2", "/assets/app.js#main"] })`,
            `server.api("/echo", async data => data)`,
            `server.api("/small", async data => data, { limit: 4 })`,
            `server.start()`,
            ``
        ].join("\n")
    })
    let server = null
    try {
        assert.equal(run(dir, compiler).status, 0)
        server = startServer(dir)
        await server.ready
        const base = `http://localhost:${port}`
        const get = (url, headers = {}) => fetch(base + url, { headers, redirect: "manual" })

        assert.equal(await (await get("/robots.txt")).text(), "robots")
        assert.equal(await (await get("/assets/digits.txt")).text(), "0123456789")

        const partial = await get("/assets/digits.txt", { Range: "bytes=2-4" })
        assert.equal(partial.status, 206)
        assert.equal(partial.headers.get("content-range"), "bytes 2-4/10")
        assert.equal(await partial.text(), "234")
        const suffix = await get("/assets/digits.txt", { Range: "bytes=-3" })
        assert.equal(await suffix.text(), "789")
        const outside = await get("/assets/digits.txt", { Range: "bytes=20-" })
        assert.equal(outside.status, 416)
        assert.equal(outside.headers.get("content-range"), "bytes */10")

        const full = await get("/assets/digits.txt")
        assert.equal(full.headers.get("cache-control"), "no-cache")
        assert.equal(full.headers.get("accept-ranges"), "bytes")
        const etag = full.headers.get("etag")
        assert.ok(etag)
        assert.equal((await get("/assets/digits.txt", { "If-None-Match": etag })).status, 304)

        const wasm = await get("/assets/mod.wasm")
        assert.equal(wasm.headers.get("content-type"), "application/wasm")

        const folder = await get("/assets/docs?x=1")
        assert.equal(folder.status, 301)
        assert.equal(folder.headers.get("location"), "/assets/docs/?x=1")
        assert.equal(await (await get("/assets/docs/")).text(), "<h1>docs</h1>")

        const head = await fetch(base + "/assets/digits.txt", { method: "HEAD" })
        assert.equal(head.status, 200)
        assert.equal(head.headers.get("content-length"), "10")

        const page = await (await get("/page")).text()
        assert.match(page, /style\.css\?v=2/)
        assert.match(page, /app\.js#main/)

        const posted = await fetch(base + "/page", { method: "POST" })
        assert.equal(posted.status, 405)
        assert.equal(posted.headers.get("allow"), "GET, HEAD")
        assert.equal((await fetch(base + "/assets/digits.txt", { method: "DELETE" })).status, 405)

        const echoed = await fetch(base + "/echo", { method: "POST", body: JSON.stringify({ a: 1 }) })
        assert.deepEqual(await echoed.json(), { a: 1 })
        assert.equal((await fetch(base + "/echo", { method: "POST", body: JSON.stringify({ text: "x".repeat(100) }) })).status, 413)
        assert.equal((await fetch(base + "/small", { method: "POST", body: "12345" })).status, 413)

        assert.equal((await get("/__slim_reload__")).status, 404)
        assert.equal(server.proc.exitCode, null)
    } finally {
        await stopServer(server)
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
})

const caseInsensitive = process.platform === "win32" || process.platform === "darwin"

test("a case-only rename keeps the new output, and one file imported with two spellings is one module", { skip: !caseInsensitive }, () => {
    withProject({
        "slimconfig.json": JSON.stringify({ main: "index" }),
        "Lib.slim": "export const x = 1\n",
        "other.slim": `use { x } from "./Lib"\nexport const y = x + 1\n`,
        "index.slim": `use { x } from "./lib"\nuse { y } from "./other"\nlog(x, y)\n`
    }, dir => {
        const built = run(dir, compiler)
        assert.equal(built.status, 0, built.stderr)
        const imports = ["index.js", "other.js"].map(name => readFileSync(path.join(dir, "slim-dist", name), "utf8").match(/from "\.\/(lib|Lib)\.js"/i)[1])
        assert.deepEqual(imports, ["Lib", "Lib"])

        renameSync(path.join(dir, "Lib.slim"), path.join(dir, "tmp.slim"))
        renameSync(path.join(dir, "tmp.slim"), path.join(dir, "lib.slim"))
        const rebuilt = run(dir, compiler)
        assert.equal(rebuilt.status, 0, rebuilt.stderr)
        assert.ok(readdirSync(path.join(dir, "slim-dist")).includes("lib.js"))
        const ran = spawnSync(process.execPath, ["--no-warnings", path.join(dir, "slim-dist", "index.js")], { cwd: dir, encoding: "utf8", env: nodeEnv })
        assert.equal(ran.stdout.trim(), "1 2", ran.stderr)
    })
})

test("a dist folder that differs from the project folder only in case is refused", { skip: !caseInsensitive }, () => {
    const parent = mkdtempSync(path.join(tmpdir(), "slim-case-"))
    try {
        const dir = path.join(parent, "Proj")
        write(dir, "slimconfig.json", JSON.stringify({ main: "index", dist: "../proj" }))
        write(dir, "index.slim", "log(1)\n")
        const result = run(dir, compiler)
        assert.equal(result.status, 1)
        assert.match(result.stderr, /is the project folder or contains it/)
        assert.ok(existsSync(path.join(dir, "index.slim")))
    } finally {
        rmSync(parent, { recursive: true, force: true })
    }
})

test("the server refuses to hydrate a module the build never produced, and reports a broken slimserver.json", () => {
    withProject({
        "package.json": "{}",
        "slimconfig.json": JSON.stringify({ main: "index" }),
        "slimserver.json": JSON.stringify({ port: 1 }),
        "widget.slim": `export component Widget() {\n    return <p>hi</p>\n}\n`,
        "index.slim": `use { Server } from @slim/server\nconst server = new Server()\nserver.page("/", () => "<p>hi</p>", { hydrate: "widget:Widget" })\n`
    }, dir => {
        assert.equal(run(dir, compiler).status, 0)
        const entry = path.join(dir, "slim-dist", "index.js")
        const refused = spawnSync(process.execPath, ["--no-warnings", entry], { cwd: dir, encoding: "utf8", env: nodeEnv })
        assert.notEqual(refused.status, 0)
        assert.match(refused.stderr, /was not found in the build .*add its \.slim source to "clients"/)

        write(dir, "slimserver.json", `{ "port": 1, }`)
        const broken = spawnSync(process.execPath, ["--no-warnings", entry], { cwd: dir, encoding: "utf8", env: nodeEnv })
        assert.notEqual(broken.status, 0)
        assert.match(broken.stderr, /slimserver\.json is not valid JSON/)
    })
})

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = createServer()
        probe.once("error", reject)
        probe.listen(0, () => {
            const { port } = probe.address()
            probe.close(() => resolve(port))
        })
    })
}

test("the core modules are imported from @slim and nothing else is global", () => {
    withProject({
        "package.json": JSON.stringify({ name: "core-modules", type: "module" }),
        "slimconfig.json": JSON.stringify({ main: "index" }),
        "index.slim": `use { createForm } from @slim/forms
use { matchRoute, navigate } from @slim/router
struct Signup {
    name: string
}
const form = createForm(Signup)
log(typeof form.submit, typeof navigate, matchRoute("/users/:id", "/users/7")?.id)
`
    }, dir => {
        const ran = run(dir, cli, ["run"])
        assert.equal(ran.status, 0, ran.stderr + ran.stdout)
        assert.match(ran.stdout, /function function 7/)
        assert.ok(existsSync(path.join(dir, "slim-dist", "@slim", "router.js")))

        write(dir, "index.slim", `use { positive } from @slim/types/numerical\nlet p: positive = 1\n`)
        const missing = run(dir, compiler)
        assert.notEqual(missing.status, 0)
        assert.match(missing.stdout + missing.stderr, /Slim has no module "@slim\/types\/numerical" — its modules are @slim\/forms, @slim\/router, @slim\/server, @slim\/test; the standard library is @std/)

        for (const name of ["test", "assert", "createForm", "Router", "navigate", "PI"]) {
            write(dir, "index.slim", `log(typeof ${name}, ${name})\n`)
            const unknown = run(dir, compiler)
            assert.notEqual(unknown.status, 0, name)
            assert.match(unknown.stdout + unknown.stderr, new RegExp(`"${name}" is not defined`), name)
        }

        write(dir, "index.slim", `log(1)\n`)
        write(dir, "math.test.slim", `test("adds", () => { assertEqual(1 + 1, 2) })\ndescribe("group", () => { test("inner", () => { assert(true) }) })\n`)
        const tested = run(dir, cli, ["test"])
        assert.equal(tested.status, 0, tested.stdout + tested.stderr)
        assert.match(tested.stdout, /2 passed, 0 failed/)
    })
})

test("a catch-all page answers every path that no route, API or static file takes", async () => {
    const port = await freePort()
    const dir = project({
        "package.json": "{}",
        "slimconfig.json": JSON.stringify({ main: "index" }),
        "slimserver.json": JSON.stringify({ port, statics: [{ from: "/public", to: "./public" }] }),
        "public/a.txt": "static",
        "index.slim": [
            `use { Server } from @slim/server`,
            `const server = new Server()`,
            `server.page("/{...path}", props => <p>page \${props.params.path}</p>)`,
            `server.api("/api/echo", async data => ({ echo: data }))`,
            `server.get("/user/{id}", (req, res, params) => { res.end("user " + params.id) })`,
            `server.start()`,
            ``
        ].join("\n")
    })
    let server = null
    try {
        assert.equal(run(dir, compiler).status, 0)
        server = startServer(dir)
        await server.ready
        const base = `http://localhost:${port}`
        assert.match(await (await fetch(base + "/projects/7/files")).text(), /page projects\/7\/files/)
        assert.match(await (await fetch(base + "/")).text(), /page <!--\[-->|page </)
        assert.equal(await (await fetch(base + "/user/3")).text(), "user 3")
        assert.equal(await (await fetch(base + "/public/a.txt")).text(), "static")
        const api = await fetch(base + "/api/echo", { method: "POST", body: JSON.stringify({ a: 1 }) })
        assert.deepEqual(await api.json(), { echo: { a: 1 } })
    } finally {
        await stopServer(server)
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
})
