import assert from "node:assert/strict"
import { test } from "node:test"
import {
    __def_struct__, __def_enum__, __type_def__, __type_ref__, __type_spec__,
    __type_spec_all__, __typed__
} from "../src/external/core.js"
import { StructError, StructPassedError, StructExpectError } from "../src/external/classErrors.js"
import { createLegacyRuntime } from "./legacy-type-matcher.mjs"

const ref = (label, resolve) => __type_ref__(label, resolve)
const spec = (...labels) => __type_spec__(...labels.map(label => ref(label)))
const Tag = __def_struct__("ValidationTag", { name: "string", weight: "int" })
const User = __def_struct__("ValidationUser", { name: "string", tags: "ValidationTag[]", "*nick": "string", note: "nullable" }, {
    note: spec("string", "null", "undefined")
})

test("verifyAll collects nested array, missing, extra and scalar violations in one result", () => {
    const object = { name: 5, tags: [{ name: 7 }, { name: false, weight: 1.5 }], extra: true }
    const result = User.verifyAll(object)
    assert.deepEqual(Object.keys(result), ["ok", "value", "errors"])
    assert.equal(result.ok, false)
    assert.equal(result.value, undefined)
    assert.deepEqual(result.errors.map(({ path, expected, got, code }) => ({ path, expected, got, code })), [
        { path: "ValidationUser.extra", expected: "no extra field", got: "bool", code: "S0003" },
        { path: "ValidationUser.name", expected: "string", got: "int", code: "S0001" },
        { path: "ValidationUser.tags[0].name", expected: "string", got: "int", code: "S0001" },
        { path: "ValidationUser.tags[0].weight", expected: "int", got: "undefined", code: "S0002" },
        { path: "ValidationUser.tags[1].name", expected: "string", got: "bool", code: "S0001" },
        { path: "ValidationUser.tags[1].weight", expected: "int", got: "float", code: "S0001" },
        { path: "ValidationUser.note", expected: "string | null | undefined", got: "undefined", code: "S0002" }
    ])
    assert.equal(result.errors[5].message, '"ValidationUser.tags[1].weight" expected int, got float: 1.5')
    assert.match(result.errors[5].hint, /whole number/)
    assert.throws(() => User.verify(object), StructPassedError)
})

test("verifySafe has the exhaustive Result contract and compatible first-error aliases", () => {
    const object = { name: 5, tags: [{ name: 7, weight: "bad" }], note: null }
    const result = User.verifySafe(object)
    assert.deepEqual(result, User.verifyAll(object))
    assert.equal(result.errors.length, 3)
    assert.equal(result.success, false)
    const legacy = __typed__(object, User, "errorResult")
    assert.deepEqual(result.result, legacy.result)
    assert.deepEqual(result.properties, legacy.properties)

    const nested = User.verifySafe({ name: "Ada", tags: [{ name: 7, weight: "bad" }], note: null })
    assert.equal(nested.properties.fieldName, "ValidationUser.tags")
    assert.match(nested.result.msg, /"ValidationUser.tags" expected ValidationTag\[\], got object\[\]/)
})

test("successful validation returns the original object and never fills defaults", () => {
    const object = { name: "Ada", tags: [{ name: "x", weight: 1 }], note: null }
    for (const result of [User.verifyAll(object), User.verifySafe(object)]) {
        assert.deepEqual(result, { ok: true, value: object, errors: [] })
        assert.equal(result.value, object)
    }
    assert.equal(User.verifySafe(object).result, object)
    assert.equal(User.verifySafe(object).success, true)
})

test("optional means absent is allowed; nullable means null/undefined are valid present values", () => {
    const base = { name: "Ada", tags: [{ name: "x", weight: 1 }] }
    assert.equal(User.verifyAll({ ...base, note: null }).ok, true)
    assert.equal(User.verifyAll({ ...base, note: undefined }).ok, true)
    const missing = User.verifyAll(base)
    assert.deepEqual(missing.errors.map(error => error.path), ["ValidationUser.note"])
    assert.match(missing.errors[0].hint, /\*field/)
    assert.throws(() => User.verify(base), StructExpectError)
    for (const nick of [null, undefined, 3]) {
        assert.equal(User.verifyAll({ ...base, note: null, nick }).ok, false)
    }
})

test("empty inferred arrays retain their first error and Array<T> accepts empty data", () => {
    const S = __def_struct__("ValidationArrays", { inferred: "string[]", explicit: "Array<string>" })
    const result = S.verifyAll({ inferred: [], explicit: [] })
    assert.deepEqual(result.errors.map(error => error.path), ["ValidationArrays.inferred"])
    assert.match(result.errors[0].hint, /empty.*null\[\]/i)
    assert.throws(() => S.verify({ inferred: [], explicit: [] }), {
        name: "StructError", message: '"ValidationArrays.inferred" expected string[], got null[]: []'
    })
    assert.equal(S.parse({ inferred: ["x"], explicit: [] }).ok, true)
})

test("enum values, members and scalar unions keep distinct contracts", () => {
    const Role = __def_enum__("ValidationRole", { Admin: "admin", Member: "member" })
    const S = __def_struct__("ValidationChoice", { role: "ValidationRole", member: "ValidationRole::Admin", id: "union" }, {
        id: spec("int", "string")
    })
    assert.equal(S.verifyAll({ role: "member", member: Role.Admin, id: "x" }).ok, true)
    const bad = S.verifyAll({ role: "root", member: "admin", id: false })
    assert.deepEqual(bad.errors.map(({ path, expected }) => ({ path, expected })), [
        { path: "ValidationChoice.role", expected: "ValidationRole" },
        { path: "ValidationChoice.member", expected: "ValidationRole::Admin" },
        { path: "ValidationChoice.id", expected: "int | string" }
    ])
    assert.match(bad.errors[1].hint, /ValidationRole\.Admin itself/)
    assert.equal(S.parse('{"role":"member","member":"admin","id":1}').errors[0].path, "ValidationChoice.member")
})

test("structural unions choose a successful branch and report the closest failed branch", () => {
    const A = __def_struct__("ValidationA", { x: "int" })
    const B = __def_struct__("ValidationB", { y: "string", z: "bool" })
    const S = __def_struct__("ValidationUnion", { item: "union" }, {
        item: __type_spec__(ref("ValidationA", () => A), ref("ValidationB", () => B), ref("null"))
    })
    assert.equal(S.verifyAll({ item: { y: "yes", z: true } }).ok, true)
    assert.equal(S.verifyAll({ item: null }).ok, true)
    assert.deepEqual(S.verifyAll({ item: { x: "bad" } }).errors.map(error => error.path), ["ValidationUnion.item.x"])
    assert.equal(S.verifyAll({ item: false }).errors[0].expected, "ValidationA | ValidationB | null")
})

test("verify stops at the first predicate failure; verifyAll invokes each predicate once", () => {
    let calls = []
    __type_def__("ValidationCounted", value => { calls.push(value); return value > 0 })
    const S = __def_struct__("ValidationCount", { a: "ValidationCounted", b: "ValidationCounted" })
    assert.throws(() => S.verify({ a: -1, b: -2 }), StructError)
    assert.deepEqual(calls, [-1])
    calls = []
    assert.equal(S.verifyAll({ a: -1, b: -2 }).errors.length, 2)
    assert.deepEqual(calls, [-1, -2])
    calls = []
    assert.equal(S.verifySafe({ a: -1, b: -2 }).errors.length, 2)
    assert.deepEqual(calls, [-1, -2], "legacy aliases do not trigger a second pass")
    const Bag = __def_struct__("ValidationCountBag", { items: "ValidationCount[]" })
    calls = []
    assert.equal(Bag.verifyAll({ items: [{ a: 1, b: -2 }, { a: -3, b: 4 }] }).errors.length, 2)
    assert.deepEqual(calls, [1, -2, -3, 4])
})

test("recursive, shared and cyclic objects do not hide errors or crash exhaustive validation", () => {
    let Node
    Node = __def_struct__("ValidationNode", { value: "int", next: "nullable" }, {
        next: __type_spec__(ref("ValidationNode", () => Node), ref("null"))
    })
    assert.equal(Node.verifyAll({ value: 1, next: null }).ok, true)
    assert.equal(Node.verifyAll({ value: 1, next: { value: "bad", next: null } }).errors[0].path, "ValidationNode.next.value")
    const cyclic = { value: 1 }
    cyclic.next = cyclic
    assert.equal(Node.verifySafe(cyclic).errors[0].path, "ValidationNode.next")
    const Shared = __def_struct__("ValidationShared", { a: "ValidationTag", b: "ValidationTag" })
    const item = { name: 7, weight: 1 }
    assert.deepEqual(Shared.verifyAll({ a: item, b: item }).errors.map(error => error.path), ["ValidationShared.a.name", "ValidationShared.b.name"])
})

test("parse applies inherited and nested defaults without mutating input; mutable defaults are fresh", () => {
    const Child = __def_struct__("ValidationDefaultChild", { name: "string" }, {}, { name: () => "guest" })
    __def_struct__("ValidationDefaultBase", { active: "bool" }, {}, { active: () => true })
    const S = __def_struct__("ValidationDefaults", { items: "Array<ValidationDefaultChild>", data: "object" }, {},
        { data: () => ({ n: 0 }) }, "ValidationDefaultBase")
    const input = Object.freeze({ items: Object.freeze([Object.freeze({})]) })
    const a = S.parse(input)
    assert.deepEqual(a, { ok: true, value: { items: [{ name: "guest" }], data: { n: 0 }, active: true }, errors: [] })
    assert.deepEqual(input, { items: [{}] })
    a.value.data.n = 9
    assert.equal(S.parse(input).value.data.n, 0)
    assert.equal(S.parse(input).value.items[0].name, "guest")
    assert.equal(Child.verifyAll({}).ok, false, "verifyAll does not apply defaults")
    assert.equal(S.parse({ items: [], active: false, data: { n: 5 } }).value.active, false)
    assert.equal(S.parse({ items: [], active: undefined }).ok, false, "present undefined does not take a default")
})

test("parse checks default values and structural union defaults", () => {
    const Bad = __def_struct__("ValidationBadDefault", { n: "int" }, {}, { n: () => "bad" })
    assert.equal(Bad.parse({}).errors[0].path, "ValidationBadDefault.n")
    const Defaulted = __def_struct__("ValidationDefaulted", { n: "int" }, {}, { n: () => 7 })
    const Outer = __def_struct__("ValidationDefaultUnion", { item: "union" }, {
        item: __type_spec__(ref("ValidationDefaulted", () => Defaulted), ref("string"))
    })
    assert.deepEqual(Outer.parse({ item: {} }).value, { item: { n: 7 } })
})

test("parse points at nested JSON tokens with one-based line/col and offsets", () => {
    const text = '{\n  "name": 5,\n  "tags": [{"name":"a","weight":1}, {"name":false,"weight":1.5}],\n  "note": null\n}'
    const result = User.parse(text)
    assert.deepEqual(result.errors.map(({ path, line, col, offset, length }) => ({ path, line, col, offset, length })), [
        { path: "ValidationUser.name", line: 2, col: 11, offset: text.indexOf("5"), length: 1 },
        { path: "ValidationUser.tags[1].name", line: 3, col: 45, offset: text.indexOf("false"), length: 5 },
        { path: "ValidationUser.tags[1].weight", line: 3, col: 60, offset: text.indexOf("1.5"), length: 3 }
    ])
    for (const error of result.errors) {
        assert.equal(error.file, "<json>")
        assert.equal(error.sourceLine, text.split("\n")[error.line - 1])
    }
})

test("JSON positions support escaped, repeated and awkward keys, arrays and absent fields", () => {
    const S = __def_struct__("ValidationOdd", { 'a.b': "int", 'quo"te': "int", items: "Array<int>" })
    const text = '{"a.b":1, "a.b":"bad", "quo\\\"te":false, "items":[1,"bad"]}'
    const result = S.parse(text)
    assert.deepEqual(result.errors.map(error => error.path), ['ValidationOdd["a.b"]', 'ValidationOdd["quo\\\"te"]', "ValidationOdd.items[1]"])
    assert.deepEqual(result.errors.map(error => error.offset), [text.indexOf('"bad"'), text.indexOf("false"), text.lastIndexOf('"bad"')])
    const missing = User.parse('{"name":"x", "tags":[{}]}')
    assert.equal(missing.errors[0].offset, 21)
    assert.equal(missing.errors.at(-1).offset, 0)
    assert.equal(missing.errors.at(-1).code, "S0002")
})

test("parse returns JSON syntax errors, non-object errors and successful primitives rejected by the schema", () => {
    for (const text of ['{"name":}', '{"name":"x",}', '{"name":"x"', ""]) {
        const result = User.parse(text)
        assert.equal(result.ok, false)
        assert.equal(result.errors[0].code, "S0004")
        assert.equal(result.errors[0].path, "ValidationUser")
        assert.ok(result.errors[0].line >= 1)
        assert.ok(result.errors[0].col >= 1)
    }
    for (const input of [null, [], 7, "null", "7", "[]", '"string"']) {
        const result = User.parse(input)
        assert.equal(result.ok, false)
        assert.equal(result.errors[0].code, "S0001")
    }
})

test("legacy validation acceptance and first-error text agree across existing type rules", () => {
    const legacy = createLegacyRuntime()
    const labels = ["int", "float", "number", "string", "bool", "int[]", "bool[]", "null[]", "number[]", "any[]", "Array<int>", "[int, string]", "Set<int>", "Map<string, int>"]
    const values = [null, undefined, 1, 1.5, "x", true, [], [1], [true], [null], [undefined], [1, "x"], [1, 1.5], [, 1], new Set([1]), new Map([["x", 1]])]
    labels.forEach((label, index) => {
        const S = __def_struct__(`ValidationLegacy${index}`, { value: label })
        const L = legacy.defStruct(S.name, { value: label })
        for (const value of values) {
            const input = { value }
            const expected = legacy.typed(input, L, "errorResult")
            const actual = S.verifySafe(input)
            assert.equal(actual.ok, expected.success, label)
            assert.deepEqual(actual.result, expected.result, label)
            if (!actual.ok) assert.deepEqual(actual.properties, expected.properties, label)
        }
    })
})

test("intersection fields accumulate every predicate failure", () => {
    __type_def__("ValidationPositive", value => value > 0)
    __type_def__("ValidationEven", value => value % 2 === 0)
    const S = __def_struct__("ValidationIntersection", { value: "all" }, {
        value: __type_spec_all__(ref("ValidationPositive"), ref("ValidationEven"))
    })
    assert.equal(S.verifyAll({ value: -1 }).errors.length, 2)
    assert.equal(S.verifyAll({ value: 2 }).ok, true)
})
