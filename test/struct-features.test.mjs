import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__struct_feature_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function runSlim(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const { code } = transform(source, path.join(root, "__struct_feature_tests__", `${name}.slim`), { check: false })
    const executable = code.replace(
        /^import\s+[^;]*(?:defaults|core)\.js";$/m,
        `import ${JSON.stringify(runtimeImport)};`
    )
    const outputFile = path.join(outputDir, `${name}.js`)
    writeFileSync(outputFile, executable)
    return spawnSync(process.execPath, ["--no-warnings", outputFile], { cwd: root, encoding: "utf8" })
}

test("struct.new fills defaults and validates", () => {
    const result = runSlim("defaults", `
        struct User {
            name: string
            role: string = "member"
            active: bool = true
        }
        const u = User.new({ name: "Alice" })
        log(u.role, u.active)
        log(User.new({ name: "Bob", role: "admin" }).role)
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /member true/)
    assert.match(result.stdout, /admin/)
})

test("struct.new rejects an invalid field", () => {
    const result = runSlim("defaults-bad", `
        struct User { name: string
            age: int = 0 }
        User.new({ name: 42 })
    `)
    assert.notEqual(result.status, 0)
})

test("a struct inherits parent fields and defaults", () => {
    const result = runSlim("inherit", `
        struct User {
            name: string
            role: string = "member"
        }
        struct Admin extends User {
            level: int
        }
        const a = Admin.new({ name: "Bob", level: 9 })
        log(a.name, a.role, a.level)
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Bob member 9/)
})

test("mutable struct defaults are fresh per instance, not shared", () => {
    const result = runSlim("fresh-defaults", `
        struct Bag { data: object = { n: 0 } }
        const a = Bag.new({})
        a.data.n = 5
        log(Bag.new({}).data.n)
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^0/)
})

test("struct methods run with this bound and do not break verification", () => {
    const result = runSlim("methods", `
        struct User {
            name: string
            greet() { return "Hi " + this.name }
        }
        const u = User.new({ name: "Alice" })
        User.verify(u)
        log(u.greet())
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Hi Alice/)
})

test("struct methods are inherited", () => {
    const result = runSlim("inherit-methods", `
        struct Animal {
            name: string
            speak() { return this.name + " speaks" }
        }
        struct Dog extends Animal { breed: string }
        log(Dog.new({ name: "Rex", breed: "Lab" }).speak())
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Rex speaks/)
})

test("inherited fields are validated and an unknown parent errors", () => {
    const badField = runSlim("inherit-bad", `
        struct User { name: string }
        struct Admin extends User { level: int }
        Admin.verify({ name: "x", level: "wrong" })
    `)
    assert.notEqual(badField.status, 0)

    const badParent = runSlim("inherit-missing", `struct Admin extends Ghost { x: int }`)
    assert.notEqual(badParent.status, 0)
    assert.match(badParent.stderr, /unknown struct "Ghost"/)
})
