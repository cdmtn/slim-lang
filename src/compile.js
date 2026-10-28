import "./handlers/errorHandler.js"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { transform } from "./transform.js"
import { exportModuleTypes, importModuleTypes } from "./checker.js"
import { reactiveExports } from "./reactivity.js"
import { findUses } from "./syntax/index.js"
import { UseError } from "./external/classErrors.js"
import { getDistPath, setOutputPath, resolveSlimSource, PACKAGE_ROOT, distDirName, readJson } from "./modulePaths.js"

const compiled = new Set()
const compiling = []


const CACHE_FILE = () => path.resolve(distDirName(), ".slim-cache.json")
const hash = text => createHash("sha1").update(text).digest("hex")

let cache = { key: null, files: {} }
let nextCache = { key: null, files: {} }
const changedTypes = new Set()
let reused = 0

function compilerFingerprint(config) {
    const parts = [JSON.stringify(config), JSON.stringify({ jsdoc, declarations, check, release, useStyle, usePackages })]
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) walk(full)
            else if (entry.name.endsWith(".js")) {
                const { mtimeMs, size } = fs.statSync(full)
                parts.push(`${full}:${mtimeMs}:${size}`)
            }
        }
    }
    walk(path.join(PACKAGE_ROOT, "src"))
    return hash(parts.join("\n"))
}

function loadCache(key) {
    nextCache = { key, files: {} }
    if (process.env.SLIM_FORCE === "1") return
    try {
        const saved = JSON.parse(fs.readFileSync(CACHE_FILE(), "utf8"))
        if (saved.key === key) cache = saved
    } catch {
    }
}

function saveCache() {
    fs.mkdirSync(path.dirname(CACHE_FILE()), { recursive: true })
    fs.writeFileSync(CACHE_FILE(), JSON.stringify(nextCache))
}

let usePackages = true
let jsdoc = false
let declarations = false
let check = true
let useStyle = "import"
let release = false

const debug = (...args) => console.log("[SLIM]", ...args)

function fail(error) {
    console.error(`\n${error.tag ?? error.name}: ${error.message}\n`)
    process.exit(1)
}

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

            if (fs.existsSync(distFull) && fs.statSync(srcFull).mtimeMs <= fs.statSync(distFull).mtimeMs) continue

            fs.copyFileSync(srcFull, distFull)
            debug(`Synced: ${path.relative(".", distFull)}`)
        }
    }

    syncDir(srcExternal, distExternal)
}

function compileFile(slimFile) {
    const abs = path.resolve(slimFile.endsWith(".slim") ? slimFile : slimFile + ".slim")

    if (compiled.has(abs)) return
    compiled.add(abs)

    if (!fs.existsSync(abs)) fail(new Error(`File not found: ${abs}`))

    const code = fs.readFileSync(abs, "utf8")
    const uses = [...new Set(findUses(code).map(use => use.source))]

    if (!usePackages && uses.length > 0) {
        fail(new UseError(
            `The "use" feature is disabled. Set "uses": { "enabled": true } in slimconfig.json to enable imports (in ${abs}, found: use ${uses[0]})`
        ))
    }

    const deps = []
    let inCycle = false

    compiling.push(abs)
    for (const raw of uses) {
        const depPath = resolveSlimSource(raw, abs)
        if (depPath === null) continue

        if (!fs.existsSync(depPath)) fail(new UseError(`Nothing found for "use ${raw}" (looked for ${depPath})`))
        if (depPath === abs) fail(new UseError(`${abs} uses itself`))

        const cycleStart = compiling.indexOf(depPath)
        if (cycleStart !== -1) {
            const chain = [...compiling.slice(cycleStart), depPath].map(file => path.relative(".", file))
            console.warn(`[SLIM] Warning: circular use ${chain.join(" -> ")}`)
            inCycle = true
            continue
        }

        compileFile(depPath)
        deps.push(depPath)
    }
    compiling.pop()

    const outputPath = getDistPath(abs)
    const sourceHash = hash(code)
    const saved = cache.files[abs]
    const upToDate = saved && !inCycle && saved.hash === sourceHash && saved.output === outputPath &&
        fs.existsSync(outputPath) && deps.every(dep => !changedTypes.has(dep))

    if (upToDate) {
        importModuleTypes(abs, saved.types)
        nextCache.files[abs] = saved
        reused++
        return
    }

    const { code: output, declarations: dts } = transform(code, abs, {
        jsdoc, declarations, check, release, uses: useStyle, outFile: outputPath
    })

    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, output)

    if (dts) fs.writeFileSync(outputPath.replace(/\.js$/, ".d.ts"), dts)

    const types = exportModuleTypes(abs)
    const reactive = JSON.stringify([...reactiveExports(abs)])
    if (!saved || saved.types !== types || saved.reactive !== reactive) changedTypes.add(abs)
    nextCache.files[abs] = { hash: sourceHash, output: outputPath, types, reactive }
}

function cleanDist() {
    const keep = new Set([path.resolve(distDirName(), "mappings.json"), CACHE_FILE()])

    function keepDir(dir) {
        if (!fs.existsSync(dir)) return
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.resolve(dir, item.name)
            keep.add(full)
            if (item.isDirectory()) keepDir(full)
        }
    }
    keepDir(path.resolve(distDirName(), "external"))

    for (const slimFile of compiled) keep.add(getDistPath(slimFile))

    for (const kept of [...keep]) {
        if (kept.endsWith(".js")) keep.add(kept.replace(/\.js$/, ".d.ts"))
    }

    function clean(dir) {
        if (!fs.existsSync(dir)) return

        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.resolve(dir, item.name)

            if (item.isDirectory()) {
                clean(full)
                if (fs.readdirSync(full).length === 0) fs.rmdirSync(full)
            } else if (!keep.has(full)) {
                fs.rmSync(full)
                debug(`Cleaned: ${path.relative(".", full)}`)
            }
        }
    }

    clean(path.resolve(distDirName()))
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
    debug("Created jsconfig.json for TypeScript checking")
}

function main() {
    let data

    try {
        data = readJson("slimconfig.json")
    } catch (error) {
        console.error("Error reading or parsing slimconfig.json:", error.message)
        process.exit(1)
    }

    const uses = data.uses && typeof data.uses === "object" ? data.uses : null
    usePackages = uses ? uses.enabled !== false : data.usePackages !== false
    useStyle = uses
        ? (typeof uses.style === "string" ? uses.style : "import")
        : (typeof data.uses === "string" ? data.uses : "import")
    jsdoc = data.jsdoc === true
    declarations = data.declarations === true
    check = data.check !== false && process.env.SLIM_NO_CHECK !== "1"
    release = data.release === true || process.env.SLIM_RELEASE === "1"

    if (!("main" in data)) return

    try {
        syncExternal()
        loadCache(compilerFingerprint(data))
        const entry = data.main.endsWith(".slim") ? data.main : `${data.main}.slim`
        setOutputPath(entry, path.resolve(distDirName(), `${data.main}.js`))
        compileFile(entry)
        cleanDist()
        saveCache()
        if (reused > 0) debug(`Up to date: ${reused} of ${compiled.size} files`)
        if (jsdoc) writeJsConfig()
    } catch (error) {
        console.error(`\n${error.slimTypeErrors || error.slimSyntaxError ? error.message : error}\n`)
        process.exit(1)
    }
}

main()
