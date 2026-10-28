import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { transform } from "../src/transform.js"
import { preprocess } from "../src/syntax/index.js"

const root = process.cwd()
const outputDir = path.join(root, "dist", "__element_tests__")
const runtimeImport = pathToFileURL(path.join(root, "src", "external", "defaults.js")).href

function runSlim(name, source) {
    mkdirSync(outputDir, { recursive: true })
    const { code } = transform(source, path.join(root, "__element_tests__", `${name}.slim`))
    const executable = code.replace(
        /^import\s+[^;]*(?:defaults|core)\.js";$/m,
        `import ${JSON.stringify(runtimeImport)};`
    )
    const outputFile = path.join(outputDir, `${name}.js`)
    writeFileSync(outputFile, executable)
    return spawnSync(process.execPath, ["--no-warnings", outputFile], { cwd: root, encoding: "utf8" })
}

test("a tag name is derived from the component name", () => {
    const lowered = name => preprocess(`element component ${name}(props) {\n    return ("<div></div>")\n}`, "x.slim").code

    assert.match(lowered("Tab"), /\.tag = "slim-tab"/)
    assert.match(lowered("TabBar"), /\.tag = "slim-tab-bar"/)
    assert.match(lowered("HTTPServer"), /\.tag = "slim-httpserver"/)
})

test("a tag may be given explicitly, for markup that already exists", () => {
    const double = preprocess(`element("auth-bg") component AuthBg(props) {\n    return ("<div></div>")\n}`, "x.slim").code
    assert.match(double, /__define_element__\("auth-bg", AuthBg\.__render__\)/)
    assert.match(double, /AuthBg\.tag = "auth-bg"/)

    const single = preprocess(`element('files-modals') component FilesModals(props) {\n    return ("<div></div>")\n}`, "x.slim").code
    assert.match(single, /__define_element__\("files-modals"/)
})

test("a tag without a hyphen is rejected, as the platform would reject it", () => {
    assert.throws(
        () => preprocess(`element("authbg") component AuthBg(props) {\n    return ("<div></div>")\n}`, "x.slim"),
        /must contain a hyphen/
    )
})

test("an element component emits a factory, a function, and a registration", () => {
    const code = preprocess(`element component Tab(props) {\n    return ("<div></div>")\n}`, "x.slim").code

    assert.match(code, /const Tab = \(__props__ = \{\}\)/)
    assert.match(code, /Tab\.__render__ = \(props = \{\}, __host__ = null\)/)
    assert.match(code, /__define_element__\("slim-tab", Tab\.__render__\)/)
    assert.match(code, /Tab\.__component__ = true/)
})

test("an exported element component exports the component, not a helper", () => {
    const result = runSlim("exported", `
        export element("y-tab") component Tab(props) {
            onMount((host) => { host.marked = true })
            return <span>${"$"}{props.label}</span>
        }

        const el = Tab({ label: "x" })
        log(Tab.tag, el.marked === true, typeof Tab.__render__)
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /y-tab true function/)
})

test("a plain component is untouched by the element path", () => {
    const code = preprocess(`component Plain(props) {\n    return ("<div></div>")\n}`, "x.slim").code

    assert.doesNotMatch(code, /__define_element__/)
    assert.match(code, /const Plain = \(props = \{\}\)/)
})

test("calling an element component returns what a plain component would", () => {
    const result = runSlim("function-form", `
        element component Tab(props) {
            return <div class="body">${"$"}{props.label}</div>
        }

        const el = Tab({ label: "hello" })
        log(el.outerHTML)
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^<div class="body">hello<\/div>$/m)
})

test("onMount receives the host, so what it assigns belongs to the tag", () => {
    const result = runSlim("host-methods", `
        element component Tab(props) {
            onMount((host) => {
                host.setLabel = (text) => { host.textContent = text }
            })

            return <span>${"$"}{props.label}</span>
        }

        const el = Tab({ label: "first" })
        log(typeof el.setLabel)
        el.setLabel("second")
        log(el.textContent)
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^function$/m)
    assert.match(result.stdout, /^second$/m)
})

test("rendering into a host keeps the rendered root intact", () => {
    const result = runSlim("into-host", `
        element("side-head") component SideHead(props) {
            onMount((el) => { el.classList.add("side-head") })
            return <button class="btn" data-target="sidebar">Menu</button>
        }

        const host = htmlToVdom("<side-head></side-head>").toElement()
        SideHead.__render__({}, host)
        log(host.outerHTML)
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /<side-head class="side-head">/)
    assert.match(result.stdout, /<button[^>]*>Menu<\/button>/)
    assert.match(result.stdout, /<button[^>]*\bclass="btn"/)
    assert.match(result.stdout, /<button[^>]*\bdata-target="sidebar"/)
    assert.doesNotMatch(result.stdout, /<side-head[^>]*data-target/)
})

test("a multi-root template puts every root inside the host", () => {
    const result = runSlim("multi-root", `
        element("two-part") component TwoPart(props) {
            return
                <span class="a">one</span>
                <span class="b">two</span>
        }

        const host = htmlToVdom("<two-part></two-part>").toElement()
        TwoPart.__render__({}, host)
        log(host.outerHTML)
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /<two-part><span class="a">one<\/span><span class="b">two<\/span><\/two-part>/)
})

test("registration is a no-op where there is no custom element registry", () => {
    const result = runSlim("no-registry", `
        element component Tab(props) {
            return <div>ok</div>
        }

        log(typeof customElements)
        log(Tab({}).outerHTML)
    `)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^undefined$/m)
    assert.match(result.stdout, /^<div>ok<\/div>$/m)
})

test("an element component still picks the DOM runtime", () => {
    const { code } = transform(`element component Tab(props) {\n    return ("<div></div>")\n}`, "x.slim")
    assert.match(code.split("\n").find(line => line.startsWith("import")), /defaults\.js/)
})
