import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"

const root = process.cwd()
const outputDir = path.join(root, "dist", "__type_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function compileSlim(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const sourceFile = path.join(root, "__type_tests__", `${name}.slim`)
    const { code } = transform(source, sourceFile)
    const executable = code.replace(
        /^import\s+[^;]*defaults\.js";$/m,
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
