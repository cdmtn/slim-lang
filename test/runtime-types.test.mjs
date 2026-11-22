import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__type_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function compileSlim(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const sourceFile = path.join(root, "__type_tests__", `${name}.slim`)
    const { code } = transform(source, sourceFile, { check: false })
    const executable = code.replace(
        /^import\s+[^;]*(?:defaults|core)\.js";$/m,
        `import ${JSON.stringify(runtimeImport)};`
    )
    const outputFile = path.join(outputDir, `${name}.js`)
    writeFileSync(outputFile, executable)

    return outputFile
}

function runSlim(name, source) {
    const outputFile = compileSlim(name, source)
    return spawnSync(process.execPath, ["--no-warnings", outputFile], {
        cwd: root,
        encoding: "utf8"
    })
}

test("a Record checks the number its key spells", () => {
    const accepted = runSlim("record-keys", `
        const names: Record<number, string> = { 1: "one", [-2]: "minus two", 1.5: "half" }
        const ids: Record<int, string> = { 3: "three" }
        const mixed: Record<string | number, int> = { a: 1, 2: 2 }
        log(names[-2], ids[3], mixed.a)
    `)
    assert.equal(accepted.status, 0, accepted.stderr)
    assert.match(accepted.stdout, /minus two three 1/)

    const words = runSlim("record-word-key", `
        const raw: any = { name: "x" }
        const bad: Record<number, string> = raw
    `)
    assert.match(words.stderr, /"bad" is of type Record<number, string>/)

    const fraction = runSlim("record-fraction-key", `
        const raw: any = { 1.5: "x" }
        const bad: Record<int, string> = raw
    `)
    assert.match(fraction.stderr, /"bad" is of type Record<int, string>/)

    const value = runSlim("record-value", `
        const raw: any = { 1: 2 }
        const bad: Record<number, string> = raw
    `)
    assert.match(value.stderr, /"bad" is of type Record<number, string>/)
})

test("a value kept under two names quotes the right one when it's changed", () => {
    const result = runSlim("guard-names", `
        const list: any = [1]
        const first: int[] = list
        const second: int[] = list
        try { second.push("x") } catch (e) { log(e.message) }
    `)
    assert.match(result.stdout, /"second"/)
})

test("a long-lived object doesn't keep a proxy per call", () => {
    const result = runSlim("guard-reuse", `
        const list: any = [1]
        func same(a: int[]) -> int[] { return a }
        const seen = new Set()
        for (let i = 0; i < 5; i++) seen.add(same(list))
        log(seen.size)
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^1$/m)
})

test("every kind of assignment to a typed binding is still checked", () => {
    const cases = {
        "plain-param": [`func f(a: int) { a = ("x" as any) }\nf(1)`, /"a".*int/],
        "plain-let": [`let a: int = 1\na = ("x" as any)`, /"a".*int/],
        "closure": [`func f(a: int) { const set = () => { a = ("x" as any) }\nset() }\nf(1)`, /"a".*int/],
        "nested-closure": [`let a: int = 1\nfunc outer() { func inner() { a = ("x" as any) }\ninner() }\nouter()`, /"a".*int/],
        "compound": [`func f(a: int) { a += 0.5 }\nf(1)`, /"a".*int/],
        "logical": [`func f(a: int) { a &&= ("x" as any) }\nf(1)`, /"a".*int/],
        "nullish": [`func f(a?: int) { a ??= ("x" as any) }\nf()`, /"a".*int/],
        "update": [`func f(a: any) { let n: int = 9007199254740991\nn++ }\nf(1)`, /"n".*int/],
        "loop-variable": [`for (let i: int = 0; i < 2; i = i + 0.5) { }`, /"i".*int/]
    }
    for (const [name, [source, expected]] of Object.entries(cases)) {
        const result = runSlim(`assign-${name}`, source)
        assert.notEqual(result.status, 0, name)
        assert.match(result.stderr, expected, name)
    }
})

test("a shadowing name doesn't take the checks of the outer one", () => {
    const result = runSlim("assign-shadow", `
        func f(a: int) -> string {
            const inner = (a: any) => { a = "free"; return a }
            return inner(1)
        }
        log(f(1))
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /free/)

    const outer = runSlim("assign-shadow-outer", `
        func f(a: int) {
            { let a: string = "s"; a = "t" }
            a = ("x" as any)
        }
        f(1)
    `)
    assert.notEqual(outer.status, 0)
    assert.match(outer.stderr, /"a".*int/)
})

test("a binding nothing assigns to gets no slot, one that's assigned keeps it", () => {
    const { code } = transform(`func quiet(a: int) -> int { return a }\nfunc loud(b: int) -> int { b = 2; return b }`, "slots.slim", { check: false, sourceMaps: false })
    assert.match(code, /__typed_parameter__\(a, [^\n]*, null, "a"/)
    assert.match(code, /__typed_parameter__\(b, [^\n]*, _slimType\d+, "b"/)
    assert.equal(code.match(/_slimType\d+ = \{\}/g).length, 1)
})

test("a guarded value is still guarded without a slot", () => {
    const pushed = runSlim("guard-no-slot", `
        const list: int[] = [1]
        list.push("x" as any)
    `)
    assert.notEqual(pushed.status, 0)
    assert.match(pushed.stderr, /list.*int\[\]/)
})

test("a check sees what was changed behind a guard", () => {
    const result = runSlim("guard-behind", `
        const raw: any = [1]
        const list: int[] = raw
        raw.push("x")
        func read(a: int[]) -> int { return a.length }
        read(list)
    `)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /int\[\]/)
})

test("a value kept by two types stays under both", () => {
    const result = runSlim("guard-two-types", `
        const raw: any = [1]
        const whole: int[] = raw
        func widen(a: number[]) { a.push(1.5) }
        widen(whole)
    `)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /int\[\]/)
})

test("typed bindings are independent in separate lexical scopes", () => {
    const result = runSlim("scopes", `
        function words() {
            let value: string = "first"
            value = "second"
            return value
        }

        function numbers() {
            let value: int = 1
            value += 1
            return value
        }

        log(words(), numbers())
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /second 2/)
})

test("imported custom types resolve through their local aliases", () => {
    compileSlim("imported-types", `
        export type Whole(v) {
            return kindof v == "int"
        }
    `)

    const result = runSlim("uses-imported-type", `
        use { Whole as Counter } from "./imported-types"

        let value: Counter = 1
        value++
        log(value)
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /2/)
})

test("a custom type with a typed parameter turns down other kinds of values", () => {
    const result = runSlim("typed-parameter-type", `
        type Version(v: string) {
            return /^\\d+\\.\\d+\\.\\d+$/.test(v)
        }
        const outside = (text: string) => JSON.parse(text)
        const ok: Version = outside('"1.2.3"')
        log("ok", ok)
        try {
            const bad: Version = outside('["1.2.3"]')
        } catch (error) {
            log(error.constructor.name, error.message)
        }
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /ok 1\.2\.3/)
    assert.match(result.stdout, /TypeError The "bad" is of type Version, but was assigned a string\[\]/)
    assert.doesNotMatch(result.stdout, /ArgumentDeclarationTypeError/)
})

test("custom types, inheritance, defaults, and typed parameters validate at runtime", () => {
    const result = runSlim("custom", `
        type Positive(v) {
            return kindof v == "int" && v > 0
        }

        type SmallPositive(v) extends Positive {
            return v < 10
        }

        func increment(value: SmallPositive = 1) {
            value++
            return value
        }

        let amount: SmallPositive = 5
        amount = increment(amount)
        log(amount)
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /6/)
})

test("structs, enum members, and custom field types share the same matcher", () => {
    const result = runSlim("structs", `
        type Email(v) {
            return /@/.test(v)
        }

        enum Role {
            Member: 1
            Admin: 2
        }

        struct User {
            email: Email
            role: Role::Admin
            scores: int[]
        }

        let user: User = { email: "person@example.test", role: Role.Admin, scores: [1, 2] }
        User.verify(user)
        log("valid")
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /valid/)
})

test("type aliases resolve forward declarations and local struct definitions stay lexical", () => {
    const result = runSlim("aliases-and-local-structs", `
        type LaterAlias = typeof Later

        class Later {}

        function withNumber() {
            struct Item {
                value: int
            }
            let item: Item = { value: 1 }
            return item
        }

        function withString() {
            struct Item {
                value: string
            }
            let item: Item = { value: "one" }
            return item
        }

        let instance: LaterAlias = new Later()
        log(withNumber().value, withString().value, instance instanceof Later)
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /1 one true/)
})

test("recursive calls keep runtime type contracts per activation", () => {
    const result = runSlim("recursive-scopes", `
        function recurse(limit: int) {
            type Within(v) {
                return v < limit
            }

            let value: Within = limit - 1
            if (limit > 1) recurse(limit - 1)
            value = limit - 1
            return value
        }

        log(recurse(3))
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /2/)
})

test("typed loop bindings retain their runtime contract across updates", () => {
    const result = runSlim("typed-loop", `
        for (let count: int = 0; count < 3; count++) {
            log(count)
        }
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /0\s+1\s+2/)
})

test("typed static fields validate direct assignments and updates", () => {
    const valid = runSlim("static-fields", `
        type UnderTwo(v) {
            return kindof v == "int" && v < 2
        }

        class Counter {
            static value: UnderTwo = 0

            static increment() {
                this.value++
            }
        }

        Counter.increment()
        log(Counter.value)
    `)
    assert.equal(valid.status, 0, valid.stderr)
    assert.match(valid.stdout, /1/)

    const invalid = runSlim("bad-static-field", `
        class Counter {
            static value: int = 0
        }

        Counter.value = "wrong"
    `)
    assert.notEqual(invalid.status, 0)
    assert.match(invalid.stderr, /Counter\.value.*int.*string/)
})

test("invalid reassignment and invalid typed mutations fail without changing the binding contract", () => {
    const reassignment = runSlim("bad-reassignment", `
        let title: string = "Slim"
        title = 3
    `)
    assert.notEqual(reassignment.status, 0)
    assert.match(reassignment.stderr, /title.*string.*int/)

    const mutation = runSlim("bad-mutation", `
        let scores: int[] = [1, 2]
        scores.push("wrong")
    `)
    assert.notEqual(mutation.status, 0)
    assert.match(mutation.stderr, /scores.*int\[\]/)
})
