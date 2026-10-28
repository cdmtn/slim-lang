import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"

const root = process.cwd()
const outputDir = path.join(root, "dist", "__feature_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function compile(name, source, options = {}) {
    mkdirSync(outputDir, { recursive: true })
    const file = path.join(outputDir, `${name}.js`)
    const { code } = transform(source, path.join(root, "__feature_tests__", `${name}.slim`), { outFile: file, ...options })
    writeFileSync(file, code.replace(/^import\s+[^;]*(?:defaults|core)\.js";$/m, `import ${JSON.stringify(runtimeImport)};`))
    return { file, code }
}

function run(name, source, options) {
    const { file } = compile(name, source, options)
    return spawnSync(process.execPath, ["--no-warnings", file], { cwd: root, encoding: "utf8" })
}

function staticError(source) {
    try {
        transform(source, path.join(root, "__feature_tests__", "static.slim"))
    } catch (error) {
        return error.message
    }
    return null
}

test("component interpolation escapes text and keeps markup", () => {
    const result = run("escape", `
        component Card(props) {
            const title = props.title ? <h2>\${props.title}</h2> : ""
            return <section title=\${props.title}>
                \${title}
                <ul>\${props.items.map(item => <li>\${item}</li>)}</ul>
                <p>see http://example.com, you and me</p>
                \${raw("<i>trusted</i>")}
            </section>
        }
        log(Card({ title: "<b>x</b>", items: ["a&b", 2] }).outerHTML)
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /title="<b>x<\/b>"/)
    assert.match(result.stdout, /<h2>&lt;b&gt;x&lt;\/b&gt;<\/h2>/)
    assert.match(result.stdout, /<li>a&amp;b<\/li><li>2<\/li>/)
    assert.match(result.stdout, /see http:\/\/example\.com, you and me/)
    assert.match(result.stdout, /<i>trusted<\/i>/)
})

test("generic structs check their type arguments", () => {
    const result = run("generics", `
        struct Box<T> {
            value: T
            tags: string[] = [
                "a",
                "b"
            ]
        }
        const box: Box<int> = { value: 1, tags: [] }
        log(box.value, Box.new({ value: "any" }).tags.join(","))
        try { const bad: Box<int> = JSON.parse('{"value":"x","tags":[]}') } catch (e) { log("rejected") }
        log(Box.verifySafe({ value: "x", tags: [] }, ["int"]).success)
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "1 a,b\nrejected\nfalse")
    assert.match(staticError(`struct Box<T> { value: T }\nconst b: Box<int> = { value: "no" }`), /"Box<int>\.value" expects int, got string/)
})

test("literal types and type aliases", () => {
    const result = run("literals", `
        type Role = "admin" | "user"
        type Id = int | string
        let id: Id = 5
        id = "x"
        let role: Role = "admin"
        try { let bad: Role = JSON.parse('"guest"') } catch (e) { log("role rejected") }
        try { let bad: Id = JSON.parse("true") } catch (e) { log("id rejected") }
        log(id, role)
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "role rejected\nid rejected\nx admin")
    assert.match(staticError(`type Role = "admin" | "user"\nfunc f(role: Role) { return role }\nf("guest")`), /expects Role, got "guest"/)
    assert.equal(staticError(`func f(role: "admin" | "user") { return role }\nf("user")`), null)
})

test("readonly struct fields", () => {
    const result = run("readonly", `
        struct User {
            readonly id: int
            name: string
        }
        const user = User.new({ id: 1, name: "a" })
        user.name = "b"
        try { user["id"] = 2 } catch (e) { log("blocked") }
        log(user.id, user.name)
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "blocked\n1 b")
    assert.match(staticError(`struct User { readonly id: int }\nconst u: User = { id: 1 }\nu.id = 2`), /"User\.id" is readonly/)
})

test("static checks for struct fields, methods and await", () => {
    assert.match(staticError(`struct User { name: string }\nconst u: User = { name: "a" }\nu.name = 5`), /"User\.name" expects string, got int/)
    assert.match(staticError(`struct User { name: string }\nconst u: User = { name: "a" }\nu.age = 5`), /"User" has no field "age"/)
    assert.match(staticError(`struct C {\n    n: int\n    add(by: int) -> int { return this.n + by }\n}\nconst c = C.new({ n: 1 })\nc.add("x")`), /argument "by" of "C\.add" expects int, got string/)
    assert.match(staticError(`async func load() -> int { return 1 }\nasync func main() {\n    let b: int = load()\n}`), /"b" expects int, got Promise<int>/)
    assert.equal(staticError(`async func load() -> int { return 1 }\nasync func main() {\n    let a: int = await load()\n}`), null)
})

test("Enum.from turns raw values into members", () => {
    const result = run("enum-from", `
        enum Role {
            Member: 0
            Admin: 2
        }
        log(Role.from(2) == Role.Admin)
        try { Role.from(7) } catch (e) { log(e.message) }
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), `true\n7 is not a value of enum "Role"`)
})

test("empty arrays fit any element type", () => {
    const result = run("empty-array", `
        struct Team { members: string[] }
        const names: string[] = []
        log(Team.verify({ members: [] }).members.length, names.length)
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "0 0")
})

test("mutating a typed array checks only the new element", () => {
    const result = run("guard", `
        let list: int[] = [1, 2]
        list.push(3)
        try { list.push("x") } catch (e) { log("rejected") }
        log(list.join(","))
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "rejected\n1,2,3")
})

test("release builds leave implicit checks out", () => {
    const { code } = compile("release", `
        func f(x: int) -> int { return x }
        let a: int = f(1)
        a = 2
        const [p, q]: [int, int] = [1, 2]
    `, { release: true })
    assert.doesNotMatch(code.split("//# source")[0], /__typed_|__declare_return__/)
})

test("async tests are awaited and describe groups names", () => {
    const result = run("async-tests", `
        describe("math", () => {
            test("waits", async () => {
                await new Promise(resolve => setTimeout(resolve, 20))
                assertEqual(1, 1)
            })
            test("fails late", async () => {
                await null
                assertEqual(1, 2)
            })
        })
        test("runs after", () => { log("third") })
    `)
    assert.notEqual(result.status, 0)
    assert.match(result.stdout, /✓ math › waits\n {2}✗ math › fails late[\s\S]*third[\s\S]*2 passed, 1 failed/)
})

test("a module can use the entry file back when main lives in src/", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "slim-entry-"))
    try {
        mkdirSync(path.join(dir, "src"))
        writeFileSync(path.join(dir, "slimconfig.json"), JSON.stringify({ main: "src/app" }))
        writeFileSync(path.join(dir, "src", "app.slim"), `use { b } from "./b"\nexport func a() -> int { return 1 }\nlog(b())\n`)
        writeFileSync(path.join(dir, "src", "b.slim"), `use { a } from "./app"\nexport func b() -> int { return a() + 1 }\n`)

        const build = spawnSync(process.execPath, [path.join(root, "src", "compile.js")], { cwd: dir, encoding: "utf8" })
        assert.equal(build.status, 0, build.stderr)
        assert.match(build.stderr, /circular use/)

        const result = spawnSync(process.execPath, ["--no-warnings", path.join(dir, "slim-dist", "src", "app.js")], { cwd: dir, encoding: "utf8" })
        assert.equal(result.status, 0, result.stderr)
        assert.equal(result.stdout.trim(), "2")
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("an async call nobody awaits inside an async function is reported", () => {
    const save = `async func save(id: int) { return id }\n`
    assert.match(staticError(`${save}async func main() {\n    save(1)\n}`), /"save" is async and nothing awaits it/)
    assert.match(staticError(`const load = async () => 1\nasync func main() {\n    load()\n}`), /"load" is async/)
    assert.equal(staticError(`${save}async func main() {\n    await save(1)\n    void save(2)\n}\nmain()`), null)
    assert.equal(staticError(`${save}func sync() {\n    save(1)\n}`), null)
})

test("async callbacks in forEach and filter are reported", () => {
    assert.match(staticError(`[1, 2].forEach(async x => { await null })`), /forEach doesn't wait for async callbacks/)
    assert.match(staticError(`async func keep(x) { return x > 1 }\nconst kept = [1, 2].filter(keep)`), /filter doesn't wait for async callbacks/)
    assert.equal(staticError(`const all = Promise.all([1, 2].map(async x => x))\n[1, 2].forEach(x => log(x))`), null)
})

test("errors of fire-and-forget async calls get the Slim error output", () => {
    const result = run("async-errors", `
        main()
        async func main() {
            void fail()
        }
        async func fail() {
            await null
            throw new Error("boom")
        }
    `)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Error: boom/)
    assert.doesNotMatch(result.stderr, /Node\.js v\d/)
})
