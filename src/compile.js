import "./handlers/errorHandler.js"
import fs from "fs"
import path from "path"

import { readFile } from 'fs/promises';
import { Debug } from "./external/core.js";
import { stripComments } from "./parser.js";
import { tokenize } from "./lexer.js";
import { UseError } from "./external/classErrors.js";
import { getDistPath, resolveSlimSource, PACKAGE_ROOT, distDirName, projectPackagesDir } from "./modulePaths.js";
import { BuildCache, CACHE_FILE, compilerFingerprint, fileHash, hash } from "./buildCache.js";
import pkg from "../package.json" with { type: "json" };

const compiled = new Set()

let usePackages = true
let jsdoc = false
let declarations = false
let check = true
let useStyle = "import"

const args = new Set(process.argv.slice(2))
const flags = {
    explain: args.has("--explain-checks"),
    clean: args.has("--clean"),
    cache: !args.has("--no-cache"),
    stats: args.has("--stats"),
    statsJson: args.has("--stats-json"),
}

let cache = null
const graph = new Map()
let primitiveRedefined = false
const primitiveNames = new Set(["int", "float", "number", "string", "bool", "null", "undefined"])
const stats = { compiled: [], cached: [] }
const reports = new Map()

// Babel dominates start-up time, so the compiler itself is only loaded once a module
// actually has to be compiled; a fully cached build never touches it. Type records of
// cached modules are handed over at that point.
let engine = null
const pendingTypes = new Map()

async function loadEngine() {
    if (!engine) {
        const [{ transform }, checker] = await Promise.all([import("./transform.js"), import("./checker.js")])
        engine = { transform, exportModuleTypes: checker.exportModuleTypes, importModuleTypes: checker.importModuleTypes }
    }
    for (const [file, types] of pendingTypes) engine.importModuleTypes(file, types)
    pendingTypes.clear()
    return engine
}

function syncExternal() {
    const srcExternal = path.join(PACKAGE_ROOT, "src/external")
    const distExternal = path.resolve(distDirName(), "external")

    if (!fs.existsSync(srcExternal)) return

    function syncDir(srcDir, distDir) {
        fs.mkdirSync(distDir, { recursive: true })

        const entries = fs.readdirSync(srcDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
        const names = new Set(entries.map(entry => entry.name))
        for (const name of fs.readdirSync(distDir)) {
            if (!names.has(name)) fs.rmSync(path.join(distDir, name), { recursive: true, force: true })
        }
        for (const entry of entries) {
            const srcFull = path.join(srcDir, entry.name)
            const distFull = path.join(distDir, entry.name)

            if (entry.isDirectory()) {
                syncDir(srcFull, distFull)
                continue
            }

            if (fileHash(srcFull) === fileHash(distFull)) continue

            fs.copyFileSync(srcFull, distFull)
            Debug.log(`Synced: ${path.relative(".", distFull)}`)
        }
    }

    syncDir(srcExternal, distExternal)
}

function extractUses(code) {
    code = stripComments(code)
    const uses = []
    const starts = new Set(tokenize(code).filter(token => token.type === "name" && token.value === "use").map(token => token.start))

    const patterns = [
        /\buse\s+(@[\w$\/.-]+)\s*;?/gm,
        /\buse\s+(?:\{[^}]+\}|\*\s+as\s+[\w$]+|[\w$]+\s+as\s+[\w$]+|[\w$]+)\s+from\s+(@[\w$\/.-]+)\s*;?/gm,
        /\buse\s+(?:\{[^}]+\}|\*\s+as\s+[\w$]+|[\w$]+\s+as\s+[\w$]+|[\w$]+)\s+from\s+["']([^"']+)["']\s*;?/gm,
        /\buse\s+["']([^"']+)["']\s*;?/gm,
    ]

    for (const pattern of patterns) {
        let match
        while ((match = pattern.exec(code)) !== null) {
            const raw = match[1]
            if (raw && starts.has(match.index)) uses.push({ raw, start: match.index })
        }
    }

    return [...new Set(uses.sort((a, b) => a.start - b.start).map(entry => entry.raw))]
}

// Discover the complete graph before compiling. A module key covers its sorted reachable
// closure, including edge resolution. This also invalidates every member of a cycle when
// any dependency changes, independently of DFS order.
function discover(slimFile) {
    const abs = path.resolve(slimFile.endsWith(".slim") ? slimFile : slimFile + ".slim")
    if (graph.has(abs)) return abs
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`)
    const code = fs.readFileSync(abs, "utf8")
    // Type definitions live in a runtime registry shared by all loaded modules. Even a
    // sibling module can redefine a primitive, so this condition is project-wide.
    const tokens = tokenize(code).filter(token => !["ws", "newline", "comment"].includes(token.type))
    if (tokens.some((token, i) => token.type === "name" && ["type", "struct", "enum"].includes(token.value)
        && primitiveNames.has(tokens[i + 1]?.value))) primitiveRedefined = true
    const uses = extractUses(code)
    if (!usePackages && uses.length) {
        throw new UseError(`The "use" feature is disabled. Set "uses": { "enabled": true } in slimconfig.json to enable imports (in ${abs}, found: use ${uses[0]})`)
    }
    const resolved = uses.map(raw => ({ raw, depPath: resolveSlimSource(raw, abs) }))
    graph.set(abs, { code, resolved })
    for (const { raw, depPath } of resolved) {
        if (!depPath) continue
        if (!fs.existsSync(depPath)) throw new UseError(`No lib/file founded by the path: ${raw}`)
        if (depPath === abs) throw new Error(`Circular dependency detected in ${abs}`)
        discover(depPath)
    }
    return abs
}

function graphKey(abs) {
    const reachable = new Set()
    function visit(file) {
        if (reachable.has(file)) return
        reachable.add(file)
        for (const { depPath } of graph.get(file).resolved) if (depPath) visit(depPath)
    }
    visit(abs)
    return hash(...[...reachable].sort().flatMap(file => {
        const { code, resolved } = graph.get(file)
        return [file, code, JSON.stringify(resolved)]
    }))
}

async function compileFile(abs, isEntry = false, mainEntry = null) {
    if (compiled.has(abs)) return
    compiled.add(abs)
    const { code, resolved } = graph.get(abs)
    for (const { depPath } of resolved) if (depPath) await compileFile(depPath, false, mainEntry)

    const outputPath = isEntry
        ? path.resolve(distDirName(), `${mainEntry}.js`)
        : getDistPath(abs)

    const key = hash(graphKey(abs), outputPath, String(primitiveRedefined))

    const hit = cache.lookup(abs, key)
    if (hit) {
        if (hit.types) pendingTypes.set(abs, hit.types)
        cache.store(abs, hit)
        stats.cached.push(abs)
        reports.set(abs, hit.checks ?? [])
        return
    }

    const { transform, exportModuleTypes } = await loadEngine()
    const { code: output, declarations: dts, checks } = transform(code, abs, { jsdoc, declarations, check, uses: useStyle, elide: !primitiveRedefined })

    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, output)

    const dtsPath = dts ? outputPath.replace(/\.js$/, ".d.ts") : null
    if (dtsPath) fs.writeFileSync(dtsPath, dts)

    cache.store(abs, {
        key,
        output: outputPath,
        outputHash: fileHash(outputPath),
        declarations: dtsPath,
        declarationsHash: dtsPath ? fileHash(dtsPath) : null,
        types: check ? exportModuleTypes(abs) : null,
        checks
    })
    stats.compiled.push(abs)
    reports.set(abs, checks)
}

function cleanDist(slimFileClear) {
    const keep = new Set([
        path.resolve(distDirName(), `${slimFileClear}.js`),
        path.resolve(distDirName(), "mappings.json"),
        path.resolve(distDirName(), CACHE_FILE),
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

    for (const entry of cache.modules.values()) {
        keep.add(entry.output)
        if (entry.declarations) keep.add(entry.declarations)
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

    const uses = data.uses && typeof data.uses === "object" ? data.uses : null
    usePackages = uses ? uses.enabled !== false : data.usePackages !== false
    useStyle = uses
        ? (typeof uses.style === "string" ? uses.style : "import")
        : (typeof data.uses === "string" ? data.uses : "import")
    jsdoc = data.jsdoc === true
    declarations = data.declarations === true
    check = data.check !== false && process.env.SLIM_NO_CHECK !== "1"

    if (!("main" in data)) return

    try {
        if (flags.clean) wipeOutput()

        cache = new BuildCache(path.resolve(distDirName()), compilerFingerprint({
            jsdoc,
            declarations,
            check,
            useStyle,
            usePackages,
            release: process.env.SLIM_RELEASE === "1",
            elide: process.env.SLIM_NO_ELIDE !== "1",
            dist: distDirName(),
            packages: projectPackagesDir(),
            cwd: process.cwd(),
        }, pkg.version), flags.cache)

        cache.pruneDeleted()
        syncExternal()
        const entry = discover(data.main)
        await compileFile(entry, true, data.main)
        cleanDist(data.main)
        cache.save()
        if (jsdoc) writeJsConfig()

        printReports()
    } catch (error) {
        console.error(`\n${error.slimTypeErrors || error.slimSyntaxError ? error.message : error}\n`)
        process.exit(1)
    }
}

// --clean: the output directory is wholly generated (cleanDist already deletes anything
// unknown in it), so a clean build starts by removing it together with the cache.
function wipeOutput() {
    const dist = path.resolve(distDirName())
    const relative = path.relative(process.cwd(), dist)

    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        console.error(`\nError: refusing to clean "${dist}": the output directory must be a subdirectory of the project\n`)
        process.exit(1)
    }

    fs.rmSync(dist, { recursive: true, force: true })
}

function printReports() {
    const show = file => path.relative(".", file)

    if (flags.stats) {
        console.log(`Compiled ${stats.compiled.length}, cached ${stats.cached.length}`)
    }
    if (flags.statsJson) {
        console.log("slim-build-stats " + JSON.stringify({
            compiled: stats.compiled.map(show).sort(),
            cached: stats.cached.map(show).sort(),
        }))
    }

    if (!flags.explain) return

    if (!check) {
        console.log("Static checking is off (--no-check), so no check can be proven and none was removed.")
        return
    }

    const lines = []
    let removed = 0
    let kept = 0

    for (const file of [...reports.keys()].sort()) {
        const decisions = reports.get(file)
        if (decisions.length === 0) continue

        lines.push(show(file))
        for (const decision of decisions) {
            if (decision.status === "removed") removed++
            else kept++
            const where = `${decision.line}:${decision.column}`.padEnd(7)
            lines.push(`  ${where} ${decision.status.padEnd(7)} ${decision.kind} ${decision.name}: ${decision.type}  -- ${decision.reason}`)
        }
    }

    console.log(`Runtime checks: ${removed} removed, ${kept} kept`)
    if (lines.length) console.log(lines.join("\n"))
}
main()
