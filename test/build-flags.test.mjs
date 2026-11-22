import assert from "node:assert/strict"
import { test } from "node:test"
import { transform } from "../src/transform.js"

const SOURCE = [
    `func report(n: int) -> int {`,
    `    if (SLIM_DEV) log("checking", n)`,
    `    if (!SLIM_RELEASE) { log("dev branch") } else { log("release branch") }`,
    `    const mode = SLIM_RELEASE ? "release" : "dev"`,
    `    log(mode)`,
    `    return SLIM_DEV && n > 0 ? n : 0`,
    `}`,
    `log(report(2))`
].join("\n")

const compile = (source, options = {}) => transform(source, "flags.slim", { sourceMaps: false, ...options }).code

test("SLIM_DEV and SLIM_RELEASE follow the release option and fold away the other branch", () => {
    const dev = compile(SOURCE)
    assert.match(dev, /log\("checking", n\)/)
    assert.match(dev, /log\("dev branch"\)/)
    assert.doesNotMatch(dev, /release branch|SLIM_/)
    assert.match(dev, /const mode = "dev"/)
    assert.match(dev, /return n > 0 \? n : 0/)

    const release = compile(SOURCE, { release: true })
    assert.doesNotMatch(release, /checking|dev branch|SLIM_/)
    assert.match(release, /log\("release branch"\)/)
    assert.match(release, /const mode = "release"/)
    assert.match(release, /return 0/)
})

test("the build flags are typed bool and a local binding of the same name wins", () => {
    assert.throws(() => compile(`const n: int = SLIM_DEV`), /"n" expects int, got bool/)
    const shadowed = compile(`func pick(SLIM_DEV: bool) -> bool { return SLIM_DEV }\nlog(pick(false))`, { release: true })
    assert.match(shadowed, /return SLIM_DEV/)
})
