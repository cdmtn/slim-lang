import assert from "node:assert/strict"
import { test } from "node:test"
import path from "node:path"
import { resolveSlimSource, resolveSlimImport } from "../src/modulePaths.js"
import { transform } from "../src/transform.js"

const root = process.cwd()
const fromFile = path.join(root, "index.slim")

test("an installed node module is treated as external, not a slim source", () => {
    assert.equal(resolveSlimSource("commander", fromFile), null)
})

test("an installed node module passes through as a bare specifier", () => {
    assert.equal(resolveSlimImport("commander", fromFile), "commander")
})

test("a subpath of an installed node module keeps its full specifier", () => {
    assert.equal(resolveSlimImport("commander/esm.mjs", fromFile), "commander/esm.mjs")
})

test("an unknown bare specifier still resolves to a local slim source", () => {
    const resolved = resolveSlimSource("definitely-not-installed-xyz", fromFile)
    assert.notEqual(resolved, null)
    assert.match(resolved, /definitely-not-installed-xyz\.slim$/)
})

test("a relative specifier is never treated as a node module", () => {
    assert.notEqual(resolveSlimSource("./helpers", fromFile), null)
})

test("`use` from an installed package lowers to a bare import", () => {
    const { code } = transform(`use { Command } from "commander"\nlog(1)`, fromFile)
    assert.match(code, /import\s*\{\s*Command\s*\}\s*from\s*"commander"/)
})

test("`use` accepts single-quoted specifiers", () => {
    const { code } = transform(`use { Command } from 'commander'\nlog(1)`, fromFile)
    assert.match(code, /import\s*\{\s*Command\s*\}\s*from\s*"commander"/)
})

test("a bare `use X from` defaults to a default import", () => {
    const { code } = transform(`use commander from "commander"\nlog(1)`, fromFile)
    assert.match(code, /import\s+commander\s+from\s*"commander"/)
})

test('`uses: "named"` restores the legacy named-import style for a bare `use`', () => {
    const { code } = transform(`use commander from "commander"\nlog(1)`, fromFile, { uses: "named" })
    assert.match(code, /import\s*\{\s*commander\s*\}\s*from\s*"commander"/)
})
