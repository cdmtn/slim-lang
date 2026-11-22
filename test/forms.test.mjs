import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__forms_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href
const FORMS = `use { createForm } from ${JSON.stringify(pathToFileURL(path.join(root, "src", "external", "runtime-core.js")).href)}\n`

function run(name, source, options = {}) {
    mkdirSync(outputDir, { recursive: true })
    const code = transform(FORMS + source, path.join(root, "__forms_tests__", `${name}.slim`), options).code
    const file = path.join(outputDir, `${name}.js`)
    writeFileSync(file, code.replace(/^import\s+[^;]*(?:defaults|core)\.js";$/m, `import ${JSON.stringify(runtimeImport)};`))
    const result = spawnSync(process.execPath, ["--no-warnings", file], { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim().split("\n")
}

test("form rules have their own messages and fields can be skipped", () => {
    const lines = run("rules", `
type positive(value) { return typeof value == "number" && value > 0 }
struct Item {
    title: string
    price: positive
    note?: string
    code?: string
    coupon: bool
}
const form = createForm(Item, {
    messages: {
        title: { required: "Give it a title", short: "At least 3 letters" },
        price: { required: "Set a price", positive: "Above zero, please" }
    },
    fields: {
        title: { validate: { short: value => value.length >= 3 } },
        note: { validate: [value => value.includes("!") ? "No shouting" : null] },
        code: { when: values => values.coupon, validate: value => value.length == 4 || "Four characters" }
    }
})
const show = () => JSON.stringify(form.errors)
form.title = ""
form.price = ""
log(show())
form.title = "ab"
form.price = "0"
form.note = "hey!"
log(show())
form.code = "x"
log(form.errors.code, form.valid)
form.title = "abc"
form.price = "5"
form.note = ""
log(form.valid, JSON.stringify(form.values))
form.coupon = true
log(form.errors.code, form.valid)
form.code = "ABCD"
log(form.valid, JSON.stringify(form.values))
`)
    assert.deepEqual(lines, [
        '{"title":"Give it a title","price":"Set a price","note":null,"code":null,"coupon":null}',
        '{"title":"At least 3 letters","price":"Above zero, please","note":"No shouting","code":null,"coupon":null}',
        "null false",
        'true {"title":"abc","price":5,"coupon":false}',
        "Four characters false",
        'true {"title":"abc","price":5,"code":"ABCD","coupon":true}'
    ])
})

test("cross-field rules, server errors and async checks with a stale guard", () => {
    const lines = run("server", `
struct Account {
    name: string
    password: string
    confirm: string
}
const calls = []
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const form = createForm(Account, {
    fields: {
        name: {
            debounce: 5,
            check: async value => {
                calls.push(value)
                await wait(value == "slow" ? 100 : 5)
                return value == "taken" || value == "slow" ? "Name is taken" : null
            }
        }
    },
    validate: values => values.password != values.confirm ? { confirm: "Passwords differ" } : null
})
form.password = "secret"
form.confirm = "secre"
log(form.errors.confirm, form.valid)
form.confirm = "secret"
log(form.errors.confirm)
form.name = "slow"
await wait(40)
form.name = "free"
log(form.checking)
await wait(150)
log(form.checking, form.errors.name, calls.join(","))
form.name = "taken"
await wait(80)
log(form.errors.name, form.valid)
form.name = "ann"
let sent = null
await form.submit(data => { sent = data.name })()
log(sent, calls.join(","))
form.setErrors({ name: "Server says no", other: "Try later" })
log(form.errors.name, form.formError, form.valid)
form.name = "bob"
log(form.errors.name, form.formError)
form.setErrors("Down for maintenance")
log(form.formError, form.valid)
form.reset()
log(form.formError, form.errors.name, form.checking)
`)
    assert.deepEqual(lines, [
        "Passwords differ false",
        "null",
        "true",
        "false null slow,free",
        "Name is taken false",
        "ann slow,free,taken,ann",
        "Server says no Try later false",
        "null null",
        "Down for maintenance false",
        "null null false"
    ])
})

test("a form-wide rule shows after a submit and the existing API still works", () => {
    const lines = run("whole", `
struct Range {
    from: int
    to: int
}
const form = createForm(Range, { initial: { from: 5, to: 1 }, validate: values => values.from > values.to ? "From must not pass to" : null })
log(form.formError, form.valid)
let sent = null
form.submit(data => { sent = data })()
log(form.formError, sent)
form.to = 9
form.submit(data => { sent = data })()
log(form.formError, JSON.stringify(sent), form.touched("to"))
`)
    assert.deepEqual(lines, [
        "null false",
        "From must not pass to null",
        'null {"from":5,"to":9} true'
    ])
})
