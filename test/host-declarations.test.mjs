import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import os from "node:os"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"

const root = process.cwd()
const compiler = path.join(root, "src", "compile.js")

function project(files, config, inspect) {
    const dir = path.join(os.tmpdir(), `slim-host-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })

    try {
        writeFileSync(path.join(dir, "slimconfig.json"), JSON.stringify({ main: "index", ...config }))
        writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }')
        for (const [name, source] of Object.entries(files)) {
            mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
            writeFileSync(path.join(dir, name), source)
        }

        const built = spawnSync(process.execPath, [compiler], { cwd: dir, encoding: "utf8" })
        const output = built.stdout + built.stderr
        const run = () => spawnSync(process.execPath, ["--no-warnings", "slim-dist/index.js"], { cwd: dir, encoding: "utf8" })
        return inspect({ dir, status: built.status, output, run })
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

const HOST = `
trait Vec3 { x: number, y: number, z: number }

trait World {
    setBlock(x: int, y: int, z: int, id: int) -> void
    position() -> Vec3
}

type BlockId = int

global world: World
global let tickRate: int
`

const compiles = source => transform(source, path.join(root, "__host_tests__", "input.slim"), { warnings: false })

test("global gives a host value a type and leaves nothing in the output", () => {
    const { code } = transform(`trait W { size() -> int }\nglobal world: W\nconst n: int = world.size()`, "input.slim", { sourceMaps: false, warnings: false })
    assert.doesNotMatch(code, /__declare_value__/)
    assert.doesNotMatch(code, /const world/)
})

test("a declared value is checked like a typed one", () => {
    const declared = `trait W { setBlock(x: int) -> bool }\nglobal world: W\n`
    assert.throws(() => compiles(`${declared}world.setBlock("a")`), /argument "x" of "W.setBlock" expects int, got string/)
    assert.throws(() => compiles(`${declared}world.setBlock()`), /"W.setBlock" expects 1 argument/)
    assert.throws(() => compiles(`${declared}world.setBlok(1)`), /did you mean "setBlock"/)
    assert.throws(() => compiles(`${declared}const s: string = world.setBlock(1)`), /"s" expects string, got bool/)
})

test("a call through a function-typed field is checked like a method", () => {
    const declared = `trait T { days: () -> number\n spawn: (name: string, scale?: number) => void }\nglobal time: T\n`.replace("() -> number", "() => number")
    assert.doesNotThrow(() => compiles(`${declared}const d: number = time.days()\ntime.spawn("a")\ntime.spawn("a", 2)`))
    assert.throws(() => compiles(`${declared}time.spawn(1)`), /argument "name" of "T.spawn" expects string, got int/)
    assert.throws(() => compiles(`${declared}time.spawn()`), /"T.spawn" expects 1 argument, got 0/)
    assert.throws(() => compiles(`${declared}time.spawn("a", 2, 3)`), /"T.spawn" takes 2 arguments, got 3/)
    assert.throws(() => compiles(`${declared}time.days(1)`), /"T.days" takes 0 arguments, got 1/)
    assert.throws(() => compiles(`${declared}const s: string = time.days()`), /"s" expects string, got number/)
})

test("a declared function value is checked at the call", () => {
    const declared = `global wait: (ms: int) => bool\n`
    assert.doesNotThrow(() => compiles(`${declared}const done: bool = wait(5)`))
    assert.throws(() => compiles(`${declared}wait("soon")`), /argument "ms" of "wait" expects int, got string/)
})

test("a trait fits another trait that needs less of it", () => {
    const traits = `trait Vec3 { x: number, y: number, z: number }\ntrait Flat { x: number, z: number }\ntrait Named { name: string }\nfunc flat(p: Flat) -> number { return p.x }\nfunc named(n: Named) -> string { return n.name }\n`
    const value = `global here: Vec3\n`
    assert.doesNotThrow(() => compiles(`${traits}${value}flat(here)`))
    assert.throws(() => compiles(`${traits}${value}named(here)`), /expects Named, got Vec3/)
    assert.doesNotThrow(() => compiles(`trait A { next: B }\ntrait B { next: A }\ntrait C { next: D }\ntrait D { next: C }\nfunc f(a: A) -> A { return a }\nglobal c: C\nf(c)`))
})

test("a local name wins over a declared one", () => {
    assert.doesNotThrow(() => compiles(`trait W { size() -> int }\nglobal world: W\nfunc f(world: string) -> string { return world }`))
})

test("global is refused where it can't mean anything", () => {
    assert.throws(() => compiles(`global world`), /"world" needs a type/)
    assert.throws(() => compiles(`func f() { global world: int }`), /global belongs at the top level/)
    assert.throws(() => compiles(`global a: int, b: int`), /global takes one name/)
    assert.throws(() => compiles(`export global a: int`), /global belongs at the top level/)
})

test("a host file types every file of the project", () => {
    const files = {
        "host.slim": HOST,
        "index.slim": `use { edge } from "./lib/edge"\nglobalThis.world = { setBlock() {}, position() { return { x: 1, y: 2, z: 3 } } }\nlog(edge())`,
        "lib/edge.slim": `export func edge() -> number { world.setBlock(1, 2, 3, 4); return world.position().x }`
    }
    project(files, { host: "host" }, ({ status, output, run }) => {
        assert.equal(status, 0, output)
        const result = run()
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /^1$/m)
    })
})

test("a mistake against the host file fails the build", () => {
    const files = { "host.slim": HOST, "index.slim": `world.setBlock(1, 2, 3, "stone")` }
    project(files, { host: "host" }, ({ status, output }) => {
        assert.notEqual(status, 0)
        assert.match(output, /argument "id" of "World.setBlock" expects int, got string/)
    })
})

test("traits and aliases of the host file work as annotations and at runtime", () => {
    const files = {
        "host.slim": HOST,
        "index.slim": `func height(v: Vec3) -> number { return v.y }\nconst id: BlockId = 7\nlog(height({ x: 1, y: 5, z: 2 }), id)\ntry { height({ x: 1 } as any) } catch (e) { log("rejected") }`
    }
    project(files, { host: "host" }, ({ status, output, run }) => {
        assert.equal(status, 0, output)
        const result = run()
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /5 7/)
        assert.match(result.stdout, /rejected/)
    })
})

test("declarations of a file stay in that file without a host", () => {
    const files = {
        "lib.slim": `global world: string\nexport func name() -> string { return world }`,
        "index.slim": `use { name } from "./lib"\nlog(world)`
    }
    project(files, {}, ({ status, output }) => {
        assert.notEqual(status, 0)
        assert.match(output, /"world" is not defined/)
    })
})

test("a missing host file is reported by name", () => {
    project({ "index.slim": `log(1)` }, { host: "types/none" }, ({ status, output }) => {
        assert.notEqual(status, 0)
        assert.match(output, /none\.slim/)
    })
})

test("transform reads the host file without a build, and again when it changes", () => {
    const dir = path.join(os.tmpdir(), `slim-host-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    const host = path.join(dir, "host.slim")
    const file = path.join(dir, "index.slim")
    const options = { host, warnings: false, outFile: path.join(dir, "out", "index.js") }

    try {
        writeFileSync(host, `global speed: int`)
        assert.doesNotThrow(() => transform(`const n: int = speed`, file, options))
        writeFileSync(host, `global speed: string`, { flush: true })
        const later = new Date(Date.now() + 5000)
        spawnSync(process.execPath, ["-e", `require("fs").utimesSync(${JSON.stringify(host)}, new Date(${later.getTime()}), new Date(${later.getTime()}))`])
        assert.throws(() => transform(`const n: int = speed`, file, options), /"n" expects int, got string/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("a host with only console.log still gets errors and warnings", () => {
    const runtime = pathToFileURL(path.join(root, "src", "external", "runtime-core.js")).href
    const script = `
        const proc = globalThis.process
        delete globalThis.process
        delete console.error
        delete console.warn
        delete console.info
        const lines = []
        console.log = line => lines.push(String(line))
        const { __handle_sync_error__, warn } = await import(${JSON.stringify(runtime)})
        let rethrown = null
        try {
            __handle_sync_error__(new Error("boom"))
        } catch (error) {
            rethrown = error.message
        }
        warn("careful")
        proc.stdout.write(JSON.stringify({ lines, rethrown }))
    `
    const result = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    const { lines, rethrown } = JSON.parse(result.stdout)
    assert.match(lines.join("\n"), /boom/)
    assert.match(lines.join("\n"), /careful/)
    assert.equal(rethrown, "boom")
})

test("an import without names builds the Slim file it points at", () => {
    const files = {
        "index.slim": `import "./side.js"\nimport "./nested/deep.js"\nlog("main")`,
        "side.slim": `log("side")`,
        "nested/deep.slim": `log("deep")`
    }
    project(files, {}, ({ status, output, run }) => {
        assert.equal(status, 0, output)
        assert.equal(run().stdout.trim().split(/\r?\n/).join(" "), "side deep main")
    })
})

test("an import without names leaves a plain JavaScript file alone", () => {
    const files = { "index.slim": `import "./plain.js"\nlog("main")` }
    project(files, {}, ({ dir, status, output }) => {
        assert.equal(status, 0, output)
        assert.match(readFileSync(path.join(dir, "slim-dist", "index.js"), "utf8"), /import "\.\/plain\.js"/)
        assert.equal(existsSync(path.join(dir, "slim-dist", "plain.js")), false)
    })
})

test("a global is read and written through globalThis, and a missing optional one is undefined", async () => {
    await import("../src/external/core.js")
    const { code } = transform(`trait Kit { spawn: () => string }\nglobal let kit?: Kit\nglobal world: string\nlog(typeof kit, kit?.spawn() ?? "none")\nkit = { spawn: () => "ok" }\nlog(kit?.spawn(), world)\n{\n    const world = 1\n    log(world)\n}`, "input.slim", { sourceMaps: false, warnings: false })
    assert.match(code, /globalThis\.kit = \{/)
    assert.match(code, /log\(globalThis\.kit\?\.spawn\(\), globalThis\.world\)/)
    assert.match(code, /log\(world\);/)
    const run = new Function("log", code.replace(/^import[^\n]*\n/, "").replace(/try \{|\} catch \(__err__\) \{[\s\S]*$/g, ""))
    const lines = []
    globalThis.world = "earth"
    try {
        run((...args) => lines.push(args.join(" ")))
    } finally {
        delete globalThis.kit
        delete globalThis.world
    }
    assert.deepEqual(lines, ["undefined none", "ok earth", "1"])
})

test("the old declare form points to global", () => {
    assert.throws(() => compiles(`declare ${"const"} world: int`), /Write "global world: Type" instead of "declare"/)
})

test("the declared type of an exported variable follows it into the files that import it", () => {
    const files = {
        "lib/kit.slim": `export const limit: int = 10`,
        "index.slim": `use { limit } from "./lib/kit"\nconst label: string = limit\nlog(label)`
    }
    project(files, {}, ({ status, output }) => {
        assert.notEqual(status, 0)
        assert.match(output, /"label" expects string, got int/)
    })
})

test("the router module has types for its components and functions", () => {
    const cases = [
        [`<Router routes=\${routes} kepp />`, /"RouterProps" has no prop "kepp" — did you mean "keep"\?/],
        [`<Router routes=\${routes} max="3" />`, /prop "max" of "RouterProps" expects \(int \| undefined\)/],
        [`<Link>home</Link>`, /"LinkProps" is missing prop "href"/]
    ]
    for (const [markup, error] of cases) {
        const files = { "index.slim": `use { Router, Link } from @slim/router\nconst routes = { "/": 1 }\ncomponent App() {\n    return <main>${markup}</main>\n}\nlog(App)` }
        project(files, {}, ({ status, output }) => {
            assert.notEqual(status, 0)
            assert.match(output, error)
        })
    }
    project({ "index.slim": `use { navigate } from @slim/router\nnavigate(5)` }, {}, ({ status, output }) => {
        assert.notEqual(status, 0)
        assert.match(output, /argument "to" of "navigate" expects string, got int/)
    })
    project({ "index.slim": `use { Router, Link, navigate, route } from @slim/router\nconst routes = { "/": 1 }\ncomponent App() {\n    return <main><Link href="/" active="on" prefix>H</Link><Router routes=\${routes} keep max=\${2} intercept ignore=".x" /></main>\n}\nlog(typeof App, typeof navigate, typeof route)` }, {}, ({ status, output }) => {
        assert.equal(status, 0, output)
    })
})

test("autoImport imports a component that is used only as a tag in markup", () => {
    const files = {
        "lib/badge.slim": `export component Badge({ n }) {\n    return <b>\${n}</b>\n}`,
        "index.slim": `component App() {\n    return <div><Badge n=\${1} /></div>\n}\nlog(typeof App)`
    }
    project(files, { autoImport: true }, ({ dir, status, output }) => {
        assert.equal(status, 0, output)
        assert.match(readFileSync(path.join(dir, "slim-dist", "index.js"), "utf8"), /import \{ Badge \} from "\.\/lib\/badge\.js"/)
    })
})
