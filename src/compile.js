import "./handlers/errorHandler.js"
import fs from "fs"
import path from "path"
import { transform } from "./transform.js"

import { readFile } from 'fs/promises';
import { Debug } from "./external/defaults.js";
import { stripComments } from "./parser.js";

const compiled = new Set()

function syncExternal() {
    const srcExternal = path.resolve("src/external")
    const distExternal = path.resolve("dist/external")

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

function resolveSlimPath(raw, fromFile) {
    if (raw.startsWith("@slim/")) {
        const rel = raw.replace("@slim/", "")
        return path.resolve("src/lib", rel + ".slim")
    }

    if (raw.endsWith(".js")) {
        const fromDir = path.dirname(fromFile)
        return path.resolve(fromDir, raw)
    }

    const fromDir = path.dirname(fromFile)
    return path.resolve(fromDir, raw + ".slim")
}

function getDistPath(slimFile) {
    const abs = path.resolve(slimFile)
    const srcRoot = path.resolve("src")
    const projectRoot = path.resolve(".")

    if (abs.startsWith(srcRoot)) {
        const rel = path.relative(srcRoot, abs)
        return path.resolve("dist", rel.replace(/\.slim$/, ".js"))
    }

    const rel = path.relative(projectRoot, abs)
    return path.resolve("dist", rel.replace(/\.slim$/, ".js"))
}

function extractUses(code) {
    code = stripComments(code)
    const uses = []

    const patterns = [
        // use @slim/pkg
        /\buse\s+(@slim\/[\w$\/.-]+)\s*;?$/gm,
        // use { X } from @slim/pkg
        /\buse\s+(?:\{[^}]+\}|\*\s+as\s+[\w$]+|[\w$]+)\s+from\s+(@slim\/[\w$\/.-]+)\s*;?$/gm,
        // use { X } from "file"
        /\buse\s+(?:\{[^}]+\}|\*\s+as\s+[\w$]+|[\w$]+)\s+from\s+"([^"]+)"\s*;?$/gm,
        // use "file"
        /\buse\s+"([^"]+)"\s*;?$/gm,
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
    for (const raw of uses) {
        const depPath = resolveSlimPath(raw, abs)
        if (depPath.endsWith(".js")) continue
        if (depPath === abs) {
            console.error(`\nError: Circular dependency detected in ${abs}\n`)
            process.exit(1)
        }
        compileFile(depPath, false, mainEntry)
    }

    const { code: output } = transform(code, abs)

    if (isEntry) {
        const outputPath = path.resolve(`dist/${mainEntry}.js`)
        fs.mkdirSync(path.dirname(outputPath), { recursive: true })
        fs.writeFileSync(outputPath, output)
    } else {
        const distPath = getDistPath(abs)
        fs.mkdirSync(path.dirname(distPath), { recursive: true })
        fs.writeFileSync(distPath, output)
    }
}

function cleanDist(slimFileClear) {
    const keep = new Set([
        path.resolve(`dist/${slimFileClear}.js`),
        path.resolve("dist/mappings.json"),
    ])

    function addDirToKeep(dir) {
        if (!fs.existsSync(dir)) return
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.resolve(dir, entry.name)
            keep.add(full)
            if (entry.isDirectory()) addDirToKeep(full)
        }
    }
    addDirToKeep(path.resolve("dist/external"))

    for (const slimFile of compiled) {
        if (slimFile === path.resolve(`${slimFileClear}.slim`)) {
            keep.add(path.resolve(`dist/${slimFileClear}.js`))
        } else {
            keep.add(getDistPath(slimFile))
        }
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

    walkAndClean(path.resolve("dist"))
}

async function main() {
    try {
        const filePath = "slimconfig.json";
        const contents = await readFile(filePath, 'utf8');
        const data = JSON.parse(contents);

        if("main" in data) {
            syncExternal()
            compileFile(data.main, true, data.main)
            cleanDist(data.main)
        }
    } catch (error) {
        console.error('Error reading or parsing slimconfig.json:', error);
        process.exit(1)
    }
}
main()
