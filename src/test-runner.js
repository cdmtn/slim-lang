import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { transform } from "./transform.js"
import { distDirName } from "./modulePaths.js"

const root = process.cwd()
const runtimeImport = pathToFileURL(path.resolve("src/external/defaults.js")).href
const outDir = path.resolve(distDirName(), "__slim_tests__")

function findTests(target) {
    if (target) {
        const file = target.endsWith(".slim") ? target : target + ".slim"
        return [path.resolve(file)]
    }

    const results = []
    const walk = dir => {
        if (!fs.existsSync(dir)) return
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (entry.name !== "node_modules" && entry.name !== distDirName() && entry.name !== ".git") {
                    walk(path.join(dir, entry.name))
                }
            } else if (entry.name.endsWith(".test.slim")) {
                results.push(path.join(dir, entry.name))
            }
        }
    }
    walk(root)
    return results
}

export function runTests(target) {
    const files = findTests(target)

    if (files.length === 0) {
        console.log("No test files found (*.test.slim)")
        return 0
    }

    fs.mkdirSync(outDir, { recursive: true })
    let failed = 0

    for (const file of files) {
        const { code } = transform(fs.readFileSync(file, "utf8"), file)
        const executable = code.replace(
            /^import\s+[^;]*defaults\.js";$/m,
            `import ${JSON.stringify(runtimeImport)};`
        )
        const outFile = path.join(outDir, path.basename(file).replace(/\.slim$/, ".mjs"))
        fs.writeFileSync(outFile, executable)

        console.log(`\n${path.relative(root, file)}`)
        const result = spawnSync(process.execPath, ["--enable-source-maps", "--no-warnings", outFile], {
            stdio: "inherit"
        })
        if (result.status !== 0) failed++
    }

    return failed > 0 ? 1 : 0
}
