// Examples suite: compile every examples/*.slim through the full transform.
import fs from "node:fs"
import path from "node:path"
import { ROOT } from "../env.js"

export function exampleCases() {
    const dir = path.join(ROOT, "examples")
    return fs.readdirSync(dir).filter(f => f.endsWith(".slim")).sort().map(file => ({
        name: `examples.compile.${file.replace(/\.slim$/, "")}`,
        suite: "examples",
        area: "examples",
        example: file
    }))
}
