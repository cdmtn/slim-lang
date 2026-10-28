import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { preprocess } from "../src/syntax/index.js"

const root = process.cwd()
const outputDir = path.join(root, "dist", "__operator_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function runSlim(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const { code } = transform(source, path.join(root, "__operator_tests__", `${name}.slim`))
    const executable = code.replace(
        /^import\s+[^;]*(?:defaults|core)\.js";$/m,
        `import ${JSON.stringify(runtimeImport)};`
    )
    const outputFile = path.join(outputDir, `${name}.js`)
    writeFileSync(outputFile, executable)
    return spawnSync(process.execPath, ["--no-warnings", outputFile], { cwd: root, encoding: "utf8" })
}

test("word operators do not fire inside string literals", () => {
    const { code } = preprocess(`log("sizeof x")\nlog("a or b")`, "x.slim")
    assert.match(code, /"sizeof x"/)
    assert.match(code, /"a or b"/)
    assert.doesNotMatch(code, /__sizeof__/)
})

test("operators are not matched as substrings of identifiers", () => {
    const { code } = preprocess(`const mysizeof = 1\nconst android = 2\nlog(mysizeof + android)`, "x.slim")
    assert.match(code, /mysizeof \+ android/)
    assert.doesNotMatch(code, /__sizeof__/)
})

test("Object.prototype member names are not corrupted by the word-operator table", () => {
    const { code } = preprocess(`o.hasOwnProperty(k)\nx.toString()\nz.constructor\na.propertyIsEnumerable(k)`, "x.slim")
    assert.match(code, /o\.hasOwnProperty\(k\)/)
    assert.match(code, /x\.toString\(\)/)
    assert.match(code, /z\.constructor/)
    assert.doesNotMatch(code, /native code/)
})

test("word operators do not fire on member property names", () => {
    const { code } = preprocess(`obj.and\nobj.or`, "x.slim")
    assert.match(code, /obj\.and/)
    assert.match(code, /obj\.or/)
    assert.doesNotMatch(code, /obj\.(&&|\|\|)/)
})

test("real operators still lower and evaluate", () => {
    const result = runSlim("operators", `
        log(sizeof [1, 2, 3])
        log(empty [])
        log(true and false or true)
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /3/)
    assert.match(result.stdout, /true/)
})
