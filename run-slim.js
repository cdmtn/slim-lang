#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { spawn } from "node:child_process"
import path from "node:path"

const root = process.cwd()
const config = JSON.parse(readFileSync(path.join(root, "slimconfig.json"), "utf8").replace(/^\uFEFF/, ""))
const distName = config.names?.dist ?? config.dist
const distDir = typeof distName === "string" && distName.trim() ? distName : "slim-dist"

if (typeof config.main !== "string" || !config.main.trim()) {
    console.error('slimconfig.json has no "main" entry')
    process.exit(1)
}

const entry = path.resolve(root, distDir, `${config.main}.js`)
const proc = spawn(process.execPath, ["--enable-source-maps", "--no-warnings", entry], { stdio: "inherit" })

proc.on("error", err => {
    console.error(err.message)
    process.exit(1)
})
proc.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
