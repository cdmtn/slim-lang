import assert from "node:assert/strict"
import { test } from "node:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { tokenize } from "../src/lexer.js"

const root = process.cwd()
const examplesDir = path.join(root, "examples")

function rebuild(code) {
    return tokenize(code).map(token => token.value).join("")
}

for (const name of readdirSync(examplesDir).filter(n => n.endsWith(".slim")).sort()) {
    test(`tokenizing "${name}" is lossless`, () => {
        const code = readFileSync(path.join(examplesDir, name), "utf8")
        assert.equal(rebuild(code), code)
    })
}

const tricky = {
    "division vs regex": "const a = b / c\nconst r = /a+b/gi\nreturn /x/.test(y)",
    "nested templates": "const s = `a ${ `b ${c + 1}` } d`",
    "escaped quotes": "const s = \"a\\\"b\\\\c\"\nconst t = 'x\\'y'",
    "regex character class": "const r = /[/\\]]/g",
    "mixed comments": "// line\nconst a = 1 /* block */ + 2",
    "slim operators": "let x = 10 ~/ 3\nlet r = Role::Admin\nlet u: A & B = x",
    "template with operator": "log(`val ${sizeof x} end`)",
    "division after paren": "const x = (a + b) / c"
}

for (const [label, code] of Object.entries(tricky)) {
    test(`tokenizing ${label} is lossless`, () => {
        assert.equal(rebuild(code), code)
    })
}

test("regex literals are distinguished from division", () => {
    const withRegex = tokenize("const r = /a+b/g")
    assert.ok(withRegex.some(t => t.type === "regex" && t.value === "/a+b/g"))

    const withDivision = tokenize("a / b")
    assert.ok(withDivision.some(t => t.type === "punct" && t.value === "/"))
    assert.ok(!withDivision.some(t => t.type === "regex"))
})

test("keywords and slim operators are classified", () => {
    const tokens = tokenize("struct User\nlet x = 10 ~/ 3")
    assert.equal(tokens.find(t => t.value === "struct")?.keyword, true)
    assert.ok(tokens.some(t => t.type === "punct" && t.value === "~/"))
})

test("pipe uses longest matching punctuation without changing JS bars or questions", () => {
    const source = "a |> f || b | c |= d; r?; x?.y; x ?? y; x ? y : z; let n: int? = null"
    assert.equal(rebuild(source), source)
    assert.deepEqual(tokenize(source).filter(t => t.type === "punct").map(t => t.value),
        ["|>", "||", "|", "|=", ";", "?", ";", "?.", ";", "??", ";", "?", ":", ";", ":", "?", "="])
})

test("keywords inside strings and comments are not names", () => {
    const inString = tokenize("\"a or b\"")
    assert.ok(!inString.some(t => t.type === "name" && t.value === "or"))

    const inComment = tokenize("// struct here")
    assert.ok(!inComment.some(t => t.type === "name" && t.value === "struct"))
})

test("code inside template interpolation is tokenized", () => {
    const tokens = tokenize("`x ${sizeof y} z`")
    assert.ok(tokens.some(t => t.type === "name" && t.value === "sizeof"))
    assert.ok(tokens.some(t => t.type === "template"))
})
