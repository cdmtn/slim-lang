import assert from "node:assert/strict"
import { test } from "node:test"
import { preprocess } from "../src/syntax/index.js"
import { transform } from "../src/transform.js"
import { formatSlim } from "../src/format.js"

const lower = source => preprocess(source, "x.slim").code

function syntaxError(source) {
    try {
        transform(source, "x.slim", { check: false })
    } catch (error) {
        return error.message
    }
    return null
}

test("regex and division are told apart by the parser", () => {
    assert.match(lower("const r = /a\\/b/g.test(s)"), /\/a\\\/b\/g\.test\(s\)/)
    assert.match(lower("const half = total / 2 / count"), /total \/ 2 \/ count/)
    assert.match(lower("const x = a\n/ b"), /a \/ b/)
})

test("templates nest inside templates and markup", () => {
    assert.match(lower("const s = `a ${`b ${c}`} d`"), /`a \$\{`b \$\{c\}`\} d`/)
    assert.match(lower("component C() {\n    return <p>${`x ${y}`}</p>\n}"), /__html__`<p>\$\{`x \$\{y\}`\}<\/p>`/)
})

test("markup text is text: comments, quotes and words inside it stay as written", () => {
    const code = lower(`component C() {
    return <p>don't stop, http://example.com, a and b, empty list</p>
}`)
    assert.match(code, /<p>don't stop, http:\/\/example\.com, a and b, empty list<\/p>/)
})

test("types: generics, nullable, enum members, functions, literals", () => {
    const code = lower(`
let m: Map<string, Array<int | null>> = new Map()
let n: string? = null
let r: Role::Admin = Role.Admin
let f: function = () => 1
let l: "a" | 'b' | 1 = "a"`)
    assert.match(code, /"Map<string, \(int \| null\)\[\]>"/)
    assert.match(code, /"string\?"/)
    assert.match(code, /"Role::Admin"/)
    assert.match(code, /"function"/)
    assert.match(code, /"\\"a\\" \| \\"b\\" \| 1"/)
})

test("return types with -> and : on every kind of function", () => {
    const code = lower(`
func a() -> int { return 1 }
function b(): int { return 1 }
const c = (x: int) -> int => x
const d = async (x: int) -> int => x
const o = { e(x: int): int { return x } }
class K { f() -> int { return 1 } }`)
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
        assert.match(code, new RegExp(`__declare_return__\\("int", "${name}"\\)`))
    }
})

test("export default const and typed class fields", () => {
    const code = lower(`export default const D: int = 5
class K {
    static count: int = 0
    #secret: string = "s"
}`)
    assert.match(code, /const D = __typed_variable__\(5, "int", "D"\);\nexport \{ D as default \};/)
    assert.match(code, /static count = __typed_variable__\(0, "int", "count"\)/)
    assert.match(code, /#secret = __typed_variable__\("s", "string", "#secret"\)/)
})

test("elif chains and nested match", () => {
    const code = lower(`if (a) { x() } elif (b) { y() } elif (c) { z() } else { w() }
const r = match (a) {
    1 => match (b) { 2 => "x", _ => "y" },
    _ => "z"
}`)
    assert.match(code, /else if \(b\) \{[\s\S]*else if \(c\)/)
    assert.equal((code.match(/__match =>/g) ?? []).length, 2)
})

test("syntax errors point at the Slim source", () => {
    assert.match(syntaxError(`use "path" from "node:path"`), /write "use name from \.\.\." instead of "use "path" from \.\.\."[\s\S]*x\.slim:1:5/)
    assert.match(syntaxError(`struct User {\n    name string\n}`), /x\.slim:2:10/)
    assert.match(syntaxError(`func f() {\n    return 1\n`), /end of file/)
    assert.match(syntaxError(`interface A { x: int }`), /not supported in Slim/)
})

test("JavaScript keeps working: classes, destructuring, optional chaining, getters", () => {
    const code = lower(`class A extends B {
    #x = 1
    get x() { return this.#x }
    static { init() }
}
const { a, b: [c, ...d] = [] } = obj
log(obj?.deep?.[key] ?? fallback, a ** 2, 2n)`)
    assert.match(code, /get x\(\) \{/)
    assert.match(code, /static \{/)
    assert.match(code, /obj\?\.deep\?\.\[key\] \?\? fallback/)
})

test("the formatter indents markup by tags and keeps template text", () => {
    const formatted = formatSlim(`component Card(props) {
return <div>
<p>don't {break}</p>
<style>
a { color: red }
</style>
</div>
}
const s = \`x
\${y}
  z\``)
    assert.equal(formatted, `component Card(props) {
    return <div>
        <p>don't {break}</p>
        <style>
            a { color: red }
        </style>
    </div>
}
const s = \`x
\${y}
  z\`
`)
    assert.equal(formatSlim(formatted), formatted)
})

test("the formatter indents method chains and union lines under their source", () => {
    assert.equal(formatSlim("const n = list\n.map(f)\n.filter(g)"), "const n = list\n    .map(f)\n    .filter(g)\n")
    assert.equal(formatSlim("let x: int\n| string = 1"), "let x: int\n    | string = 1\n")
})

test("mistakes inside ${...} in markup are reported where they are", () => {
    const D = "$"
    const at = (source, pattern, column) => {
        const message = syntaxError(source)
        assert.match(message, pattern)
        assert.ok(message.includes(`x.slim:`) && new RegExp(`:${column}\\n`).test(message), message)
    }
    at(`component A(p) {\n    return <div>${D}{p.name</div>\n}`, /"\$\{" is not closed: add "\}" after the expression/, 17)
    at(`component A(p) {\n    return <div class=${D}{p.cls>x</div>\n}`, /"\$\{" is not closed/, 23)
    at(`component A(p) {\n    return <div>${D}{p.name +}</div>\n}`, /expression inside \$\{\.\.\.\} is incomplete/, 27)
    at(`component A(p) {\n    return <div>${D}{}</div>\n}`, /Empty \$\{\} in markup/, 17)
    at(`component A(p) {\n    return <div>${D}{if (x) 1}</div>\n}`, /"if" is a statement and can't go inside/, 19)
    at(`const x = <div>${D}{1 2}</div>`, /Expected "\}" to close "\$\{", got "2"/, 20)
    at(`component A(p) {\n    return <ul>${D}{p.items.map(i => <li>${D}{i.}</li>)}</ul>\n}`, /incomplete/, 43)
})

test("generic arrows parse next to markup, and their type parameters check nothing at runtime", () => {
    assert.match(lower(`const f = <T>(x: T) => x`), /const f = x => x/)
    assert.match(lower(`const g = <T, U>(x: T, y: U) => y`), /const g = \(x, y\) => y/)
    assert.match(lower(`const h = <T>(x: T) -> T[] => [x]`), /__declare_return__\("any\[\]", "h"\)/)
    assert.match(lower(`struct Box<T> {\n    value: T\n    set(v: T) { this.value = v }\n}`), /"value": "T"/)
})

test("a bare unexpected token is named", () => {
    assert.match(syntaxError(`let x = (1 + )`), /Unexpected "\)"/)
})
