// Child of compiler.cold-first-call: imports the compiler (untimed), then times the
// very first transform() in a fresh process, i.e. before any JIT warmup.
import fs from "node:fs"
import { pathToFileURL } from "node:url"
const [root, fixture] = process.argv.slice(2)
const { transform } = await import(pathToFileURL(`${root}/src/transform.js`).href)
const text = fs.readFileSync(fixture, "utf8")
const t = performance.now()
const { code } = transform(text, fixture, { check: true })
const ms = performance.now() - t
process.stdout.write(JSON.stringify({ ms, bytes: code.length }))
