import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__match_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function runSlim(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const { code } = transform(source, path.join(root, "__match_tests__", `${name}.slim`))
    const executable = code.replace(
        /^import\s+[^;]*(?:defaults|core)\.js";$/m,
        `import ${JSON.stringify(runtimeImport)};`
    )
    const outputFile = path.join(outputDir, `${name}.js`)
    writeFileSync(outputFile, executable)
    return spawnSync(process.execPath, ["--no-warnings", outputFile], { cwd: root, encoding: "utf8" })
}

test("match returns the matching branch and the wildcard fallback", () => {
    const result = runSlim("literal", `
        func label(n) {
            return match (n) {
                1 => "one",
                2 => "two",
                _ => "other"
            }
        }
        log(label(2), label(9))
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /two other/)
})

test("match without a wildcard yields undefined on no match", () => {
    const result = runSlim("no-default", `log(match (5) { 1 => "a", 2 => "b" })`)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /undefined/)
})

test("match compares enum members by value", () => {
    const result = runSlim("enum", `
        enum Role { Member: 0
            Admin: 2 }
        const r = Role.Admin
        log(match (r) { Role.Member => "m", Role.Admin => "a", _ => "?" })
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /a/)
})

test("guarded cases bind the subject and test a condition", () => {
    const result = runSlim("guards", `
        func size(n) {
            return match (n) {
                x when x > 10 => "big",
                x when x > 0 => "small",
                _ => "nonpositive"
            }
        }
        log(size(50), size(5), size(-1))
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /big small nonpositive/)
})

test("a .match() method call is not treated as a match expression", () => {
    const result = runSlim("str-match", `
        const m = "hello".match(/l+/)
        log(m?.[0])
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /ll/)
})
