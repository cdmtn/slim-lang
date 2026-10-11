import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { SourceMapConsumer } from "source-map"
import { parse } from "@babel/parser"
import { transform } from "../src/transform.js"
import { formatSlim } from "../src/format.js"
import { Result, Ok, Err, __type_matches__, __def_struct__ } from "../src/external/core.js"

const sourceFile = path.join(process.cwd(), "__pipe_result_tests__", "input.slim")
const runtime = pathToFileURL(path.join(process.cwd(), "src/external/core.js")).href
function compile(source, options = {}) { return transform(source, sourceFile, options).code }
function run(source, options = {}) {
    const code = compile(source, options).replace(/^import\s+[^;]*(?:defaults|core)\.js";$/m, `import ${JSON.stringify(runtime)};`)
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code], { encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
}

test("pipe chains insert the value first and associate left", () => {
    assert.equal(run(`
        const f = (x, y = 0, z = 0) => x + y + z
        const g = x => x * 3
        log(2 |> f)
        log(2 |> f |> g)
        log(2 |> f(3, 4) |> g |> f(1) |> g)
        log(2 |> (v => v * 2))
    `), "2\n6\n84\n4")
})

test("pipe priority follows arithmetic, comparisons and logical operators", () => {
    assert.equal(run(`
        const double = x => x * 2
        const inspect = x => typeof x
        let value = 1 + 2 * 3 |> double
        log(value)
        log(1 + 2 < 4 |> inspect)
        log(false || 5 |> double)
        log(1 | 2 |> double)
        log(1 |> double ? "yes" : "no")
        log(5 | 2)
    `), "14\nboolean\n10\n6\nyes\n7")
})

test("pipe methods keep this and await applies to the inserted call", () => {
    assert.equal(run(`
        const obj = { n: 5, method(v, extra = 0) { return this.n + v + extra } }
        async func handler(v, n = 1) { return v * n }
        log(2 |> obj.method)
        log(2 |> obj.method(3))
        log(2 |> await handler(3) |> obj.method |> await handler)
        log(2 |> await (async v => v * 4))
    `), "7\n10\n11\n8")
})

test("invalid pipe targets report their original position", () => {
    for (const rhs of ["123", "null", "f + 1", "{}", "new Date()"])
        assert.throws(() => compile(`const f = x => x\nconst value = 1 |> ${rhs}`), error =>
            error.slimSyntaxError && /Right side of \|>/.test(error.message) && /input.slim:2:20/.test(error.message))
    assert.throws(() => compile("func f() { return 1 |> await g }"), /requires an async function/)
})

test("operator-looking strings, regexes, comments and legacy pipes stay intact", () => {
    assert.equal(run(`
        const nums = [1, 2]
        log("a |> b?", /\\|>\\?/.source)
        log(\`template \${2 |> (v => v + 1)}\`)
        nums
        | map(x => x * 2)
        | forEach(log)
    `), "a |> b? \\|>\\?\ntemplate 3\n2 0 [ 2, 4 ]\n4 1 [ 2, 4 ]")
})

test("Result variants expose methods and preserve untouched variants", () => {
    const ok = Ok(3), err = Err("bad")
    assert.ok(ok instanceof Result)
    assert.equal(ok.isOk(), true)
    assert.equal(ok.isErr(), false)
    assert.equal(err.isErr(), true)
    assert.equal(ok.unwrap(), 3)
    assert.throws(() => err.unwrap(), error => error.cause === "bad")
    assert.equal(ok.unwrapOr(0), 3)
    assert.equal(err.unwrapOr(0), 0)
    assert.equal(ok.map(x => x * 2).unwrap(), 6)
    assert.equal(err.map(() => assert.fail()), err)
    assert.equal(ok.mapErr(() => assert.fail()), ok)
    assert.equal(err.mapErr(x => x.length).error, 3)
    assert.equal(ok.andThen(x => Ok(x + 1)).unwrap(), 4)
    assert.equal(ok.andThen(() => err), err)
    assert.equal(err.andThen(() => assert.fail()), err)
    assert.throws(() => ok.andThen(() => 1), /expects Ok/)
    assert.equal(Object.isFrozen(err), true)
})

test("Result<T,E> checks the active payload at runtime", () => {
    assert.equal(__type_matches__("Result<int, string>", Ok(3)), true)
    assert.equal(__type_matches__("Result<int, string>", Err("bad")), true)
    assert.equal(__type_matches__("Result<int, string>", Ok("bad")), false)
    assert.equal(__type_matches__("Result<int, string>", Err(3)), false)
    assert.equal(__type_matches__("Result<int, string>", { ok: true, value: 3 }), false)
    assert.equal(__type_matches__("Result<Result<int, string>, Error>", Ok(Ok(4))), true)
    assert.equal(__type_matches__("Result<int | string, Error>", Ok("a")), true)
    assert.equal(run(`
        const dynamic = JSON.parse("{\\"value\\": 3}").value
        let r: Result<int, string> = Ok(dynamic)
        log(r.unwrap())
        r = Err("bad")
        log(r.error)
        try { r = Ok("wrong") } catch (e) { log("rejected") }
        try { let e: Result<int, string> = Err(4) } catch (e) { log("rejected error") }
    `, { check: false }), "3\nbad\nrejected\nrejected error")
})

test("Result annotations preserve lexical type references and nested unions", () => {
    assert.equal(run(`
        class Payload {}
        let r: Result<Payload, string> = Ok(new Payload())
        log(r.unwrap() instanceof Payload)
        let u: Result<int | string, Error>? = Ok("hello")
        log(u.unwrap())
        u = null
        log(u)
    `), "true\nhello\nnull")
})

test("the checker rejects incompatible Result payloads and error propagation", () => {
    assert.throws(() => compile(`let r: Result<int, string> = Ok("bad")`), /expects Result<int, string>/)
    assert.throws(() => compile(`func f() -> Result<int, string> { return Err(3) }`), /must return Result<int, string>/)
    assert.throws(() => compile(`func f() -> Result<int, string> { return Ok(1?) }`), /Postfix \? expects Result/)
    assert.throws(() => compile(`func f(r: Result<int, int>) -> Result<int, string> { return Ok(r?) }`), /propagates int/)
})

test("tryVerify returns validation issues and keeps verify/verifySafe contracts", () => {
    const struct = __def_struct__("PipeResultValidation", { x: "int" })
    const object = { x: 4 }
    assert.equal(struct.tryVerify(object).unwrap(), object)
    const failed = struct.tryVerify({ x: "bad" })
    assert.equal(failed.isErr(), true)
    assert.equal(failed.error[0].path, "PipeResultValidation.x")
    assert.throws(() => struct.verify({ x: "bad" }))
    const safe = struct.verifySafe({ x: "bad" })
    assert.deepEqual(Object.keys(safe), ["ok", "value", "errors"])
    assert.equal(safe.success, false)
    assert.equal(safe.errors[0].path, failed.error[0].path)
    assert.equal(run(`
        struct Input {
            value: int
        }
        func read(obj) -> Result<int, Array<object>> {
            const input = Input.tryVerify(obj)?
            return Ok(input.value)
        }
        log(read({value: 7}).unwrap())
        log(read({value: "bad"}).isErr())
    `), "7\ntrue")
})

test("Result works with match variant, payload and guarded patterns", () => {
    assert.equal(run(`
        const r = Ok(3)
        log(match(r) { Ok(3) => "exact", Err => "error", _ => "other" })
        log(match(Err("bad")) { Ok => "ok", Err => "err" })
        log(match(r) { v when v.isOk() => v.unwrap(), _ => 0 })
    `), "exact\nerr\n3")
})

test("? unwraps multiple positions and nested results, evaluates once, preserves Err identity", () => {
    assert.equal(run(`
        let calls = 0
        const value = x => { calls++; return Ok(x) }
        const err = Err("original")
        func sum(a, b) -> Result<int, string> { return Ok(value(a)? + value(b)?) }
        func nested() -> Result<int, string> { return Ok((Ok(Ok(4))?)?) }
        func consecutive() -> Result<int, string> { const n = Ok(Ok(Ok(5)))???; return Ok(n) }
        func stop() -> Result<int, string> { const x = err?; log("unreachable"); return Ok(x) }
        log(sum(2, 3).unwrap(), calls, nested().unwrap(), consecutive().unwrap(), stop() === err)
    `), "5 2 4 5 true")
})

test("? retains typed variable instrumentation after lifting the initializer", () => {
    assert.equal(run(`
        func f() -> Result<int, string> {
            let x: int = Ok(3)?
            try { x = JSON.parse("\\"wrong\\"") } catch(e) { log("checked") }
            return Ok(x)
        }
        log(f().unwrap())
    `), "checked\n3")
})

test("nested typed and async arrows have their own early return context", () => {
    assert.equal(run(`
        func outer() -> Result<int, string> {
            const inner = (r) -> Result<int, string> => Ok(r? + 1)
            log(inner(Err("inner")).error)
            return inner(Ok(3))
        }
        const asyncInner = async r => Ok(r?)
        log(outer().unwrap())
        log((await asyncInner(Err("async"))).error)
    `), "inner\n4\nasync")
})

test("? outside an eligible function is a static error even with checks disabled", () => {
    for (const source of ["const x = Ok(1)?", "func f() { return Ok(1)? }", "func f() -> int { return Ok(1)? }",
        "func f() -> Result<int, string> { const inner = () => Ok(1)?; return Ok(1) }"])
        for (const check of [true, false]) assert.throws(() => compile(source, { check }), /Postfix \? requires/)
    assert.throws(() => compile("async function f(x = Ok(1)?) { return x }"), /parameter default/)
})

test("? keeps short-circuit, ternary, optional chaining and nullish coalescing behavior", () => {
    assert.equal(run(`
        const err = Err("bad")
        func f(r) -> Result<int, string> {
            const x = false && err?
            const y = true || err?
            const z = 3 ?? err?
            const v = true ? r? : err?
            const missing = null
            log(missing?.[err?], missing?.method(err?))
            return Ok((v > 0 ? v : 0) + z)
        }
        log(f(Ok(2)).unwrap())
        log(f(err) === err)
        log(({x: 3})?.x, null?.x)
        const choose = true ? x => x + 1 : x => x - 1
        let assigned = 0
        log(choose(2), true ? assigned = 4 : 0, assigned)
        let nullable: int? = null
        log(nullable, (1 ?? +2), (null ?? 3))
    `), "undefined undefined\n5\ntrue\n3 undefined\n3 4 4\nnull 1 3")
})

test("? preserves left-to-right argument order, getters, spreads, assignments and this", () => {
    assert.equal(run(`
        func f() -> Result<int, string> {
            let n = 1
            const obj = { n: 5, get method() { log("getter"); return function(a,b) { return this.n+a+b } } }
            const mutate = () => { n = 3; return Ok(2) }
            log(obj.method(n, mutate()?))
            log(n + mutate()?)
            const list = [1, 2]
            const append = () => { list.push(3); return Ok(4) }
            log([...list, append()?].join(","))
            n += Ok(4)?
            log(n)
            const values = { [Ok("key")?]: Ok(5)?, ...{more: 6} }
            return Ok(values.key)
        }
        log(f().unwrap())
    `), "getter\n8\n5\n1,2,4\n7\n5")
})

test("Err skips subsequent arguments and user finally still executes", () => {
    assert.equal(run(`
        const err = Err("bad")
        const side = () => { log("side"); return 1 }
        func f() -> Result<int, string> {
            try { return Ok(Math.max(side(), err?, side())) }
            finally { log("finally") }
        }
        log(f() === err)
    `), "side\nfinally\ntrue")
})

test("? runs in loops and conditions at their original evaluation points", () => {
    assert.equal(run(`
        func f() -> Result<int, string> {
            let n = 0
            while (Ok(n < 2)?) { n++ }
            do { n++; if(n < 4) continue } while (Ok(n < 5)?)
            for (let i = 0; Ok(i < 2)?; i++) { n += Ok(1)? }
            for (const i of Ok([1,2])?) { n += i }
            if (Ok(n > 0)?) return Ok(n)
            return Ok(0)
        }
        log(f().unwrap())
    `), "10")
})

test("? and pipe compose with awaited results", () => {
    assert.equal(run(`
        async func fetchValue(v) { return Ok(v * 2) }
        async func f(v) -> Result<int, string> {
            const a = (v |> await fetchValue)?
            const b = a |> (x => Ok(x + 1))?
            return Ok(b)
        }
        log((await f(3)).unwrap())
    `), "7")
})

test("new constructs format idempotently with aligned pipe steps and typed multiline initializers", () => {
    const source = `func f() -> Result<int, string> {\nlet x: int = Ok(2)? |> (v => v + 1) |> (v => v * 2)\nreturn Ok(x)\n}`
    const formatted = formatSlim(source)
    assert.equal(formatSlim(formatted), formatted)
    assert.match(formatted, /\n        \|> \(v => v \+ 1\)\n        \|> \(v => v \* 2\)/)
    assert.equal(run(formatted + "log(f().unwrap())"), "6")
    assert.equal(formatSlim('log("a |> b?")\n// a |> b\n'), 'log("a |> b?")\n// a |> b\n')
})

test("lowered operators are ordinary JS and sourcemaps retain original pipe operand and ? locations", async () => {
    const source = `func f(r) -> Result<int, string> {\n    const value = r?\n    return Ok(value |> Math.abs)\n}`
    const code = compile(source)
    const body = code.split("//# sourceMappingURL")[0]
    assert.doesNotThrow(() => parse(body, { sourceType: "module" }))
    assert.doesNotMatch(body, /function\*|yield|throw|__slim_result_try__|\|>/)
    const map = JSON.parse(Buffer.from(code.split("base64,")[1], "base64").toString())
    await SourceMapConsumer.with(map, null, consumer => {
        const lines = body.split("\n")
        for (const [text, line, column] of [["if (_result.isErr())", 2, 19], ["Math.abs", 3, 23]]) {
            const index = lines.findIndex(sourceLine => sourceLine.includes(text))
            const mapped = consumer.originalPositionFor({ line: index + 1, column: lines[index].indexOf(text) })
            assert.equal(mapped.source, sourceFile)
            assert.equal(mapped.line, line)
            assert.equal(mapped.column, column)
        }
    })
    assert.throws(() => compile("const r = Ok(1)\nconst value = r?"), /input.slim:2:16/)
})
