import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import os from "node:os"

const root = process.cwd()
const compiler = path.join(root, "src", "compile.js")

function build(files) {
    const dir = path.join(os.tmpdir(), `slim-cross-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })

    try {
        writeFileSync(path.join(dir, "slimconfig.json"), '{ "main": "index", "usePackages": true }')
        for (const [name, source] of Object.entries(files)) {
            writeFileSync(path.join(dir, name), source)
        }

        const result = spawnSync(process.execPath, [compiler], { cwd: dir, encoding: "utf8" })
        return { status: result.status, output: result.stdout + result.stderr }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

const MODELS = `
export enum Role {
    Member: 0
    Admin: 2
}

export struct User {
    name: string
    role: Role
}

export struct Admin extends User {
    level: int
}

export func greet(user: User) -> string {
    return user.name
}
`

test("an imported struct is checked in the importing file", () => {
    const { status, output } = build({
        "models.slim": MODELS,
        "index.slim": `use { User, Role } from "./models"\n\nconst u: User = { name: 1, role: Role.Admin, extra: true }\nlog(u.nmae)`
    })

    assert.equal(status, 1)
    assert.match(output, /"User.name" expects string, got int/)
    assert.match(output, /"User" has no field "extra"/)
    assert.match(output, /"User" has no field "nmae"/)
})

test("an imported function checks its arguments and result", () => {
    const { status, output } = build({
        "models.slim": MODELS,
        "index.slim": `use { User, Role, greet } from "./models"\n\nconst u: User = { name: "Ada", role: Role.Admin }\ngreet(u, 2)\nlet n: int = greet(u)`
    })

    assert.equal(status, 1)
    assert.match(output, /"greet" takes 1 argument, got 2/)
    assert.match(output, /"n" expects int, got string/)
})

test("valid cross-module code compiles cleanly", () => {
    const { status, output } = build({
        "models.slim": MODELS,
        "index.slim": `use { User, Admin, Role, greet } from "./models"

const u: User = { name: "Ada", role: Role.Admin }
const a: Admin = { name: "Bob", role: Role.Member, level: 9 }

log(greet(u), greet(a), a.level)

let s: string = greet(u)
const built = User.new({ name: "Eve", role: Role.Member })
log(built.name)`
    })

    assert.equal(status, 0, output)
})

test("a struct carries its inherited fields across the boundary", () => {
    const { status, output } = build({
        "models.slim": MODELS,
        "index.slim": `use { Admin } from "./models"\n\nconst a: Admin = { name: 1, role: 0, level: 9 }`
    })

    assert.equal(status, 1)
    assert.match(output, /"Admin.name" expects string, got int/)
})

test("a type reached through a third module still resolves", () => {
    const { status, output } = build({
        "base.slim": `export struct Point {\n    x: int\n    y: int\n}`,
        "middle.slim": `use { Point } from "./base"\n\nexport func origin() -> Point {\n    return { x: 0, y: 0 }\n}`,
        "index.slim": `use { origin } from "./middle"\n\nlet s: string = origin()`
    })

    assert.equal(status, 1)
    assert.match(output, /"s" expects string, got Point/)
})

test("an enum keeps its members across the boundary", () => {
    const { status, output } = build({
        "models.slim": MODELS,
        "index.slim": `use { Role } from "./models"\n\nconst label = match (Role.Admin) { Role.Admin => "admin" }`
    })

    assert.equal(status, 1)
    assert.match(output, /does not handle Role\.Member/)
})

test("a wildcard use brings every export into scope", () => {
    const { status, output } = build({
        "models.slim": MODELS,
        "index.slim": `use "./models"\n\nconst u: User = { name: 1, role: Role.Admin }`
    })

    assert.equal(status, 1)
    assert.match(output, /"User.name" expects string, got int/)
})

test("a renamed import keeps the type it was given", () => {
    const { status, output } = build({
        "models.slim": MODELS,
        "index.slim": `use { User as Person, Role } from "./models"\n\nconst p: Person = { name: 1, role: Role.Admin }`
    })

    assert.equal(status, 1)
    assert.match(output, /"Person.name" expects string, got int/)
})

test("a local declaration shadows the imported one", () => {
    const { status, output } = build({
        "models.slim": MODELS,
        "index.slim": `use { User } from "./models"

struct User {
    label: string
}

const u: User = { label: "own" }`
    })

    assert.equal(status, 0, output)
})
