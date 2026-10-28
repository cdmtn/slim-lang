import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import os from "node:os"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"

const root = process.cwd()
const external = path.join(root, "src", "external")

function runtimeImportOf(source, name) {
    const { code } = transform(source, path.join(root, `${name}.slim`))
    return code.split("\n").find(line => line.startsWith("import"))
}

test("a program without components imports the core runtime", () => {
    const line = runtimeImportOf(`struct U {\n    name: string\n}\n\nconst u: U = { name: "a" }\nlog(u.name)`, "plain")
    assert.match(line, /core\.js/)
})

test("a program with a component imports the full runtime", () => {
    const line = runtimeImportOf(`component Box(props) {\n    return ("<div>hi</div>")\n}\n\nlog(Box)`, "boxed")
    assert.match(line, /defaults\.js/)
})

test("nothing the core runtime pulls in leaves the runtime folder", () => {
    const seen = new Set()
    const queue = ["core.js"]

    while (queue.length > 0) {
        const file = queue.pop()
        if (seen.has(file)) continue
        seen.add(file)

        const source = readFileSync(path.join(external, file), "utf8")

        for (const [, specifier] of source.matchAll(/^import[\s\S]*?from "(.+?)"/gm)) {
            assert.match(specifier, /^\.\//,
                `${file} imports "${specifier}" — the core runtime must stay free of Node and npm`)
            queue.push(specifier.slice(2))
        }

        const lines = source.split("\n")
        lines.forEach((line, index) => {
            if (!/\bprocess\./.test(line)) return

            const guarded = lines
                .slice(Math.max(0, index - 2), index + 1)
                .some(nearby => nearby.includes("typeof process"))

            assert.ok(guarded, `unguarded process use in ${file}: ${line.trim()}`)
        })
    }

    assert.ok(seen.has("classErrors.js"), "expected classErrors.js in the graph")
})

test("a compiled core program runs in an engine without process", () => {
    const dir = path.join(os.tmpdir(), `slim-embed-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })

    try {
        const source = `
enum Role {
    Member: 0
    Admin: 2
}

struct User {
    name: string
    role: Role
    score: positive
}

func describe(user: User) -> string {
    return match (user.role) {
        Role.Admin => "admin " + user.name,
        Role.Member => "member " + user.name
    }
}

const u = User.new({ name: "Ada", role: Role.Admin, score: 5 })
log(describe(u), sizeof [1, 2, 3], 7 ~/ 2)

try {
    let bad: int = JSON.parse(\`{"v":"x"}\`).v
} catch (e) {
    log("checked: " + e.message)
}
`
        const { code } = transform(source, path.join(root, "__embed_tests__", "index.slim"))
        const runtime = pathToFileURL(path.join(external, "core.js")).href

        writeFileSync(path.join(dir, "index.js"), code.replace(
            /^import\s+[^;]*core\.js";$/m,
            `import ${JSON.stringify(runtime)};`
        ))

        const harness = path.join(dir, "harness.mjs")
        writeFileSync(harness, [
            "globalThis.process = undefined",
            `await import(${JSON.stringify(pathToFileURL(path.join(dir, "index.js")).href)})`
        ].join("\n"))

        const result = spawnSync(process.execPath, ["--no-warnings", harness], { cwd: dir, encoding: "utf8" })

        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /admin Ada 3 3/)
        assert.match(result.stdout, /checked: .*of type int.*string/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
