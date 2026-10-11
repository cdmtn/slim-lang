import assert from "node:assert/strict"
import { test } from "node:test"
import {
    __def_struct__, __def_enum__, __type_def__, __type_ref__, __type_spec__, __type_spec_all__,
    __type_matches__, __type_codegen__, __typed__, __typed_variable__, __typed_variable_check__,
    __typed_parameter__, __typed_return__, type
} from "../src/external/core.js"
import { createLegacyRuntime } from "./legacy-type-matcher.mjs"

class Point {}
class Other {}
const ref = (label, resolve) => resolve ? __type_ref__(label, resolve) : __type_ref__(label)

// Declares the same types in the real runtime and in the legacy reference.
// `p` keeps names unique between the closure and the generated variants.
function declare(p) {
    const legacy = createLegacyRuntime()
    const real = { structs: {}, enums: {}, customs: {} }
    const roleValues = { Admin: "admin", Helper: "helper" }

    // Both sides share the enum so member identity comparisons line up.
    real.enums.Role = __def_enum__(`${p}Role`, roleValues)
    legacy.enums[`${p}Role`] = real.enums.Role

    const positive = v => type(v) === "int" && v > 0
    const even = v => typeof v === "number" && v % 2 === 0
    const small = v => typeof v === "number" && v < 100
    for (const [name, fn, props] of [
        ["Positive", positive], ["Even", even],
        ["Small", small, { extends: __type_spec__(__type_ref__(`${p}Positive`)) }],
        ["Pt", Point], ["One", 1]
    ]) {
        real.customs[name] = __type_def__(`${p}${name}`, fn, props)
        legacy.defType(`${p}${name}`, fn, props)
    }
    const idSpec = __type_spec__(__type_ref__("int"), __type_ref__("string"))
    __type_def__(`${p}Id`, idSpec)
    legacy.defType(`${p}Id`, idSpec)

    // Mirrors what transform emits: schema labels plus per-field specifications.
    function struct(name, schema, fields, extendsName = null) {
        const make = (world, define) => {
            const specifications = {}
            for (const [field, [label, ...more]] of Object.entries(fields)) {
                const refs = [label, ...more].map(item => {
                    const [text, local] = item.split("@")
                    return local ? ref(text, () => world.structs[local]) : ref(text)
                })
                specifications[field] = __type_spec__(...refs)
            }
            return define(`${p}${name}`, schema, specifications, {}, extendsName ? `${p}${extendsName}` : null)
        }
        real.structs[name] = make(real, __def_struct__)
        legacy.structs[name] = make(legacy, legacy.defStruct)
    }

    struct("Tag", { name: "string" }, { name: ["string"] })
    struct("User", {
        name: "string", id: "int", roles: "string[]", tags: `${p}Tag[]`, "*nick": "string", "*role": `${p}Role`
    }, {
        name: ["string"], id: ["int"], roles: ["string[]"],
        tags: [`${p}Tag[]@Tag`], nick: ["string"], role: [`${p}Role`]
    })
    struct("Node", { value: "int", next: "x" }, { value: ["int"], next: [`${p}Node@Node`, "null", "undefined"] })
    struct("Base", { id: "int" }, { id: ["int"] })
    struct("Child", { label: "string" }, { label: ["string"] }, "Base")
    struct("Mixed", { a: "any", f: "float", n: "number", b: "bool", t: "[int, string]", s: "Set<int>", m: "Map<string, int>", e: `${p}Role::Admin`, c: "x" }, {
        a: ["any"], f: ["float"], n: ["number"], b: ["bool"], t: ["[int, string]"], s: ["Set<int>"],
        m: ["Map<string, int>"], e: [`${p}Role::Admin`], c: [`${p}Positive`, `${p}Pt`]
    })

    return { real, legacy }
}

function values(w) {
    const role = w.enums.Role
    const user = { name: "a", id: 1, roles: ["x"], tags: [{ name: "t" }] }
    const sparse = [, 1, 2]
    return [
        ["0", 0], ["1", 1], ["-1", -1], ["1.5", 1.5], ["NaN", NaN], ["Infinity", Infinity], ["-0", -0],
        ["''", ""], ["'a'", "a"], ["true", true], ["false", false], ["null", null], ["undefined", undefined],
        ["bigint", 10n], ["symbol", Symbol("s")], ["arrow", () => 1], ["class", class A {}],
        ["empty []", []], ["[1,2]", [1, 2]], ["[1,'a']", [1, "a"]], ["[1,2.5]", [1, 2.5]], ["[1.5,2.5]", [1.5, 2.5]],
        ["['a','b']", ["a", "b"]], ["[true]", [true]], ["[null]", [null]], ["[undefined]", [undefined]],
        ["[[1],[2]]", [[1], [2]]], ["[{}]", [{}]], ["[NaN]", [NaN]], ["sparse", sparse], ["[2,4]", [2, 4]],
        ["[1, 'a', 3]", [1, "a", 3]], ["[1,'a'] pair", [1, "a"]], ["[ 'a', 1 ]", ["a", 1]], ["[1]", [1]],
        ["{}", {}], ["{a:1}", { a: 1 }], ["date", new Date(0)], ["regexp", /x/], ["error", new Error("e")],
        ["promise", Promise.resolve(1)], ["Set(1,2)", new Set([1, 2])], ["Set('a')", new Set(["a"])], ["empty Set", new Set()],
        ["Map(a:1)", new Map([["a", 1]])], ["Map(1:'a')", new Map([[1, "a"]])], ["empty Map", new Map()],
        ["Point", new Point()], ["Other", new Other()],
        ["Role.Admin", role.Admin], ["Role.Helper", role.Helper], ["'admin'", "admin"], ["'helper'", "helper"],
        ["{name}", { name: "t" }], ["{name,constructor}", { name: "t", constructor: 1 }], ["{name,toString}", { name: "t", toString: 1 }], ["{name:1}", { name: 1 }], ["[{name}]", [{ name: "t" }]],
        ["[{name},{name:1}]", [{ name: "t" }, { name: 1 }]], ["user", user], ["user+extra", { ...user, extra: 1 }],
        ["user-roles", { ...user, roles: undefined }], ["user empty roles", { ...user, roles: [] }],
        ["user bad tag", { ...user, tags: [{ name: 1 }] }], ["user nick", { ...user, nick: "n" }],
        ["user role", { ...user, role: role.Admin }], ["user bad role", { ...user, role: "root" }],
        ["user nick undefined", { ...user, nick: undefined }], ["user no tags", { name: "a", id: 1, roles: ["x"] }],
        ["node", { value: 1, next: { value: 2, next: null } }], ["node bad", { value: 1, next: { value: "2", next: null } }],
        ["child", { id: 1, label: "l" }], ["child no id", { label: "l" }]
    ]
}

function specifications(w) {
    const p = w.p
    const t = label => __type_spec__(ref(label))
    const labels = [
        "int", "float", "number", "string", "bool", "null", "undefined", "object", "array", "function", "any",
        "element", "bigint", "symbol", "class", "date", "map", "set", "promise", "regexp", "error", "struct", "enum",
        "int[]", "string[]", "float[]", "bool[]", "any[]", "null[]", "number[]", "object[]", "array[]", "enum[]", "struct[]",
        "Array<int>", "Array<string>", "Array<any>", "Array<int[]>", "Array<Array<int>>", "Set<int>", "Set<string>", "Set",
        "Map<string, int>", "Map<int, string>", "Map", "Map<string>", "Promise<int>", "Date", "RegExp", "Error", "Promise",
        "[int, string]", "[int,[string, bool]]", "[string, int]", "[any]", "[]", "[ int , int ]",
        `${p}Role`, `${p}Role[]`, `${p}Role::Admin`, `${p}Role::Helper`, `${p}Role::Missing`, `Nope::Admin`,
        `${p}Positive`, `${p}Even`, `${p}Small`, `${p}Pt`, `${p}One`, `${p}Id`, `${p}Positive[]`, `${p}Even[]`, `${p}Id[]`,
        `${p}Pt[]`, `Array<${p}Positive>`, `Set<${p}Even>`, `Map<${p}Id, ${p}Positive>`, `[${p}Positive, ${p}Id]`,
        `${p}Tag`, `${p}Tag[]`, `${p}User`, `${p}User[]`, `${p}Node`, `${p}Child`, `Array<${p}Tag>`, `Nope`, `Nope[]`,
        `Foo<${p}Tag>`, `${p}Tag<int>`, "int | string", "", " "
    ]
    const list = labels.map(label => [label, () => t(label)])

    list.push(
        ["int | string", () => __type_spec__(ref("int"), ref("string"))],
        ["string?", () => __type_spec__(ref("string"), ref("null"), ref("undefined"))],
        [`${p}Role | int`, () => __type_spec__(ref(`${p}Role`), ref("int"))],
        [`${p}Tag | ${p}User`, () => __type_spec__(ref(`${p}Tag`), ref(`${p}User`))],
        [`${p}Positive & ${p}Even`, () => __type_spec_all__(ref(`${p}Positive`), ref(`${p}Even`))],
        [`${p}Small & ${p}Even`, () => __type_spec_all__(ref(`${p}Small`), ref(`${p}Even`))],
        ["int & string", () => __type_spec_all__(ref("int"), ref("string"))],
        ["bare string", () => "int"],
        ["bare ref", () => ref("string")],
        ["empty union", () => __type_spec__()],
        ["no label", () => __type_spec__({ __slim_type_ref__: true })],
        ["local class", () => __type_spec__(ref("Point", () => Point))],
        ["local class[]", () => __type_spec__(ref("Point[]", () => Point))],
        ["local value", () => __type_spec__(ref("One", () => 1))],
        ["local null", () => __type_spec__(ref("Thing", () => null))],
        ["local undefined", () => __type_spec__(ref("Thing", () => undefined))],
        ["local struct", () => __type_spec__(ref("Tag", () => w.structs.Tag))],
        ["local struct[]", () => __type_spec__(ref("Tag[]", () => w.structs.Tag))],
        ["local enum", () => __type_spec__(ref("Role", () => w.enums.Role))],
        ["local enum member", () => __type_spec__(ref("Role::Admin", () => w.enums.Role))],
        ["local enum value", () => __type_spec__(ref("Admin", () => w.enums.Role.Admin))],
        ["local custom", () => __type_spec__(ref("Positive", () => w.customs.Positive))],
        ["local fn", () => __type_spec__(ref("Big", () => v => typeof v === "number" && v > 100))],
        ["local spec array", () => __type_spec__(ref("Either", () => __type_spec__(ref("int"), ref("string"))))],
        ["generic with local", () => __type_spec__(ref("Box<int>", () => Point))]
    )
    return list
}

function describeValue(value) {
    try { return typeof value === "symbol" ? "symbol" : typeof value === "function" ? "fn" : String(JSON.stringify(value) ?? value) } catch { return String(value) }
}

for (const mode of ["closures", "generated"]) {
    const generated = mode === "generated"
    const prefix = generated ? "G" : "C"
    __type_codegen__(generated)
    const world = declare(prefix)
    __type_codegen__(false)

    const w = { p: prefix, structs: world.real.structs, enums: world.real.enums, customs: world.real.customs }
    // The legacy side resolves local thunks against its own definitions.
    const lw = {
        p: prefix,
        structs: world.legacy.structs,
        enums: w.enums,
        customs: Object.fromEntries(Object.keys(w.customs).map(name => [name, world.legacy.customs[`${prefix}${name}`]]))
    }

    test(`[${mode}] specifications match the legacy interpreter on every value`, () => {
        const realSpecs = specifications(w)
        const legacySpecs = specifications(lw)
        const table = values(w)
        let checked = 0

        realSpecs.forEach(([label, make], index) => {
            const realSpec = make()
            const legacySpec = legacySpecs[index][1]()
            for (const [name, value] of table) {
                const expected = world.legacy.matches(legacySpec, value)
                assert.equal(__type_matches__(realSpec, value), expected, `${label} vs ${name}`)
                // A second call hits warm caches and must agree too.
                assert.equal(__type_matches__(realSpec, value), expected, `${label} vs ${name} (again)`)
                checked++
            }
        })
        assert.ok(checked > 5000, `only ${checked} comparisons`)
    })

    test(`[${mode}] struct results and error texts match the legacy typed()`, () => {
        for (const name of Object.keys(w.structs)) {
            const real = w.structs[name]
            const old = world.legacy.structs[name]
            for (const [description, value] of values(w)) {
                const expected = world.legacy.typed(value, old, "errorResult")
                const actual = real.verifySafe(value)
                assert.deepEqual(actual, expected, `${name}.verifySafe(${description})`)
                assert.deepEqual(__typed__(value, real, "errorResult"), expected, `__typed__ ${name}(${description})`)

                if (expected.success) {
                    assert.equal(real.verify(value), value)
                } else {
                    assert.throws(() => real.verify(value), error => {
                        assert.equal(error.tag, expected.result.type)
                        assert.equal(String(error), expected.result.msg)
                        return true
                    }, `${name}.verify(${description})`)
                }
            }
        }
    })

    test(`[${mode}] struct.new fills defaults and validates through the same predicate`, () => {
        const Opt = __def_struct__(`${prefix}Opt`, { id: "int", "*tag": "string", tags: "string[]" }, {
            id: __type_spec__(ref("int")), tag: __type_spec__(ref("string")), tags: __type_spec__(ref("string[]"))
        }, { tags: () => ["d"] })
        assert.deepEqual(Opt.new({ id: 1 }), { tags: ["d"], id: 1 })
        assert.deepEqual(Opt.new({ id: 1, tag: "t", tags: ["x"] }), { id: 1, tag: "t", tags: ["x"] })
        assert.throws(() => Opt.new({ id: "1" }), /"\w+Opt\.id" expected int, got string: "1"/)
        assert.throws(() => Opt.new({}), /fewer keys than expected\. The key "id"/)
        assert.throws(() => Opt.new({ id: 1, nope: 1 }), /does not contain any keys named "nope"/)
    })
}

test("a struct declared after it is first referenced starts failing, then passes", () => {
    const Holder = __def_struct__("LateHolder", { item: "LateItem" }, {
        item: __type_spec__(__type_ref__("LateItem", () => LateItem))
    })
    // `LateItem` is still in its temporal dead zone: the thunk throws like before.
    let LateItem
    const lazy = __def_struct__("LateLazy", { item: "LateNamed" }, { item: __type_spec__(__type_ref__("LateNamed")) })

    assert.equal(lazy.verifySafe({ item: { v: 1 } }).success, false)
    assert.match(lazy.verifySafe({ item: { v: 1 } }).result.msg, /"LateLazy\.item" expected LateNamed, got object/)

    LateItem = __def_struct__("LateItem", { v: "int" }, { v: __type_spec__(__type_ref__("int")) })
    __def_struct__("LateNamed", { v: "int" }, { v: __type_spec__(__type_ref__("int")) })

    assert.equal(Holder.verifySafe({ item: { v: 1 } }).success, true)
    assert.equal(lazy.verifySafe({ item: { v: 1 } }).success, true)
    assert.equal(lazy.verifySafe({ item: { v: "1" } }).success, false)
})

test("a custom type declared after a struct uses it is picked up on the next call", () => {
    const Doc = __def_struct__("LateTypeDoc", { code: "LateCode" }, { code: __type_spec__(__type_ref__("LateCode")) })
    assert.equal(Doc.verifySafe({ code: 5 }).success, false)
    __type_def__("LateCode", v => v === 5)
    assert.equal(Doc.verifySafe({ code: 5 }).success, true)
    assert.equal(Doc.verifySafe({ code: 6 }).success, false)
})

test("a recursive struct validates arbitrarily deep chains and reports the failing path", () => {
    let Chain
    Chain = __def_struct__("RecChain", { value: "int", next: "x" }, {
        value: __type_spec__(__type_ref__("int")),
        next: __type_spec__(__type_ref__("RecChain", () => Chain), __type_ref__("null"))
    })

    let chain = null
    for (let i = 0; i < 50; i++) chain = { value: i, next: chain }
    assert.equal(Chain.verify(chain), chain)

    let broken = { value: 1, next: { value: 2, next: { value: "3", next: null } } }
    const result = Chain.verifySafe(broken)
    assert.equal(result.success, false)
    assert.match(result.result.msg, /"RecChain\.next" expected RecChain \| null, got object/)
    assert.equal(result.properties.fieldName, "RecChain.next")

    // The same struct passes again once the data is fixed.
    broken.next.next.value = 3
    assert.equal(Chain.verifySafe(broken).success, true)
})

test("repeated calls after a failure keep returning correct results", () => {
    const Pair = __def_struct__("RetryPair", { a: "int", b: "string[]" }, {
        a: __type_spec__(__type_ref__("int")), b: __type_spec__(__type_ref__("string[]"))
    })
    const good = { a: 1, b: ["x"] }
    const bad = { a: 1, b: [1] }
    for (let i = 0; i < 3; i++) {
        assert.equal(Pair.verifySafe(good).success, true)
        assert.equal(Pair.verifySafe(bad).success, false)
        assert.throws(() => Pair.verify(bad), /"RetryPair\.b" expected string\[\], got int\[\]: \[1\]/)
        assert.equal(Pair.verify(good), good)
    }
})

test("typed variable, parameter and return errors keep their wording", () => {
    const binding = {}
    const spec = () => __type_spec__(__type_ref__("int"))

    assert.equal(__typed_variable__(1, spec(), binding, "x"), 1)
    assert.throws(() => __typed_variable__("a", spec(), {}, "x"),
        { name: "TypeError", message: 'The "x" is of type int, but was assigned a string: "a"' })
    assert.throws(() => __typed_variable_check__(binding, "a", "x"),
        { message: 'The variable "x" is of type int, but it was redefined with type string: "a"' })
    assert.equal(__typed_variable_check__(binding, 7, "x"), 7)

    assert.throws(() => __typed_return__("a", spec(), "f"),
        { message: 'function "f" must return int, got string: "a"' })
    assert.equal(__typed_return__(3, spec(), "f"), 3)

    // The parameter message may be text or a thunk; either is used only on failure.
    let built = 0
    const lazy = () => { built++; return 'function "f": argument<0> "a" expected int, got string' }
    assert.equal(__typed_parameter__(1, spec(), {}, "a", false, lazy), 1)
    assert.equal(built, 0)
    assert.throws(() => __typed_parameter__("a", spec(), {}, "a", false, lazy),
        { message: 'function "f": argument<0> "a" expected int, got string' })
    assert.equal(built, 1)
    assert.throws(() => __typed_parameter__("a", spec(), {}, "a", false, "plain text"), { message: "plain text" })
    assert.equal(__typed_parameter__(undefined, spec(), {}, "a", true, "unused"), undefined)
})

test("mutation guards still reject bad writes and reuse the proxy per value and specification", () => {
    const spec = __type_spec__(__type_ref__("int[]"))
    const first = [1, 2, 3]
    const second = [4, 5, 6]

    const proxyOne = __typed_variable__(first, spec, {}, "a")
    assert.notEqual(proxyOne, first)
    assert.throws(() => proxyOne.push("x"), { message: /but it was mutated into type/ })
    assert.throws(() => { proxyOne[0] = "x" }, { message: /but it was mutated into type/ })
    assert.equal(first[0], 1)

    // Reusing the specification for a second value, then the first one again,
    // returns the proxy created earlier for that value.
    const proxyTwo = __typed_variable__(second, spec, {}, "b")
    assert.notEqual(proxyTwo, proxyOne)
    assert.equal(__typed_variable__(first, spec, {}, "a"), proxyOne)
    assert.equal(__typed_variable__(second, spec, {}, "b"), proxyTwo)
    assert.equal(__typed_variable__(first, spec, {}, "a"), proxyOne)

    // A fresh specification for the same value is a distinct guard.
    const other = __typed_variable__(first, __type_spec__(__type_ref__("int[]")), {}, "a")
    assert.notEqual(other, proxyOne)

    // `any` is never wrapped.
    const loose = [1, "a"]
    assert.equal(__typed_variable__(loose, __type_spec__(__type_ref__("any")), {}, "z"), loose)
})

test("generated validators handle awkward field names and optional fields", () => {
    __type_codegen__(true)
    let Odd
    try {
        Odd = __def_struct__("GenOdd", { 'we"ird\nname': "int", "*opt": "string", "*loose": "any", list: "int[]" }, {
            'we"ird\nname': __type_spec__(__type_ref__("int")),
            opt: __type_spec__(__type_ref__("string")),
            loose: __type_spec__(__type_ref__("any")),
            list: __type_spec__(__type_ref__("int[]"))
        })
    } finally {
        __type_codegen__(false)
    }

    assert.equal(Odd.verifySafe({ 'we"ird\nname': 1, list: [1] }).success, true)
    assert.equal(Odd.verifySafe({ 'we"ird\nname': 1, list: [1], opt: "s", loose: undefined }).success, true)
    assert.equal(Odd.verifySafe({ 'we"ird\nname': 1, list: [1], opt: 2 }).success, false)
    assert.equal(Odd.verifySafe({ list: [1] }).success, false)
    assert.equal(Odd.verifySafe({ 'we"ird\nname': 1, list: [] }).success, false)
    assert.equal(Odd.verifySafe({ 'we"ird\nname': 1, list: [1], extra: 1 }).success, false)
    assert.equal(Odd.verifySafe({ 'we"ird\nname': 1, list: [1], constructor: 1 }).success, true)

    // A custom type registered later with a builtin's name re-routes the field,
    // exactly as the legacy lookup-on-every-call did. This runs last: the
    // registration is process-wide.
    const reference = createLegacyRuntime()
    const only42 = v => v === 42
    reference.defType("int", only42)
    __type_def__("int", only42)
    for (const label of ["int", "int[]"]) {
        for (const value of [42, 1, [42], [1], "a"]) {
            const spec = __type_spec__(ref(label))
            assert.equal(__type_matches__(spec, value), reference.matches(spec, value), `${label} vs ${JSON.stringify(value)}`)
        }
    }
    assert.equal(Odd.verifySafe({ 'we"ird\nname': 42, list: [42] }).success, true)
    assert.equal(Odd.verifySafe({ 'we"ird\nname': 42, list: [1] }).success, false)
    assert.equal(Odd.verifySafe({ 'we"ird\nname': 1, list: [42] }).success, false)
})

test("the generator emits a switch over constant field names and defers to the closures on a miss", async () => {
    const { generateStructValidator, isInlineKind } = await import("../src/external/codegen.js")
    const calls = []
    const fields = [
        { name: "a", optional: false, kind: "int", test: v => (calls.push(["a", v]), v === 5) },
        { name: "b", optional: true, kind: null, test: v => (calls.push(["b", v]), v === "ok") }
    ]
    const validator = generateStructValidator(fields, { a: {}, b: {} })

    assert.match(validator.toString(), /switch \(keys\[i\]\)/)
    assert.equal(isInlineKind("int[]"), true)
    assert.equal(isInlineKind("Tag"), false)
    assert.equal(isInlineKind("constructor"), false)

    assert.equal(validator({ a: 1 }), true)
    assert.deepEqual(calls, [], "an inline hit never calls the closure")
    assert.equal(validator({ a: 5.5 }), false)
    assert.equal(validator({ a: 1, b: "no" }), false)
    assert.deepEqual(calls, [["a", 5.5], ["b", "no"]])
    assert.equal(validator({ a: 1, b: undefined }), false, "an explicit undefined is present, so it is checked")
    assert.equal(validator({ a: 1 }), true, "an absent optional field is skipped")
})
