import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { outputFolder } from "./output.mjs"

const root = process.cwd()
const outputDir = outputFolder("__ref_expose__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function run(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const file = path.join(outputDir, `${name}.js`)
    const { code } = transform(source, path.join(root, "__ref_expose__", `${name}.slim`), { outFile: file })
    writeFileSync(file, code.replace(/^import\s+[^;]*(?:defaults|core)\.js";$/m, `import ${JSON.stringify(runtimeImport)};`))
    return spawnSync(process.execPath, ["--no-warnings", file], { cwd: root, encoding: "utf8" })
}

function messages(source) {
    try {
        transform(source, "ref.slim")
    } catch (error) {
        if (error.slimTypeErrors) return error.slimTypeErrors.map(diagnostic => diagnostic.message)
        throw error
    }
    return []
}

test("ref puts the element into a variable before onMount runs", () => {
    const result = run("ref-variable", `
        component Row() {
            let label
            let seen = ""
            onMount(() => { seen = label.tagName })
            const el = <div><span ref=\${label}>x</span></div>
            log(seen || "none")
            return el
        }
        component Later() {
            let label
            onMount(() => log(label.textContent))
            return <p><b ref=\${label}>bold</b></p>
        }
        Row()
        Later()
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "none\nbold")
})

test("ref takes a function and a field", () => {
    const result = run("ref-function", `
        component Box() {
            const parts = {}
            onMount(() => log(parts.head.className))
            return <section>
                <h2 ref=\${(node) => log("got", node.tagName)}>t</h2>
                <i ref=\${parts.head} class="head"></i>
            </section>
        }
        Box()
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "got H2\nhead")
})

test("expose puts methods on the element, before onMount callbacks see it", () => {
    const result = run("expose", `
        component Counter() {
            state count = 0
            let out
            onMount((el) => log("mounted with", typeof el.add))
            expose({
                add(n) { count += n },
                get value() { return count }
            })
            return <b ref=\${out}>\${count}</b>
        }
        const el = Counter()
        el.add(2)
        el.add(3)
        log(el.value, el.textContent)
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "mounted with function\n5 5")
})

test("ref is a known attribute and needs one value", () => {
    assert.deepEqual(messages(`component A() {\n    let box\n    return <div ref=\${box}></div>\n}`), [])
    assert.throws(() => transform(`component A() {\n    return <div ref="box"></div>\n}`, "ref.slim", { check: false }), /ref takes a variable or a function/)
})
