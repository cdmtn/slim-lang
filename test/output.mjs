import { mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const base = mkdtempSync(path.join(os.tmpdir(), "slim-tests-"))
const modules = path.join(base, "node_modules")

symlinkSync(path.resolve("node_modules"), modules, "junction")

process.on("exit", () => {
    unlinkSync(modules)
    rmSync(base, { recursive: true, force: true })
})

export function outputFolder(name) {
    return path.join(base, name)
}
