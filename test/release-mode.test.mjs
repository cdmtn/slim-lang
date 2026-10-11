import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs"
import { test } from "node:test"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping"
import { transform } from "../src/transform.js"

const root = process.cwd()
const outputDir = path.join(root, "dist", "__release_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function compile(name, source, release) {
    mkdirSync(outputDir, { recursive: true })
    const sourceFile = path.join(root, "__release_tests__", `${name}.slim`)
    const { code } = transform(source, sourceFile, { check: false, release })
    const executable = code.replace(
        /^import\s+[^;]*(?:defaults|core)\.js";$/m,
        `import ${JSON.stringify(runtimeImport)};`
    )
    const outputFile = path.join(outputDir, `${name}${release ? ".release" : ".dev"}.js`)
    writeFileSync(outputFile, executable)
    return { code, outputFile, sourceFile }
}

function run(outputFile, extraEnv = {}) {
    return spawnSync(process.execPath, ["--no-warnings", "--enable-source-maps", outputFile], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, ...extraEnv }
    })
}

const ALL_ANNOTATIONS = `
struct User {
    name: string
    age: int
}
type Id = int

let count: int = 1
let ratio: float = 1.5
let label: string = "a"
let {first, second}: any = { first: 1, second: 2 }
const user: User = { name: "ann", age: 3 }
let maybe: int? = null

func add(a: int, b?: int) -> int {
    let sum: int = a + (b ?? 0)
    sum = sum + 1
    return sum
}

const twice = (n: int) -> int => n * 2

class Counter {
    static total: int = 0
    bump(by: int) -> int {
        Counter.total += by
        return Counter.total
    }
}

count++
count += 2
log(add(1, 2), twice(4), new Counter().bump(5), user.name, first + second, maybe, label, ratio, count)
`

test("a release build contains no runtime check wrappers", () => {
    const { code } = compile("erase-all", ALL_ANNOTATIONS, true)
    const names = code.match(/__typed_\w*__|__declare_return__|__argument_typed__/g)
    assert.equal(names, null, `check wrappers left in output: ${names}`)
    assert.doesNotMatch(code, /_slimType/)

    assert.match(code, /let count = 1;/)
    assert.match(code, /return sum;/)

    const dev = compile("erase-all", ALL_ANNOTATIONS, false).code
    assert.match(dev, /__typed_variable__/)
    assert.match(dev, /__typed_return__/)
    assert.match(dev, /__typed_parameter__/)
})

test("release and dev builds behave the same on valid data", () => {
    const dev = run(compile("same", ALL_ANNOTATIONS, false).outputFile)
    const released = run(compile("same", ALL_ANNOTATIONS, true).outputFile)

    assert.equal(dev.status, 0, dev.stderr)
    assert.equal(released.status, 0, released.stderr)
    assert.equal(released.stdout, dev.stdout)
})

test("release builds skip checks on annotations", () => {
    const source = `
        func identity(value: int) { return value }
        func parse(raw: string) -> int { return JSON.parse(raw).value }
        let n: int = "nope"
        log(identity("nope"), parse(\`{ "value": "seven" }\`), n)
    `
    assert.notEqual(run(compile("release-args", source, false).outputFile).status, 0)

    const released = run(compile("release-args", source, true).outputFile)
    assert.equal(released.status, 0, released.stderr)
    assert.match(released.stdout, /nope seven nope/)
})

test("release builds keep explicit struct verification", () => {
    const source = `
        struct User {
            name: string
        }
        const u: User = { name: 5 }
        log(User.verifySafe({ name: 5 }).success)
        log(User.verifySafe({ name: "a" }).success)
        User.verify({ name: 5 })
    `
    const released = run(compile("release-verify", source, true).outputFile)
    assert.notEqual(released.status, 0)
    assert.match(released.stdout, /false\s+true/)
    assert.match(released.stderr, /name/)
})

test("release builds keep Struct.new and kindof working", () => {
    const source = `
        struct User {
            name: string
            age: int = 1
        }
        const u = User.new({ name: "a" })
        log(u.age, kindof u, kindof 1)
    `
    const dev = run(compile("explicit", source, false).outputFile)
    const released = run(compile("explicit", source, true).outputFile)
    assert.equal(released.status, 0, released.stderr)
    assert.equal(released.stdout, dev.stdout)
})

test("//@keep-checks keeps checks on one boundary in a release build", () => {
    const source = `
        //@keep-checks
        func boundary(raw: int) -> int {
            let copy: int = raw
            return copy
        }

        func inner(raw: int) -> int { return raw }

        log(inner("free"))
        boundary("external")
    `
    const { code, outputFile } = compile("keep", source, true)
    const boundary = code.slice(code.indexOf("function boundary"), code.indexOf("function inner"))
    assert.match(boundary, /__typed_parameter__/)
    assert.match(boundary, /__typed_variable__/)
    assert.match(boundary, /__typed_return__/)
    assert.doesNotMatch(code.slice(code.indexOf("function inner")), /__typed_/)

    const result = run(outputFile)
    assert.match(result.stdout, /free/)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /boundary/)
})

test("release builds keep the source map correct", () => {
    const source = [
        "let a: int = 1",
        "func work(n: int) -> int {",
        "    let local: int = n + 1",
        "    return local",
        "}",
        "log(work(a))",
        "throw new Error(\"boom\")",
    ].join("\n")
    const { code, sourceFile } = compile("map", source, true)

    const encoded = code.match(/sourceMappingURL=data:application\/json;base64,(.+)$/)[1]
    const map = new TraceMap(JSON.parse(Buffer.from(encoded, "base64").toString()))
    const lines = code.split("\n")

    const position = needle => {
        const line = lines.findIndex(text => text.includes(needle))
        assert.notEqual(line, -1, needle)
        const column = lines[line].indexOf(needle)
        return originalPositionFor(map, { line: line + 1, column })
    }

    assert.equal(position("let a = 1").line, 1)
    assert.equal(position("let local = n + 1").line, 3)
    assert.equal(position("return local").line, 4)
    assert.equal(position("throw new Error").line, 7)
    assert.equal(path.resolve(position("let a = 1").source), sourceFile)
})

test("a release build writes to its own folder and SLIM_RELEASE=1 gives the same build", () => {
    const project = mkdtempSync(path.join(os.tmpdir(), "slim-release-"))
    try {
        writeFileSync(path.join(project, "slimconfig.json"), JSON.stringify({ main: "index" }))
        writeFileSync(path.join(project, "index.slim"), `
            struct User {
                name: string
            }
            func double(n: int) -> int { return n * 2 }
            log(double(2), User.verifySafe({ name: 1 }).success)
        `)
        const compiler = path.join(root, "src", "compile.js")
        const build = env => spawnSync(process.execPath, [compiler], {
            cwd: project, encoding: "utf8", env: { ...process.env, SLIM_RELEASE: "0", ...env }
        })

        assert.equal(build({}).status, 0)
        assert.equal(build({ SLIM_RELEASE: "1" }).status, 0)

        const dev = readFileSync(path.join(project, "slim-dist", "index.js"), "utf8")
        const released = readFileSync(path.join(project, "slim-dist-release", "index.js"), "utf8")
        assert.match(dev, /__typed_parameter__/)
        assert.doesNotMatch(released, /__typed_|__declare_return__/)
        assert.ok(existsSync(path.join(project, "slim-dist-release", "external", "core.js")))

        const result = spawnSync(process.execPath, ["--no-warnings", path.join(project, "slim-dist-release", "index.js")], { encoding: "utf8" })
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /4\s+false/)
    } finally {
        rmSync(project, { recursive: true, force: true })
    }
})
