import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { prove, provenAccepts } from "../src/proofs.js"

const root = process.cwd()

function decisions(source, options = {}) {
    return transform(source, "elide.slim", options).checks
}

function find(source, kind, name) {
    const found = decisions(source).filter(d => d.kind === kind && (name === undefined || d.name.includes(name)))
    assert.ok(found.length > 0, `no ${kind} decision${name ? ` for ${name}` : ""}`)
    return found
}

function removed(source, kind, name, proof) {
    for (const decision of find(source, kind, name)) {
        assert.equal(decision.status, "removed", `${kind} ${decision.name} should be removed: ${decision.reason}`)
        if (proof) assert.match(decision.reason, proof)
    }
}

function kept(source, kind, name, reason) {
    for (const decision of find(source, kind, name)) {
        assert.equal(decision.status, "kept", `${kind} ${decision.name} must keep its check (${decision.reason})`)
        if (reason) assert.match(decision.reason, reason)
    }
}

// --- every removed check carries a proof -----------------------------------------------

test("an int literal proves an int variable", () => {
    removed(`let x: int = 5`, "variable", "x", /int literal 5/)
})

test("float, string and bool literals prove their own types", () => {
    removed(`let f: float = 1.5`, "variable", "f", /float literal/)
    removed(`let s: string = "a"`, "variable", "s", /string literal/)
    removed(`let b: bool = true`, "variable", "b", /bool literal/)
    removed("let n: int = 1\nlet s: string = `n=${n}`", "variable", "s", /template literal/)
})

test("string concatenation proves a string", () => {
    removed(`let s: string = "a" + 1`, "variable", "s", /string concatenation/)
    removed(`func greet(name: string) -> string { return "hi " + name }\nlog(greet("a"))`, "return", "greet", /string concatenation/)
})

test("comparisons prove a bool", () => {
    removed(`let b: bool = 1 < 2`, "variable", "b", /comparison/)
})

test("numeric arithmetic proves a number", () => {
    removed(`let n: number = 1 + 2.5`, "variable", "n", /numeric \+/)
})

test("a variable that is already checked proves a variable of the same type", () => {
    const decided = decisions(`let x: int = 5\nlet y: int = x`)
    assert.equal(decided.find(d => d.name === '"y"').status, "removed")
    assert.match(decided.find(d => d.name === '"y"').reason, /"x" is a checked int binding/)
})

test("a call of a function declared -> int proves an int variable", () => {
    const source = `func one() -> int { return 1 }\nlet y: int = one()`
    removed(source, "variable", '"y"', /call of "one" declared -> int/)
})

test("a return of a proven value drops the return check", () => {
    removed(`func one() -> int { return 1 }\nlog(one())`, "return", "one", /int literal 1/)
})

test("a proven reassignment drops its check", () => {
    removed(`let x: int = 1\nx = 2`, "assignment", "x", /int literal 2/)
})

test("a parameter check goes when every call passes proven values", () => {
    const source = `func add(a: int, b: int) -> int { return 7 }\nlog(add(1, 2))`
    removed(source, "parameter", "add", /all 1 call\(s\) in this module pass proven values/)
})

test("elided checks leave no trace in the output", () => {
    const { code } = transform(`let x: int = 5\nx = 6\nfunc id(a: int) -> int { return 4 }\nlog(id(x))`, "elide.slim")
    assert.doesNotMatch(code, /__typed_/)
    assert.match(code, /let x = 5;/)
})

// --- everything else keeps its check ---------------------------------------------------

test("values from JSON.parse, any and untyped variables keep their check", () => {
    kept(`let n: int = JSON.parse("1")`, "variable", '"n"', /JSON\.parse/)
    kept(`const raw = JSON.parse("1")\nlet n: int = raw`, "variable", '"n"', /no declared type/)
    kept(`let a: any = 1\nlet n: int = a`, "variable", '"n"')
    kept(`let n: int = missing`, "variable", '"n"')
})

test("integer arithmetic is not proven to be an int", () => {
    // 2 ** 2000 is Infinity at runtime, which the runtime types as float.
    kept(`let n: int = 2 ** 2000`, "variable", '"n"', /number is not proven to satisfy int/)
    kept(`func add(a: int, b: int) -> int { return a + b }\nlog(add(1, 2))`, "return", "add")
})

test("an int is not proven to be a float", () => {
    kept(`let f: float = 3`, "variable", '"f"')
})

test("exported functions keep their parameter checks", () => {
    kept(`export func f(a: int) -> int { return a }`, "parameter", "f", /exported/)
    kept(`func f(a: int) -> int { return a }\nexport { f }`, "parameter", "f")
})

test("a function used as a value keeps its parameter checks", () => {
    kept(`func f(a: int) -> int { return a }\n[1, 2].map(f)`, "parameter", "f", /used as a value/)
    kept(`func f(a: int) -> int { return a }\nconst g = f\nlog(g(1))`, "parameter", "f")
})

test("one unproven call is enough to keep a parameter check", () => {
    const source = `func f(a: int) -> int { return a }\nlog(f(1))\nlog(f(JSON.parse("2")))`
    kept(source, "parameter", "f", /unproven value/)
})

test("a function that is never called, spreads its arguments or is reassigned keeps checks", () => {
    kept(`func f(a: int) -> int { return a }`, "parameter", "f", /never called/)
    kept(`func f(a: int) -> int { return a }\nconst xs = [1]\nlog(f(...xs))`, "parameter", "f", /spread/)
    kept(`let f = (a: int) -> int => { return a }\nlog(f(1))\nf = (a) => 2`, "parameter", "f", /reassigned/)
})

test("a reassigned parameter keeps its check", () => {
    kept(`func f(a: int) -> int { a = JSON.parse("1")\n return 1 }\nlog(f(1))`, "parameter", "f", /reassigned/)
})

test("compound assignment and increments are always checked", () => {
    kept(`let x: int = 1\nx += 1`, "assignment", "+=")
    kept(`let x: int = 1\nx++`, "assignment", "++")
})

test("a later unproven write keeps the declaration check", () => {
    const source = `let x: int = 1\nx = JSON.parse("2")`
    kept(source, "variable", '"x"', /later write/)
    kept(source, "assignment", '"x"')
})

test("a proven write keeps the declaration when the declaration itself is unproven", () => {
    const source = `let x: int = JSON.parse("1")\nx = 2`
    kept(source, "variable", '"x"')
    removed(source, "assignment", '"x"', /int literal 2/)
})

test("an async function's call result is a promise, not its declared type", () => {
    kept(`async func f() -> int { return 1 }\nlet y: int = f()`, "variable", '"y"')
})

test("a function that can fall off the end does not prove its return type", () => {
    kept(`func f(c: bool) -> int { if (c) { return 1 } }\nlet y: int = f(true)`, "variable", '"y"')
})

test("an optional parameter may be null, so it proves nothing", () => {
    kept(`func f(a?: int) -> int { return a }\nlog(f(1))`, "return", "f")
})

test("objects and arrays are always checked", () => {
    kept(`let xs: int[] = [1, 2]`, "variable", '"xs"', /not a primitive/)
    kept(`struct U { id: int }\nconst u: U = { id: 1 }`, "variable", '"u"')
})

test("the prover and its acceptance relation agree on edge cases", () => {
    assert.equal(provenAccepts("int", "int"), true)
    assert.equal(provenAccepts("number", "int"), true)
    assert.equal(provenAccepts("number", "float"), true)
    assert.equal(provenAccepts("int", "number"), false)
    assert.equal(provenAccepts("float", "int"), false)
    assert.equal(provenAccepts("int?", "null"), true)
    assert.equal(provenAccepts("int | string", "int"), true)
    assert.equal(provenAccepts("int", "int | string"), false)
    assert.equal(provenAccepts("any", "int"), false)
    assert.equal(provenAccepts("User", "User"), false)
    assert.equal(typeof prove, "function")
})

test("--no-check proves nothing, and elide:false keeps every check", () => {
    assert.deepEqual(transform(`let x: int = 5`, "elide.slim", { check: false }).checks, [])
    assert.match(transform(`let x: int = 5`, "elide.slim", { elide: false }).code, /__typed_variable__/)
    assert.equal(decisions(`let x: int = 5`, { elide: false })[0].status, "kept")
})

// --- observable behaviour is unchanged -------------------------------------------------

const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function run(source, elide) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "slim-elide-"))
    try {
        const sourceFile = path.join(dir, "case.slim")
        const { code } = transform(source, sourceFile, { elide })
        const file = path.join(dir, "case.mjs")
        writeFileSync(file, code.replace(/^import\s+[^;]*(?:defaults|core)\.js";$/m, `import ${JSON.stringify(runtimeImport)};`))
        const result = spawnSync(process.execPath, ["--no-warnings", file], { encoding: "utf8", cwd: root, timeout: 10000, env: { ...process.env, SLIM_RELEASE: "0" } })
        const normalise = text => text.split(dir).join("<dir>").replace(/\(file:[^)]*\)/g, "").replace(/at .*\n/g, "")
        return { status: result.status, stdout: result.stdout, error: normalise(result.stderr).split("\n").find(line => /Error/.test(line)) ?? "" }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

const PROGRAMS = {
    jsImport: `use { basename } from "node:path"
let n: int = basename("bad")`,
    redeclaration: `var x: int = 1
x = "bad"
var x: string = ""
log(x)`,
    arithmetic: `
        func square(n: int) -> int { return 4 }
        let total: int = square(3)
        let label: string = "total=" + total
        log(label)`,
    reassign: `
        let x: int = 1
        x = 2
        x = 3
        log(x)`,
    boundary: `
        let n: int = JSON.parse("\\"nope\\"")
        log(n)`,
    callback: `
        func double(a: int) -> int { return 2 }
        log([1, 2].map(double).join())
        log(JSON.parse('["x"]').map(double).join())`,
    unprovenCall: `
        func take(a: int) -> int { return 1 }
        log(take(1))
        log(take(JSON.parse('"x"')))`,
    later: `
        let x: int = 1
        x = JSON.parse('"s"')
        log(x)`,
    returnsWrong: `
        func f() -> int { return JSON.parse('"s"') }
        log(f())`,
    promise: `
        async func f() -> int { return 1 }
        const r = f()
        log(typeof r)`,
}

for (const [name, source] of Object.entries(PROGRAMS)) {
    test(`eliding checks does not change behaviour: ${name}`, () => {
        const withChecks = run(source, false)
        const without = run(source, true)
        assert.deepEqual(without, withChecks)
    })
}

test("a broken value still fails at the JSON boundary", () => {
    const result = run(PROGRAMS.boundary, true)
    assert.notEqual(result.status, 0)
    assert.match(result.error, /"n" is of type int/)
})

test("a broken value still fails at an exported function", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "slim-elide-export-"))
    try {
        writeFileSync(path.join(dir, "slimconfig.json"), '{ "main": "index", "uses": { "enabled": true } }')
        writeFileSync(path.join(dir, "lib.slim"), "export func inc(a: int) -> int { return a }\n")
        writeFileSync(path.join(dir, "index.slim"), `use { inc } from "./lib"\nlog(inc(JSON.parse('"x"')))\n`)

        const build = spawnSync(process.execPath, [path.join(root, "src", "compile.js")], { cwd: dir, encoding: "utf8" })
        assert.equal(build.status, 0, build.stderr)

        const result = spawnSync(process.execPath, ["--no-warnings", path.join(dir, "slim-dist", "index.js")], { cwd: dir, encoding: "utf8" })
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /argument.*"a" expected int/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("examples preserve diagnostics, check positions and observable behaviour", () => {
    const dir = path.join(root, "examples")
    for (const name of readdirSync(dir).filter(file => file.endsWith(".slim")).sort()) {
        const source = readFileSync(path.join(dir, name), "utf8")
        const outcome = elide => {
            const originalExit = process.exit
            const originalError = console.error
            console.error = () => {}
            process.exit = () => { throw new Error("aborted") }
            try {
                const result = transform(source, path.join(dir, name), { elide })
                return { ok: true, checks: result.checks.map(d => [d.kind, d.name, d.line, d.column, d.type].join("|")) }
            } catch (error) {
                return { ok: false, message: error.message }
            } finally {
                process.exit = originalExit
                console.error = originalError
            }
        }

        const on = outcome(true)
        const off = outcome(false)
        assert.equal(on.ok, off.ok, `${name}: compiles differently`)
        if (on.ok) {
            assert.deepEqual(on.checks, off.checks, `${name}: elision changed which checks exist`)
            assert.deepEqual(run(source, true), run(source, false), `${name}: different runtime behaviour`)
        } else assert.equal(on.message, off.message, `${name}: different diagnostics`)
    }
})


test("custom validators shadowing primitives keep observable validator calls", () => {
    const source = `let calls = 0
        type string(v) { calls++
 return false }
        let x: string = "hi"`
    kept(source, "variable", '"x"', /redefined/)
    assert.deepEqual(run(source, true), run(source, false))
})

test("eval and parameter defaults cannot supply an unchecked proof", () => {
    kept(`let x: int = 1
eval('x = "bad"')
let y: int = x`, "variable", '"y"', /eval/)
    const source = `func inner(x: int) { log(x) }
        func outer(a: int, b = inner(a)) { return 1 }
        outer(JSON.parse('"bad"'))`
    kept(source, "parameter", "inner", /unproven/)
    assert.deepEqual(run(source, true), run(source, false))
})

test("conditional, nullable and unary proofs have runtime evidence", () => {
    for (const source of [
        `let n: int = -5
log(n)`,
        `let b: bool = !JSON.parse('false')
log(b)`,
        `let s: string = typeof JSON.parse('1')
log(s)`,
        `let n: int? = null
log(n)`,
        `let n: int? = undefined
log(n)`,
        `let n: int | string = JSON.parse('true') ? 1 : "s"
log(n)`
    ]) {
        removed(source, "variable")
        assert.deepEqual(run(source, true), run(source, false))
    }
})

test("destructuring writes and var hoisting prevent binding proofs", () => {
    kept(`let x: int = 1
[x] = JSON.parse('["bad"]')
let y: int = x`, "variable", '"y"')
    kept(`var x: int = 1
let y: int = x`, "variable", '"y"')
})

test('remaining method, field and destructuring guards are explained', () => {
    const checks = decisions(`class A {
        static n: int = 1
        method(n: int) -> int { return n }
    }
    A.n = 2
    A.n++
    const [n]: int[] = [1]`)
    assert.ok(checks.some(d => d.kind === 'parameter' && d.status === 'kept'))
    assert.equal(checks.filter(d => d.reason === 'static field writes are always checked').length, 2)
    assert.ok(checks.some(d => d.kind === 'field' && d.status === 'kept'))
    assert.ok(checks.some(d => d.kind === 'pattern' && d.status === 'kept'))
    assert.ok(checks.every(d => d.line > 0 && d.column > 0))
})

test('sourcemaps retain original locations after removing checks', async () => {
    const { SourceMapConsumer } = await import('source-map')
    const source = 'let x: int = 5\nlet y: int = JSON.parse("1")\nlog(x, y)'
    const { code } = transform(source, 'mapped.slim')
    const map = JSON.parse(Buffer.from(code.split('base64,')[1], 'base64').toString())
    assert.deepEqual(map.sourcesContent, [source])
    await SourceMapConsumer.with(map, null, consumer => {
        const lines = code.split('\n')
        for (const [token, line] of [['5;', 1], ['JSON.parse', 2], ['log(', 3]]) {
            const index = lines.findIndex(text => text.includes(token))
            const position = consumer.originalPositionFor({ line: index + 1, column: lines[index].indexOf(token) })
            assert.equal(position.source, 'mapped.slim')
            assert.equal(position.line, line)
        }
    })
})


test('var redeclarations cannot invalidate a removed assignment check', () => {
    kept(PROGRAMS.redeclaration, 'assignment', '"x"', /redeclared/)
})

test('JavaScript imports do not supply a typed call proof', () => {
    kept(PROGRAMS.jsImport, 'variable', '"n"')
    assert.notEqual(run(PROGRAMS.jsImport, true).status, 0)
})
