import assert from "node:assert/strict"
import { test } from "node:test"
import { type } from "../src/external/defaults.js"
import { CASES } from "./type-table.cases.mjs"

// Expected strings were captured from the implementation that preceded the
// single-pass rewrite of type(); they pin its observable behaviour.
const EXPECTED = 
{
    "null": "null",
    "undefined": "undefined",
    "NaN": "NaN",
    "int 0": "int",
    "int -3": "int",
    "float": "float",
    "Infinity": "float",
    "string": "string",
    "empty string": "string",
    "bool true": "bool",
    "bool false": "bool",
    "bigint": "bigint",
    "symbol": "symbol",
    "function": "function",
    "class": "class",
    "type fn": "type",
    "component fn": "component",
    "fragment fn": "fragment",
    "element": "element",
    "fragment": "fragment",
    "text node": "object",
    "object": "object",
    "object with a": "object",
    "struct": "struct",
    "enum via type": "enum",
    "enum value": "enum",
    "SVT int": "int",
    "SVT string": "string",
    "SVT array": "int[]",
    "map": "map",
    "set": "set",
    "date": "date",
    "promise": "promise",
    "regexp": "regexp",
    "error": "error",
    "[]": "null[]",
    "[undefined]": "null[]",
    "[undefined, undefined]": "null[]",
    "[null]": "array",
    "[null, null]": "array",
    "[undefined, null]": "array",
    "[1,2,3]": "int[]",
    "[1.5,2.5]": "float[]",
    "[1,2.5]": "number[]",
    "[2.5,1]": "number[]",
    "[1,2.5,\"a\"]": "array",
    "[1,\"a\"]": "array",
    "[\"a\",1]": "array",
    "[NaN]": "number[]",
    "[NaN,NaN]": "number[]",
    "[1,NaN]": "number[]",
    "[NaN,1.5]": "number[]",
    "[Infinity,1]": "number[]",
    "[\"a\",\"b\"]": "string[]",
    "[true,false]": "array",
    "[true,1]": "array",
    "[{},{}]": "object[]",
    "[{a:1},{}]": "object[]",
    "[{},1]": "array",
    "[struct,struct]": "struct[]",
    "[enum,enum]": "enum[]",
    "[enum,enumvia]": "enum[]",
    "[[],[]]": "array",
    "[[null],[null]]": "array[]",
    "[[1],[2]]": "array",
    "[[1],[\"a\"]]": "array",
    "[[1],[null]]": "array",
    "[[],[1]]": "array",
    "[[[1]]]": "array[]",
    "[SVT int, SVT int]": "int[]",
    "[SVT int, 1]": "int[]",
    "[SVT int, 1.5]": "array",
    "[1, SVT float]": "array",
    "[fn,fn]": "array",
    "[K,K]": "array",
    "[10n,10n]": "array",
    "[Map,Map]": "array",
    "[1,undefined]": "array",
    "[undefined,1]": "array",
    "[1,null]": "array",
    "sparse [1,,3]": "int[]",
    "holes x3": "null[]",
    "[1,,1.5]": "number[]",
    "array with nodeType 1": "element"
}

test("type() table is covered by EXPECTED", () => {
    assert.deepEqual(Object.keys(CASES), Object.keys(EXPECTED))
})

for (const [name, make] of Object.entries(CASES)) {
    test(`type() table: ${name}`, () => {
        assert.equal(type(make()), EXPECTED[name])
    })
}

test("type() leaves arrays unmutated and uncached", () => {
    const list = [1, 2, 3]
    assert.equal(type(list), "int[]")
    list.push(1.5)
    assert.equal(type(list), "number[]")
    list.push("x")
    assert.equal(type(list), "array")
})

test("type() agrees with Type.isAnyArray on arrays", async () => {
    const { Type } = await import("../src/external/defaults.js")
    assert.equal(Type.isAnyArray([1, 2]), true)
    assert.equal(Type.isAnyArray([]), true)
    assert.equal(Type.isAnyArray([1, "a"]), true)
    assert.equal(Type.isAnyArray("a"), false)
})
