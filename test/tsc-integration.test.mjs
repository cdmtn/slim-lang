import assert from "node:assert/strict"
import { test } from "node:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync, cpSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { transform } from "../src/transform.js"

const root = process.cwd()
const tscBin = path.join(root, "node_modules", "typescript", "bin", "tsc")
const guard = existsSync(tscBin) ? {} : { skip: "typescript not installed" }

const tsconfig = {
    compilerOptions: {
        allowJs: true,
        checkJs: true,
        noEmit: true,
        strict: false,
        skipLibCheck: true,
        target: "es2020",
        module: "esnext",
        moduleResolution: "bundler"
    },
    include: ["index.js", "slim-globals.d.ts"]
}

function typeCheck(source) {
    const dir = mkdtempSync(path.join(tmpdir(), "slim-tsc-"))
    try {
        const { code } = transform(source, path.join(dir, "index.slim"), { jsdoc: true, check: false })
        writeFileSync(path.join(dir, "index.js"), code.replace(/^import\s+[^;]*(?:defaults|core)\.js";$/m, ""))
        writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify(tsconfig))
        cpSync(path.join(root, "src", "external", "slim-globals.d.ts"), path.join(dir, "slim-globals.d.ts"))

        const result = spawnSync(process.execPath, [tscBin, "-p", path.join(dir, "tsconfig.json")], {
            cwd: dir,
            encoding: "utf8"
        })

        return (result.stdout + result.stderr)
            .split("\n")
            .filter(line => /error TS/.test(line))
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

test("valid typed Slim compiles clean under tsc --checkJs", guard, () => {
    const errors = typeCheck(`struct User {
        name: string
        id: int
    }
    func greet(user: User) { return user.name }
    greet({ name: "a", id: 1 })
    let count: int = 5
    count = 10`)

    assert.deepEqual(errors, [], errors.join("\n"))
})

test("tsc flags a wrong argument, initializer, and reassignment", guard, () => {
    const callSite = typeCheck(`struct User { name: string
        id: int }
        func greet(user: User) { return user.name }
        greet({ name: "a", id: "wrong" })`)
    assert.ok(callSite.some(d => /not assignable/.test(d)), callSite.join("\n"))

    const badInit = typeCheck(`let n: int = "text"`)
    assert.ok(badInit.some(d => /not assignable/.test(d)), badInit.join("\n"))

    const badReassign = typeCheck(`let n: int = 5
        n = "bad"`)
    assert.ok(badReassign.some(d => /not assignable/.test(d)), badReassign.join("\n"))
})

const NEW_FORMS = `export struct User {
    name: string
    age: int
}
export trait Events {
    tick: (dt: number) => void
    chat: (from: string, text: string) => void
}
export func on<K extends keyof Events>(event: K, handler: Events[K]) -> void {
}
export func field(name: keyof User) -> string {
    return name
}
export func count(prefix: string, ...rest: string[]) -> int {
    return rest.length
}
export func make<T>(model: Struct<T>, value: any) -> T {
    return model.verify(value)
}
export func run(cb: (a: int, ...more: string[]) => void, opt?: (x?: string) => bool) -> void {
}`

test("keyof, indexed access, rest parameters and Struct<T> reach JSDoc", guard, () => {
    const clean = typeCheck(`${NEW_FORMS}
on("tick", (dt) => {})
on("chat", (from, text) => {})
field("age")
count("a", "b", "c")
const user: User = make(User, { name: "a", age: 1 })
run((a, ...more) => {})`)
    assert.deepEqual(clean, [], clean.join("\n"))

    const wrong = typeCheck(`${NEW_FORMS}
on("nope", () => {})
field("email")
count("a", 1)`)
    assert.equal(wrong.length, 3, wrong.join("\n"))
})

test("the same forms reach the .d.ts declarations", guard, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "slim-dts-"))
    try {
        const { declarations } = transform(NEW_FORMS, path.join(dir, "api.slim"), { declarations: true, check: false })
        writeFileSync(path.join(dir, "api.d.ts"), declarations)
        writeFileSync(path.join(dir, "use.ts"), `import { on, field, count, make, run, User } from "./api"
on("chat", (from: string, text: string) => {})
field("name")
count("a", "b")
const user: User = make(User, {})
run((a: number, ...more: string[]) => {}, (x?: string) => true)
`)
        writeFileSync(path.join(dir, "wrong.ts"), `import { on, field, count } from "./api"
on("tick", (dt: string) => {})
field("nope")
count("a", 2)
`)
        writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true, strict: true, target: "es2020", module: "esnext", moduleResolution: "bundler" }, include: ["use.ts", "wrong.ts", "api.d.ts"] }))
        const result = spawnSync(process.execPath, [tscBin, "-p", path.join(dir, "tsconfig.json")], { cwd: dir, encoding: "utf8" })
        const errors = (result.stdout + result.stderr).split("\n").filter(line => /error TS/.test(line))
        assert.deepEqual(errors.filter(line => line.startsWith("use.ts")), [], errors.join("\n") + "\n" + declarations)
        assert.equal(errors.filter(line => line.startsWith("wrong.ts")).length, 3, errors.join("\n"))
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
