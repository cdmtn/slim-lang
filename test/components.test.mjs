import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"

const root = process.cwd()
const outputDir = path.join(root, "dist", "__component_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function runSlim(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const { code } = transform(source, path.join(root, "__component_tests__", `${name}.slim`))
    const executable = code.replace(
        /^import\s+[^;]*(?:defaults|core)\.js";$/m,
        `import ${JSON.stringify(runtimeImport)};`
    )
    const outputFile = path.join(outputDir, `${name}.js`)
    writeFileSync(outputFile, executable)
    return spawnSync(process.execPath, ["--no-warnings", outputFile], { cwd: root, encoding: "utf8" })
}

test("a component renders props into its element", () => {
    const result = runSlim("render", `
        export component Greeting(props) {
            return <div class="greeting">Hi ${"$"}{props.name}</div>
        }
        log(Greeting({ name: "Alice" }).outerHTML)
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /<div class="greeting">Hi Alice<\/div>/)
})

test("onMount runs after build with the root element", () => {
    const result = runSlim("onmount", `
        export component Box(props) {
            onMount((el) => { el.querySelector(".label").textContent = "mounted" })
            return <div class="box"><span class="label">x</span></div>
        }
        log(Box({}).outerHTML)
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /<span class="label">mounted<\/span>/)
})

test("a return inside a setup callback does not truncate the component body", () => {
    const result = runSlim("nested-return", `
        export component Guard(props) {
            let ran = false
            onMount((el) => {
                if (!props.skip) { ran = true; return }
                el.dataset.skipped = "1"
            })
            const label = ran ? "before" : "after"
            return <div class="guard" data-label="${"$"}{label}">body</div>
        }
        const el = Guard({})
        log(el.outerHTML)
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /data-label="after"/)
    assert.match(result.stdout, /class="guard"/)
})

test("markup assigned in the component body is interpolated as markup", () => {
    const result = runSlim("nested-template", `
        export component Badge(props) {
            const extra = props.extra ? <b>${"$"}{props.extra}</b> : ""
            return <div class="badge">${"$"}{extra}base</div>
        }
        log(Badge({ extra: "x" }).outerHTML)
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /<b>x<\/b>base/)
})

test("onMount can attach an imperative method to the element", () => {
    const result = runSlim("handle", `
        export component Panel(props) {
            onMount((el) => { el.open = () => el.classList.add("active") })
            return <div class="panel">body</div>
        }
        const p = Panel({})
        p.open()
        log(p.outerHTML)
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /class="panel active"/)
})

test("onConnect fires the callback with the element (eager off-browser)", () => {
    const result = runSlim("onconnect", `
        export component Live(props) {
            onConnect((el) => { el.dataset.connected = "1" })
            return <div class="live">x</div>
        }
        log(Live({}).outerHTML)
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /data-connected="1"/)
})

test("onConnect and onUnmount compile and do not throw when both are declared", () => {
    const result = runSlim("onlifecycle", `
        export component Live(props) {
            let events = []
            onConnect((el) => { events.push("c") })
            onUnmount((el) => { events.push("u") })
            onMount((el) => { el.dataset.events = events.join(",") })
            return <div class="live">x</div>
        }
        const el = Live({})
        log(el.outerHTML)
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /class="live"/)
    assert.match(result.stdout, /data-events=/)
})
