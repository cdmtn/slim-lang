import "./handlers/errorHandler.js"
import fs from "fs"
import path from "path"
import { transform } from "./transform.js"

import { readFile } from 'fs/promises';
import { Debug } from "./external/core.js";
import { stripComments } from "./parser.js";
import { UseError } from "./external/classErrors.js";
import { getDistPath, resolveSlimSource, PACKAGE_ROOT, distDirName } from "./modulePaths.js";

const compiled = new Set()

let usePackages = true
let jsdoc = false
let declarations = false
let check = true
let useStyle = "import"

function syncExternal() {
    const srcExternal = path.join(PACKAGE_ROOT, "src/external")
    const distExternal = path.resolve(distDirName(), "external")

    if (!fs.existsSync(srcExternal)) return

    function syncDir(srcDir, distDir) {
        fs.mkdirSync(distDir, { recursive: true })

        for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
            const srcFull = path.join(srcDir, entry.name)
            const distFull = path.join(distDir, entry.name)

            if (entry.isDirectory()) {
                syncDir(srcFull, distFull)
                continue
            }

            if (fs.existsSync(distFull)) {
                const srcMtime = fs.statSync(srcFull).mtimeMs
                const distMtime = fs.statSync(distFull).mtimeMs
                if (srcMtime <= distMtime) continue
            }

            fs.copyFileSync(srcFull, distFull)
            Debug.log(`Synced: ${path.relative(".", distFull)}`)
        }
    }

    syncDir(srcExternal, distExternal)
}

function extractUses(code) {
    code = stripComments(code)
    const uses = []

    const patterns = [
        /\buse\s+(@[\w$\/.-]+)\s*;?$/gm,
        /\buse\s+(?:\{[^}]+\}|\*\s+as\s+[\w$]+|[\w$]+\s+as\s+[\w$]+|[\w$]+)\s+from\s+(@[\w$\/.-]+)\s*;?$/gm,
        /\buse\s+(?:\{[^}]+\}|\*\s+as\s+[\w$]+|[\w$]+\s+as\s+[\w$]+|[\w$]+)\s+from\s+["']([^"']+)["']\s*;?$/gm,
        /\buse\s+["']([^"']+)["']\s*;?$/gm,
    ]

    for (const pattern of patterns) {
        let match
        while ((match = pattern.exec(code)) !== null) {
            const raw = match[1]
            if (raw) uses.push(raw)
        }
    }

    return [...new Set(uses)]
}

function compileFile(slimFile, isEntry = false, mainEntry = null) {
    const hasSilmExtension = slimFile.endsWith(".slim")
    const file = hasSilmExtension ? slimFile : slimFile + ".slim"
    const abs = path.resolve(file)

    if (compiled.has(abs)) return
    compiled.add(abs)

    if (!fs.existsSync(abs)) {
        console.error(`\nError: File not found: ${abs}\n`)
        process.exit(1)
    }

    const code = fs.readFileSync(abs, "utf8")

    const uses = extractUses(code)

    if (!usePackages && uses.length > 0) {
        const err = new UseError(
            `The "use" feature is disabled. Set "usePackages": true in slimconfig.json to enable imports (in ${abs}, found: use ${uses[0]})`
        )
        console.error(err)
        process.exit(1)
    }

    for (const raw of uses) {
        const depPath = resolveSlimSource(raw, abs)

        if (depPath === null) continue

        if (!fs.existsSync(depPath)) {
            const err = new UseError(`No lib/file founded by the path: ${raw}`)
            console.error(err)
            process.exit(1)
        }

        if (depPath === abs) {
            console.error(`\nError: Circular dependency detected in ${abs}\n`)
            process.exit(1)
        }
        compileFile(depPath, false, mainEntry)
    }

    const { code: output, declarations: dts } = transform(code, abs, { jsdoc, declarations, check, uses: useStyle })

    const outputPath = isEntry
        ? path.resolve(distDirName(), `${mainEntry}.js`)
        : getDistPath(abs)

    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, output)

    if (dts) fs.writeFileSync(outputPath.replace(/\.js$/, ".d.ts"), dts)
}

function cleanDist(slimFileClear) {
    const keep = new Set([
        path.resolve(distDirName(), `${slimFileClear}.js`),
        path.resolve(distDirName(), "mappings.json"),
    ])

    function addDirToKeep(dir) {
        if (!fs.existsSync(dir)) return
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.resolve(dir, entry.name)
            keep.add(full)
            if (entry.isDirectory()) addDirToKeep(full)
        }
    }
    addDirToKeep(path.resolve(distDirName(), "external"))

    for (const slimFile of compiled) {
        if (slimFile === path.resolve(`${slimFileClear}.slim`)) {
            keep.add(path.resolve(distDirName(), `${slimFileClear}.js`))
        } else {
            keep.add(getDistPath(slimFile))
        }
    }

    for (const kept of [...keep]) {
        if (kept.endsWith(".js")) keep.add(kept.replace(/\.js$/, ".d.ts"))
    }

    function walkAndClean(dir) {
        if (!fs.existsSync(dir)) return

        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.resolve(dir, entry.name)

            if (entry.isDirectory()) {
                walkAndClean(full)

                if (fs.readdirSync(full).length === 0) {
                    fs.rmdirSync(full)
                }
            } else if (!keep.has(full)) {
                fs.rmSync(full)
                Debug.log(`Cleaned: ${path.relative(".", full)}`)
            }
        }
    }

    walkAndClean(path.resolve(distDirName()))
}

function writeJsConfig() {
    const configPath = path.resolve("jsconfig.json")
    if (fs.existsSync(configPath)) return

    const config = {
        compilerOptions: {
            allowJs: true,
            checkJs: false,
            noEmit: true,
            module: "esnext",
            target: "es2020",
            moduleResolution: "bundler",
            strict: false,
            skipLibCheck: true
        },
        include: [distDirName()]
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 4) + "\n")
    Debug.log("Created jsconfig.json for TypeScript checking")
}

async function main() {
    let data

    try {
        const contents = await readFile("slimconfig.json", "utf8")
        data = JSON.parse(contents)
    } catch (error) {
        console.error("Error reading or parsing slimconfig.json:", error)
        process.exit(1)
    }

    usePackages = data.usePackages !== false
    jsdoc = data.jsdoc === true
    declarations = data.declarations === true
    check = data.check !== false && process.env.SLIM_NO_CHECK !== "1"
    useStyle = typeof data.uses === "string" ? data.uses : "import"

    if (!("main" in data)) return

    try {
        syncExternal()
        compileFile(data.main, true, data.main)
        cleanDist(data.main)
        if (jsdoc) writeJsConfig()
    } catch (error) {
        console.error(`\n${error.slimTypeErrors || error.slimSyntaxError ? error.message : error}\n`)
        process.exit(1)
    }
}
main()
