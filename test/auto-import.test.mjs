import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { transform } from "../src/transform.js"
import { projectExports } from "../src/autoImport.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const compiler = path.join(root, "src", "compile.js")

function project(files, config = { main: "index", autoImport: true }) {
    const dir = outputFolder(`__auto_${Math.random().toString(36).slice(2)}__`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "slimconfig.json"), JSON.stringify(config))
    for (const [name, source] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
        writeFileSync(path.join(dir, name), source)
    }
    return dir
}

function run(dir, ...args) {
    const result = spawnSync(process.execPath, [compiler, ...args], { cwd: dir, encoding: "utf8" })
    return { status: result.status, output: result.stdout + result.stderr }
}

const FILES = {
    "models/user.slim": `export struct User {\n    name: string\n}\n\nexport func greet(user: User) -> string {\n    return "Hi " + user.name\n}\n`,
    "ui/badge.slim": `export component Badge(props) {\n    return <b>\${props.text}</b>\n}\n`,
    "index.slim": `const user = User.new({ name: "Ada" })\nlog(greet(user), Badge({ text: "x" }).outerHTML)\n`
}

test("names exported by project files are imported where they are used", () => {
    const dir = project(FILES)
    try {
        const built = run(dir)
        assert.equal(built.status, 0, built.output)
        const ran = spawnSync(process.execPath, ["--no-warnings", path.join(dir, "slim-dist", "index.js")], { cwd: dir, encoding: "utf8" })
        assert.equal(ran.status, 0, ran.stderr)
        assert.equal(ran.stdout.trim(), "Hi Ada <b>x</b>")
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("auto-imported signatures are checked", () => {
    const dir = project({ ...FILES, "index.slim": `let n: int = greet(User.new({ name: "Ada" }))\n` })
    try {
        const built = run(dir)
        assert.notEqual(built.status, 0)
        assert.match(built.output, /"n" expects int, got string/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("without autoImport the names stay undefined", () => {
    const dir = project(FILES, { main: "index" })
    try {
        const built = run(dir)
        assert.notEqual(built.status, 0)
        assert.match(built.output, /"User" is not defined/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("a state another file only assigns is imported too", () => {
    const dir = project({
        "store.slim": `export state count = 1

export func show() -> int {
    return count
}
`,
        "writer.slim": `export func bump() {
    count = 10
    count++
}
`,
        "index.slim": `bump()
log(show())
`
    })
    try {
        const built = run(dir)
        assert.equal(built.status, 0, built.output)
        const ran = spawnSync(process.execPath, ["--no-warnings", path.join(dir, "slim-dist", "index.js")], { cwd: dir, encoding: "utf8" })
        assert.equal(ran.status, 0, ran.stderr)
        assert.equal(ran.stdout.trim(), "11")
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("transform takes an exports index", () => {
    const dir = project(FILES)
    try {
        const index = projectExports(dir)
        assert.equal(index.get("User"), path.join(dir, "models", "user.slim"))
        const { code } = transform(FILES["index.slim"], path.join(dir, "index.slim"), { autoImport: index, outFile: path.join(dir, "out", "index.js") })
        assert.match(code, /import \{ User, greet \} from "[^"]*models\/user\.js"/)
        assert.match(code, /import \{ Badge \} from "[^"]*ui\/badge\.js"/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("a project export named like a built-in type isn't imported for an annotation", () => {
    const dir = project({
        "converters.slim": `export func int(v: any) -> int { return 1 }\nexport func string(v: any) -> string { return "" }\nexport func bool(v: any) -> bool { return true }\n`,
        "index.slim": `let n: int = 1\nfunc same(s: string) -> bool { return s == s }\nlog(n, same("a"))\n`
    })
    try {
        const index = projectExports(dir)
        assert.equal(index.get("int"), path.join(dir, "converters.slim"))
        const { code } = transform(`let n: int = 1\nfunc same(s: string) -> bool { return s == s }\nlog(n, same("a"))\n`, path.join(dir, "index.slim"), { autoImport: index, outFile: path.join(dir, "out", "index.js") })
        assert.doesNotMatch(code, /converters\.js/)
        const called = transform(`log(int("3"))\n`, path.join(dir, "index.slim"), { autoImport: index, outFile: path.join(dir, "out", "index.js") })
        assert.match(called.code, /import \{ int \} from "[^"]*converters\.js"/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("the packages folder is not scanned for auto-imports", () => {
    const dir = project({
        "packages/kit/main.slim": `export func shout(s: string) -> string { return s.toUpperCase() }\n`,
        "packages/kit/extra.slim": `export func kitOnly() -> int { return 1 }\n`,
        "index.slim": `use { shout } from @kit\nlet n: int = 2\nlog(shout("a"), n, kitOnly())\n`
    })
    try {
        const built = run(dir)
        assert.notEqual(built.status, 0)
        assert.match(built.output, /"kitOnly" is not defined/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("a local binding wins over a project export, and a name two files export is left alone", () => {
    const dir = project({
        "a.slim": `export const shared = 1\nexport const twice = 1\n`,
        "b.slim": `export const twice = 2\n`,
        "index.slim": `const shared = 5\nlog(shared, typeof twice)\n`
    })
    try {
        const index = projectExports(dir)
        assert.equal(index.get("twice"), null)
        const { code } = transform(`const shared = 5\nlog(shared, typeof twice)\n`, path.join(dir, "index.slim"), { autoImport: index, check: false })
        assert.doesNotMatch(code, /from "[^"]*\/(a|b)\.js"/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("a project export named like a browser global is not imported, with a warning", () => {
    const dir = project({
        "models.slim": `export struct File {\n    name: string\n}\nexport struct Notification {\n    text: string\n}\nexport func size() -> int { return 1 }\n`,
        "index.slim": `func check(b: any) -> bool {\n    return b instanceof File\n}\nlog(check(1), size())\n`
    })
    try {
        const index = projectExports(dir)
        const source = `func check(b: any) -> bool {\n    return b instanceof File\n}\nconst n: Notification = null\nlog(check(1), size(), n)\n`
        const { code, warnings } = transform(source, path.join(dir, "index.slim"), { autoImport: index, outFile: path.join(dir, "out", "index.js"), check: false })
        assert.match(code, /import \{ size \} from "[^"]*models\.js"/)
        assert.doesNotMatch(code, /import \{[^}]*\b(File|Notification)\b/)
        const messages = warnings.map(warning => warning.message)
        assert.ok(messages.some(message => /"File" is a browser global, so it is not auto-imported from "\.\/models"/.test(message)), messages.join("\n"))
        assert.ok(messages.some(message => /"Notification" is a browser global/.test(message)), messages.join("\n"))
        assert.equal(warnings.find(warning => warning.message.includes('"File"')).line, 2)
        const used = transform(`use { File } from "./models"\nlog(File.new({ name: "a" }).name)\n`, path.join(dir, "index.slim"), { autoImport: index, outFile: path.join(dir, "out", "index.js") })
        assert.equal(used.warnings.length, 0)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("a name used only after typeof is not imported", () => {
    const dir = project({
        "calls.slim": `export component YurbaCall() {\n    return <b>call</b>\n}\nexport func ring() -> int { return 1 }\n`,
        "index.slim": `if (typeof YurbaCall != "undefined") log("calls")\nlog(typeof ring == "function" ? ring() : 0)\n`
    })
    try {
        const index = projectExports(dir)
        const { code } = transform(`if (typeof YurbaCall != "undefined") log("calls")\nlog(typeof ring == "function" ? ring() : 0)\n`, path.join(dir, "index.slim"), { autoImport: index, outFile: path.join(dir, "out", "index.js") })
        assert.match(code, /import \{ ring \} from "[^"]*calls\.js"/)
        assert.doesNotMatch(code, /YurbaCall \}/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("a custom tag in markup or createElement imports the module that defines it", () => {
    const dir = project({
        "ui/navbar.slim": `element("y-navbar") component Navbar() {\n    return <nav>menu</nav>\n}\n`,
        "ui/box.slim": `element component Box() {\n    return <div>box</div>\n}\nexport func boxed() -> int { return 1 }\n`,
        "ui/legacy.slim": `customElements.define("old-card", class extends HTMLElement {})\n`,
        "index.slim": `component Page() {\n    return <main><y-navbar></y-navbar></main>\n}\nconst box = document.createElement("slim-box")\nconst card = document.createElement("old-card")\nlog(boxed())\n`
    })
    try {
        const index = projectExports(dir)
        assert.equal(index.get("<y-navbar>"), path.join(dir, "ui", "navbar.slim"))
        assert.equal(index.get("<slim-box>"), path.join(dir, "ui", "box.slim"))
        assert.equal(index.get("<old-card>"), path.join(dir, "ui", "legacy.slim"))
        const source = `component Page() {\n    return <main><y-navbar title="x"></y-navbar></main>\n}\nconst box = document.createElement("slim-box")\nconst card = document.createElement("old-card")\nlog(boxed(), Page, box, card)\n`
        const { code } = transform(source, path.join(dir, "index.slim"), { autoImport: index, outFile: path.join(dir, "out", "index.js") })
        assert.match(code, /import "[^"]*ui\/navbar\.js"/)
        assert.match(code, /import "[^"]*ui\/legacy\.js"/)
        assert.match(code, /import \{ boxed \} from "[^"]*ui\/box\.js"/)
        assert.doesNotMatch(code, /import "[^"]*ui\/box\.js"/)
        const built = run(dir)
        assert.equal(built.status, 0, built.output)
        assert.ok(existsSync(path.join(dir, "slim-dist", "ui", "navbar.js")))
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
