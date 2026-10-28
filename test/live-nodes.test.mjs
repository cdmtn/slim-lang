import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"

const root = process.cwd()
const outputDir = path.join(root, "dist", "__live_node_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href
const S = "$"

function runSlim(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const { code } = transform(source, path.join(root, "__live_node_tests__", `${name}.slim`))
    const executable = code.replace(
        /^import\s+[^;]*(?:defaults|core)\.js";$/m,
        `import ${JSON.stringify(runtimeImport)};`
    )
    const outputFile = path.join(outputDir, `${name}.js`)
    writeFileSync(outputFile, executable)
    return spawnSync(process.execPath, ["--no-warnings", outputFile], { cwd: root, encoding: "utf8" })
}

const INNER = `
component Inner(props) {
    onMount((el) => { el.doThing = () => "alive" })
    return <span class="inner">${S}{props.label ?? "inner"}</span>
}
`

test("a component interpolated into a template keeps its behaviour", () => {
    const result = runSlim("keeps-behaviour", `${INNER}
        component Wrapper(props) {
            return <div class="wrap">${S}{Inner({ label: "nested" })}</div>
        }

        const el = Wrapper({})
        const nested = el.querySelector(".inner")
        log(typeof nested.doThing, nested.doThing(), nested.textContent)
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /function alive nested/)
})

test("the interpolated node is the very same node, not a copy", () => {
    const result = runSlim("same-node", `${INNER}
        const made = Inner({})

        component Wrapper(props) {
            return <div>${S}{made}</div>
        }

        const el = Wrapper({})
        log(el.querySelector(".inner") === made)
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^true$/m)
})

test("an array of components each keep their behaviour", () => {
    const result = runSlim("array", `${INNER}
        component List(props) {
            return <ul>${S}{[Inner({ label: "a" }), Inner({ label: "b" })]}</ul>
        }

        const el = List({})
        const items = el.querySelectorAll(".inner")
        log(items.length, [...items].every((i) => typeof i.doThing === "function"))
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /2 true/)
})

test("a template that is only an interpolated component yields that node", () => {
    const result = runSlim("bare", `${INNER}
        component Wrapper(props) {
            return ${S}{Inner({ label: "only" })}
        }

        const el = Wrapper({})
        log(el.className, el.textContent, typeof el.doThing)
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /inner only function/)
})

test("nesting several levels deep preserves every level", () => {
    const result = runSlim("deep", `${INNER}
        component Middle(props) {
            onMount((el) => { el.middle = true })
            return <div class="middle">${S}{Inner({ label: "deep" })}</div>
        }

        component Outer(props) {
            return <div class="outer">${S}{Middle({})}</div>
        }

        const el = Outer({})
        log(el.querySelector(".middle").middle, typeof el.querySelector(".inner").doThing)
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /true function/)
})

test("an embedded node still serialises for a server render", () => {
    const result = runSlim("serialise", `${INNER}
        component Wrapper(props) {
            return <div class="wrap">${S}{Inner({ label: "html" })}</div>
        }

        log(Wrapper({}).outerHTML)
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /<div class="wrap"><span class="inner">html<\/span><\/div>/)
})

test("plain strings are escaped, raw() and nested markup are not", () => {
    const result = runSlim("plain", `
        component Wrapper(props) {
            return <div title=${S}{"a b"}>${S}{"<b>x</b> & y"}${S}{raw("<i>raw</i>")}${S}{[1, 2].map(n => <u>${S}{n}</u>)}${S}{null}${S}{false}${S}{42}</div>
        }

        log(Wrapper({}).outerHTML)
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /<div title="a b">&lt;b&gt;x&lt;\/b&gt; &amp; y<i>raw<\/i><u>1<\/u><u>2<\/u>42<\/div>/)
})

test("an element component can wrap a configured generic component", () => {
    const result = runSlim("wrap-generic", `
        component Generic(props) {
            onMount((el) => { el.setActive = (id) => props.items.indexOf(id) })
            return <nav class="generic">${S}{props.items.join(",")}</nav>
        }

        export element("y-left") component Left(props) {
            return ${S}{Generic({ items: ["one", "two"] })}
        }

        const inner = Left({})
        log(Left.tag, inner.textContent, inner.setActive("two"))
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /y-left one,two 1/)
})
