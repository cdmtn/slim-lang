import assert from "node:assert/strict"
import { test } from "node:test"
import { preprocess } from "../src/syntax/index.js"

function lower(source) {
    return preprocess(source, "x.slim").code
}

test("declarations inside string literals are not transformed", () => {
    const code = lower(`log("func foo() {}")\nlog("struct User { name: string }")`)
    assert.match(code, /"func foo\(\) \{\}"/)
    assert.match(code, /"struct User \{ name: string \}"/)
    assert.doesNotMatch(code, /function foo/)
    assert.doesNotMatch(code, /__def_struct__/)
})

test("declarations inside template literals are not transformed", () => {
    const code = lower("log(`enum Role { Admin: 1 }`)")
    assert.match(code, /enum Role \{ Admin: 1 \}/)
    assert.doesNotMatch(code, /__def_enum__/)
})

test("real declarations next to string look-alikes still lower", () => {
    const code = lower(`const label = "func in a string"\nfunc real() { return 1 }`)
    assert.match(code, /"func in a string"/)
    assert.match(code, /function real\(\)/)
})

test("the ~/ operator is not matched inside a regex literal", () => {
    const code = lower(`x.replaceAll(/\\~\\~(.*?)\\~\\~/g, "a")`)
    assert.match(code, /\/\\~\\~\(\.\*\?\)\\~\\~\/g/)
    assert.doesNotMatch(code, /__intdiv__/)
})

test("the ~/ operator still lowers in real code", () => {
    const code = lower(`const half = a ~/ b`)
    assert.match(code, /__intdiv__\(a, b\)/)
})

test("a || continuation line is not consumed by the pipe transform", () => {
    const code = lower(`const v = (a\n  || b\n  || c)\nvar x = 1`)
    assert.match(code, /\|\| b/)
    assert.match(code, /\|\| c/)
    assert.match(code, /var x = 1/)
})

test("an old pipe step is an error, not a silent bitwise OR", () => {
    assert.throws(() => lower(`nums\n| map(n => n * 2)`), /Pipe steps \("\| map\(\.\.\.\)"\) were removed: chain the method instead, "\.map\(\.\.\.\)"/)
    assert.match(lower(`const flags = 1 |\n    read(2)`), /1 \| read\(2\)/)
})

test("the lock keyword is not matched as a substring of an identifier", () => {
    const code = lower(`const f = (clock = false) => clock\nlet block = 1`)
    assert.match(code, /clock = false/)
    assert.match(code, /let block = 1/)
    assert.doesNotMatch(code, /__lock_object__/)
})

test("the lock operator still lowers at a word boundary", () => {
    assert.match(lower(`lock const x = {a: 1}`), /const x = __lock_object__\(/)
    assert.match(lower(`lock obj.state`), /__lock_object__\(obj\.state\)/)
})

test("a parameter default may nest calls to any depth", () => {
    const code = lower(`func f(a: int = max(1, min(2, add(3, mul(4, 5))))) { return a }`)
    assert.match(code, /function f\(a = max\(1, min\(2, add\(3, mul\(4, 5\)\)\)\)\)/)
    assert.match(code, /__typed_parameter__\(a, "int"/)
})

test("brackets inside a parameter default string do not end the list", () => {
    assert.match(lower(`func f(a: string = ")") { return a }`), /function f\(a = "\)"\)/)
    assert.match(lower(`func f(a: string = "}") { return a }`), /function f\(a = "\}"\)/)
})

test("a comma inside a default string does not split the parameter list", () => {
    const code = lower(`func f(a: string = "x,y", b: int = 1) { return b }`)
    assert.match(code, /function f\(a = "x,y", b = 1\)/)
})

test("generics nest past two levels in an annotation", () => {
    const code = lower(`let m: Map<string, Array<Map<int, string>>> = new Map()`)
    assert.match(code, /__typed_variable__\(new Map\(\), "Map<string, Map<int, string>\[\]>", "m"\)/)
})

test("a union type may continue on the next line", () => {
    const code = lower(`let x: int\n    | string = 1`)
    assert.match(code, /__typed_variable__\(1, "int \| string", "x"\)/)
})

test("and/or stay identifiers where an operator cannot appear", () => {
    const code = lower(`const o = { and: 1, or: 2 }\nlog(o.and)`)
    assert.match(code, /\{\s*and: 1,\s*or: 2\s*\}/)
    assert.match(code, /log\(o\.and\)/)
})

test("and/or still lower between operands", () => {
    assert.match(lower(`log(a and b)`), /log\(a && b\)/)
    assert.match(lower(`log(f() or g())`), /log\(f\(\) \|\| g\(\)\)/)
})

test("a match nested in a case result is lowered too", () => {
    const code = lower(`const s = match (a) {\n    1 => match (b) { 2 => "x", _ => "y" },\n    _ => "z"\n}`)
    assert.doesNotMatch(code, /match \(/)
    assert.match(code, /__match_eq__\(__match, 2\)/)
})

test("a struct method may nest calls in its body", () => {
    const code = lower(`struct P {\n    x: int\n    scaled() { return Math.max(1, Math.min(2, this.x)) }\n}`)
    assert.match(code, /"scaled": function \(\) \{\s*return Math\.max\(1, Math\.min\(2, this\.x\)\);\s*\}/)
})

test("bars that are not a pipe chain are left alone", () => {
    const code = lower(`let x: int\n    | string = 1\nlog(x)`)
    assert.match(code, /log\(x\)/)
})
