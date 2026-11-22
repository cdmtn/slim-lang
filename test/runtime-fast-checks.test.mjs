import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__fast_checks__")
const runtime = pathToFileURL(path.join(root, "src", "external", "runtime-core.js")).href

function compile(name, source, options = {}) {
    return transform(source, path.join(outputDir, `${name}.slim`), { sourceMaps: false, runtime: "imports", ...options }).code
}

function run(name, source, options = {}) {
    mkdirSync(outputDir, { recursive: true })
    const code = compile(name, source, options).replace(/from "[^"]*runtime-(?:core|dom)\.js"/, `from ${JSON.stringify(runtime)}`)
    const file = path.join(outputDir, `${name}.mjs`)
    writeFileSync(file, code)
    const result = spawnSync(process.execPath, ["--no-warnings", file], { encoding: "utf8" })
    return { status: result.status, output: result.stdout.trim(), errors: result.stderr }
}

test("primitive parameters are checked inline, without building a type spec per call", () => {
    const code = compile("inline", `func add(a: number, b: int, c?: string, d: bool) -> number { return a + b }\nlog(add(1, 2, undefined, true))`)
    assert.match(code, /typeof a === "number" && a === a \|\| __typed_parameter__\(a, _slimSpec\d+/)
    assert.match(code, /Number\.isSafeInteger\(b\) \|\| __typed_parameter__/)
    assert.match(code, /c == null \|\| typeof c === "string" \|\| __typed_parameter__/)
    assert.match(code, /typeof d === "boolean" \|\| __typed_parameter__/)
    const body = code.slice(code.indexOf("function add"))
    assert.doesNotMatch(body.slice(0, body.indexOf("}")), /__type_spec__/)
})

test("inline primitive checks still reject wrong values with the usual errors", () => {
    const result = run("reject", [
        `func half(n: number) -> number { return n / 2 }`,
        `func whole(n: int) -> int { return n }`,
        `func label(s?: string) -> string { return s ?? "none" }`,
        `const none: any = null`,
        `const text: any = "4"`,
        `const fraction: any = 1.5`,
        `log(half(4), label(none), label("x"))`,
        `try { half(text) } catch (e) { log(e.message) }`,
        `try { half(NaN) } catch (e) { log(e.message) }`,
        `try { whole(fraction) } catch (e) { log(e.message) }`
    ].join("\n"))
    assert.equal(result.status, 0, result.errors)
    assert.deepEqual(result.output.split("\n"), [
        "2 none x",
        `function "half": argument<0> "n" expected number, got string`,
        `function "half": argument<0> "n" expected number, got NaN`,
        `function "whole": argument<0> "n" expected int, got float`
    ])
})

test("a return the checker already proved is not checked again", () => {
    const code = compile("proven", [
        `func wave(t: number) -> number { return Math.sin(t) * 2 }`,
        `func name(n: int) -> string { return \`#\${n}\` }`,
        `func loose(v: any) -> number { return v }`,
        `func local(v: number) -> number { const r = v; return r }`
    ].join("\n"))
    assert.match(code, /return Math\.sin\(t\) \* 2;/)
    assert.match(code, /return `#\$\{n\}`;/)
    assert.match(code, /return typeof v === "number" && v === v \? v : __typed_return__\(v, _slimSpec\d+, "loose"\)/)
    assert.doesNotMatch(code, /__typed_return__\(r,/)
})

test("an unproved primitive return keeps its check and its error", () => {
    const result = run("loose-return", `func loose(v: any) -> number { return v }\ntry { loose("x") } catch (e) { log(e.message) }\nlog(loose(3))`)
    assert.equal(result.status, 0, result.errors)
    assert.deepEqual(result.output.split("\n"), [`function "loose" must return number, got string: "x"`, "3"])
})

test("type specs that name a local type are built once and stay lazy", () => {
    const result = run("lazy-spec", `struct P { x: int }\nfunc f(p: P) -> P { return p }\nlog(f(P.new({ x: 1 })).x)\nconst bad: any = { x: "no" }\ntry { f(bad) } catch (e) { log(e.message) }`)
    assert.equal(result.status, 0, result.errors)
    assert.deepEqual(result.output.split("\n"), ["1", `function "f": argument<0> "p" expected P, got object`])
    assert.match(compile("lazy-spec-code", `struct P { x: int }\nfunc f(p: P) -> P { return p }`), /_slimSpec0 \|\| \(_slimSpec0 = __type_spec__\(__type_ref__\("P", \(\) => P\)\)\)/)
})

test("a Record write checks only the written key", () => {
    const result = run("record-writes", [
        `trait Handle { id: number, tick: (dt: number) => undefined }`,
        `const handles: Record<number, Handle> = {}`,
        `const start = performance.now()`,
        `for (let i = 0; i < 20000; i++) handles[i] = { id: i, tick: (dt: number) => undefined }`,
        `const took = performance.now() - start`,
        `const loose: any = handles`,
        `try { loose[5] = { id: "bad" } } catch (e) { log("rejected", loose[5].id) }`,
        `try { loose.key = { id: 1, tick: (dt: number) => undefined } } catch (e) { log("bad key", "key" in handles) }`,
        `delete handles[3]`,
        `log(Object.keys(handles).length, took < 2000 ? "fast" : \`slow \${took}\`)`
    ].join("\n"))
    assert.equal(result.status, 0, result.errors)
    assert.deepEqual(result.output.split("\n"), ["rejected 5", "bad key false", "19999 fast"])
})

test("a trait-typed value checks only the written field", () => {
    const result = run("trait-writes", [
        `trait Unit { hp: int, name: string, *tag: string, heal: () => undefined }`,
        `const unit: Unit = { hp: 3, name: "a", heal: () => undefined }`,
        `unit.hp = 4`,
        `unit.tag = "boss"`,
        `unit.extra = 1`,
        `try { unit.hp = "x" } catch (e) { log("hp kept", unit.hp) }`,
        `try { unit.heal = 5 } catch (e) { log("heal kept", typeof unit.heal) }`,
        `try { delete unit.name } catch (e) { log("name kept", unit.name) }`,
        `log(unit.hp, unit.tag)`
    ].join("\n"), { check: false })
    assert.equal(result.status, 0, result.errors)
    assert.deepEqual(result.output.split("\n"), ["hp kept 4", "heal kept function", "name kept a", "4 boss"])
})
