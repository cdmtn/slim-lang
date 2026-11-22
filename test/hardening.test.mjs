import assert from "node:assert/strict"
import { test } from "node:test"
import * as runtime from "../src/external/runtime-core.js"
import * as reactive from "../src/external/reactive.js"
import { __html__, htmlToVdom, slimDocument } from "../src/external/helpers.js"
import { hydrate, renderToStringAsync } from "../src/external/dom.js"
import { matchRoute } from "../src/external/router.js"
import { formatSlim } from "../src/format.js"
import { transform } from "../src/transform.js"

function messages(source) {
    try {
        transform(source, "check.slim")
    } catch (error) {
        if (error.slimTypeErrors) return error.slimTypeErrors.map(diagnostic => diagnostic.message)
        throw error
    }
    return []
}

test("locked Maps and Sets hand out locked contents and still find their keys", () => {
    const inner = new Map()
    const key = { id: 1 }
    const locked = runtime.__lock_object__(new Map([["inner", inner], ["d", new Date(0)], [key, "k"]]))
    assert.throws(() => locked.get("inner").set("x", 1), /locked object mutation/)
    assert.throws(() => locked.get("d").setFullYear(2030), /locked object mutation/)
    const lockedKey = [...locked.keys()].find(item => typeof item === "object")
    assert.equal(locked.get(lockedKey), "k")
    const set = runtime.__lock_object__(new Set([new Set([1])]))
    const [element] = set
    assert.throws(() => element.add(2), /locked object mutation/)
    assert.equal(set.has(element), true)
})

test("a child struct instance is accepted where its parent struct is expected", () => {
    const Base = runtime.__def_struct__("HardBase", { x: "int" })
    const Child = runtime.__def_struct__("HardChild", { y: "int" }, {}, {}, "HardBase")
    const child = Child.new({ x: 1, y: 2 })
    assert.equal(Base.verifySafe(child).success, true)
    assert.equal(Base.verifySafe({ x: 1, y: 2 }).success, false)
})

test("a throwing cleanup still disposes the rest of the scope", () => {
    const s = reactive.__signal__(0)
    const scope = new reactive.Owner(null)
    let runs = 0
    reactive.runWithOwner(scope, () => {
        reactive.effect(() => () => { throw new Error("boom") })
        reactive.effect(() => { s.v; runs++ })
    })
    assert.throws(() => scope.dispose(), /boom/)
    s.v = 1
    assert.equal(runs, 1)
})

test("a selection read inside a batch sees the new value", () => {
    const selected = reactive.__signal__(1)
    const isTwo = reactive.__computed__(() => reactive.__is__(selected, 2, true))
    reactive.__render_effect__(() => isTwo.v)
    let inside
    reactive.batch(() => {
        selected.v = 2
        inside = isTwo.v
    })
    assert.equal(inside, true)
})

test("each markup string keeps its own interpolated DOM nodes", () => {
    const make = (tag, text) => {
        const el = slimDocument.createElement(tag)
        el.textContent = text
        return el
    }
    const first = __html__`<div>${make("em", "mine")}</div>`
    htmlToVdom(__html__`<p>${make("b", "other")}</p>`)
    __html__`<p>${make("i", "someone else")}</p>`
    assert.equal(String(htmlToVdom(first).toElement()), "<div><em>mine</em></div>")
})

test("hydrate drops the server store when it finishes and the server store keeps __proto__ as data", async () => {
    const container = slimDocument.createElement("div")
    hydrate(() => reactive.provideData("user", () => "server"), container, [], { user: "alice" })
    assert.equal(reactive.provideData("user", () => "bob"), "bob")
    const rendered = await renderToStringAsync(() => {
        reactive.provideData("__proto__", () => ({ polluted: 1 }))
        return ""
    })
    assert.equal(rendered.store.polluted, undefined)
    assert.equal(JSON.stringify(rendered.store), '{"__proto__":{"polluted":1}}')
})

test("struct input can't replace the prototype or smuggle Object.prototype keys", () => {
    const Guarded = runtime.__def_struct__("HardGuarded", { x: "int" }, {}, {}, null, { m() { return 1 } })
    assert.throws(() => Guarded.new(JSON.parse('{"x":1,"__proto__":{"m":"pwned"}}')), /__proto__/)
    assert.throws(() => Guarded.new({ x: 1, constructor: 5 }), /constructor/)
    const Named = runtime.__def_struct__("HardNamed", { name: "string", "*valueOf": "int" })
    assert.deepEqual({ ...Named.new({ name: "a" }) }, { name: "a" })
})

test("a cyclic value checked against a recursive struct does not overflow", () => {
    const Item = runtime.__def_struct__("HardItem", { id: "int", "*next": "HardItem" })
    const item = { id: 1 }
    item.next = item
    assert.equal(Item.verifySafe(item).success, true)
})

test("lock keeps Maps, Dates and typed arrays readable and blocks their mutators", () => {
    const locked = runtime.__lock_object__({ m: new Map([["a", 1]]), d: new Date(0), t: new Uint8Array(2) })
    assert.equal(locked.m.get("a"), 1)
    assert.equal(locked.d.getTime(), 0)
    assert.equal(locked.t.length, 2)
    assert.throws(() => locked.m.set("b", 2), /locked object mutation/)
    assert.throws(() => locked.d.setTime(5), /locked object mutation/)
    assert.throws(() => locked.t.fill(1), /locked object mutation/)
    const inner = runtime.__lock_object__({ y: 1 })
    assert.equal(runtime.__lock_object__({ inner }).inner.y, 1)
})

test("enum members can't shadow the enum API, and struct names don't replace host globals", () => {
    assert.throws(() => runtime.__def_enum__("HardField", { name: 0, size: 1 }), /reserved/)
    runtime.__def_struct__("URL", { href: "string" })
    assert.equal(new globalThis.URL("http://x/").href, "http://x/")
})

test("operators handle BigInt, Maps and Sets", () => {
    assert.equal(runtime.__intdiv__(10n, 3n), 3n)
    assert.equal(runtime.__sizeof__(new Map([["a", 1]])), 1)
    assert.equal(runtime.__is_empty__(new Set()), true)
    assert.equal(runtime.deepEqual(new Set([[1]]), new Set([[1]])), true)
    assert.equal(runtime.deepEqual(new Set([[1]]), new Set([[2]])), false)
})

test("an effect or computed that threw recovers on the next change", () => {
    const source = reactive.__signal__(0)
    let runs = 0
    assert.throws(() => reactive.effect(() => {
        runs++
        if (source.v === 0) throw new Error("boom")
    }))
    source.v = 1
    assert.equal(runs, 2)

    const input = reactive.__signal__(0)
    const derived = reactive.__computed__(() => {
        if (input.v === 0) throw new Error("zero")
        return input.v * 10
    })
    const seen = []
    reactive.effect(() => {
        try {
            seen.push(derived.v)
        } catch {
            seen.push("err")
        }
    })
    input.v = 1
    input.v = 0
    input.v = 2
    assert.deepEqual(seen, ["err", 10, "err", 20])
})

test("markup values can't break out of attributes", () => {
    const value = "x onmouseover=alert(1)"
    assert.deepEqual(htmlToVdom(__html__`<p title="a>b" data-x=${value}>x</p>`).attrs, { title: "a>b", "data-x": value })
    assert.deepEqual(htmlToVdom(__html__`<p title=x${value}>x</p>`).attrs, { title: "x" + value })
    assert.deepEqual(htmlToVdom(__html__`<p ${"onmouseover=alert(1)"}>x</p>`).attrs, {})
    assert.deepEqual(htmlToVdom(__html__`<input ${"checked disabled"}>`).attrs, { checked: true, disabled: true })
    assert.equal(__html__`<p>a < b, x = ${5}</p>`.value, "<p>a < b, x = 5</p>")
})

test("routes with malformed escapes still match", () => {
    assert.deepEqual(matchRoute("/user/:id", "/user/100%"), { id: "100%" })
})

test("the formatter keeps pre content as written", () => {
    const source = "component A() {\nreturn <div>\n<pre>a\n  b</pre>\n<!-- <span> -->\n<p>x</p>\n</div>\n}\n"
    assert.equal(formatSlim(source), "component A() {\n    return <div>\n        <pre>a\n  b</pre>\n        <!-- <span> -->\n        <p>x</p>\n    </div>\n}\n")
})

test("checker fixes: do-while with continue, suffix-named globals, wildcard aliases, markup backslashes", () => {
    assert.match(messages(`func f(c: bool) -> int { do { continue } while (c) }`)[0], /can reach the end without a return/)
    assert.match(messages(`log(userArray)`)[0], /"userArray" is not defined/)
    const wildcard = transform(`use "./a-b"\nuse "./a_b"`, "check.slim").code
    assert.match(wildcard, /import \* as __a_b_js__/)
    assert.match(wildcard, /import \* as __a_b_js_2__/)
    const markup = transform("const h = <p>C:\\users\\x</p>\nlog(h)", "check.slim").code
    assert.ok(markup.includes("C:\\\\users\\\\x"))
})

test("a child struct nested in a parent-typed field is kept, and its unknown keys are still refused", () => {
    const Base = runtime.__def_struct__("HardNestBase", { x: "int" })
    const Child = runtime.__def_struct__("HardNestChild", { y: "int" }, {}, {}, "HardNestBase")
    const Holder = runtime.__def_struct__("HardNestHolder", { a: "HardNestBase" })
    const child = Child.new({ x: 1, y: 2 })
    assert.equal(Holder.new({ a: child }).a, child)
    assert.equal(Base.verifySafe(Object.assign(Child.new({ x: 1, y: 2 }), { injected: 1 })).success, false)
})

test("a locked typed array can't be changed through its buffer or a subarray", () => {
    const locked = runtime.__lock_object__(new Uint8Array([1, 2, 3]))
    new Uint8Array(locked.buffer)[0] = 9
    assert.equal(locked[0], 1)
    assert.throws(() => { locked.subarray(0)[1] = 8 }, /locked object mutation/)
    const key = { id: 1 }
    const lockedMap = runtime.__lock_object__(new Map([[key, 1]]))
    assert.equal(runtime.deepEqual(lockedMap, new Map([[key, 1]])), true)
})

test("a typed catch recognises Slim's own errors without globals", async () => {
    const { StructError, ArgumentDeclarationTypeError } = await import("../src/external/classErrors.js")
    const spec = name => runtime.__type_spec__(runtime.__type_ref__(name))
    assert.doesNotThrow(() => runtime.__typed_catch__(new StructError("x"), spec("StructError")))
    assert.doesNotThrow(() => runtime.__typed_catch__(new ArgumentDeclarationTypeError("x"), spec("TypeError")))
    assert.throws(() => runtime.__typed_catch__(new Error("x"), spec("StructError")))
})

test("an <svg> in a markup string is built in the SVG namespace, with its tags' own case", () => {
    const built = htmlToVdom(`<svg viewBox="0 0 1 1"><linearGradient id="g"></linearGradient><path d="M0 0"></path><foreignObject><p>x</p></foreignObject></svg>`).toElement(slimDocument)
    const svg = built.nodeType === 11 ? built.firstChild : built
    const [gradient, path, foreign] = svg.childNodes
    assert.equal(svg.namespaceURI, "http://www.w3.org/2000/svg")
    assert.equal(svg.getAttribute("viewBox"), "0 0 1 1")
    assert.equal(gradient.localName, "linearGradient")
    assert.equal(path.namespaceURI, "http://www.w3.org/2000/svg")
    assert.equal(foreign.firstChild.namespaceURI, "http://www.w3.org/1999/xhtml")
})
