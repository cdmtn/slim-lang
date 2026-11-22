import assert from "node:assert/strict"
import { test } from "node:test"
import { parse } from "@babel/parser"
import { transform } from "../src/transform.js"

function compilesToValidJs(source) {
    const { code } = transform(source, "x.slim")
    const body = code.split("//# sourceMappingURL")[0]
    assert.doesNotThrow(() => parse(body, { sourceType: "module", plugins: ["jsx"] }))
    return body
}

test("enum members can hold object values (balanced body extraction)", () => {
    const body = compilesToValidJs(`enum E {
        A: { x: 1 }
        B: 2
    }`)
    assert.match(body, /__def_enum__/)
})

test("a struct body with a brace-bearing field survives extraction", () => {
    compilesToValidJs(`struct Config {
        handler: any
        limit: int
    }
    const cfg = { nested: { deep: 1 } }`)
})

test("nested generic annotations compile", () => {
    compilesToValidJs(`func f(m: Map<string, Array<int>>) { return m }`)
    compilesToValidJs(`const x: any = new Map()
let m: Map<string, Map<int, bool>> = x`)
})
