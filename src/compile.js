import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { transform } from "./transform.js"
import { exportModuleTypes, importModuleTypes, formatDiagnostics } from "./checker.js"
import { reactiveExports } from "./reactivity.js"
import { findUses, parseProgram } from "./syntax/index.js"
import { projectExports, exportsFingerprint, autoImportsFor } from "./autoImport.js"
import { UseError } from "./external/classErrors.js"
import { getDistPath, setOutputPath, resolveSlimSource, isCoreImport, CORE_MODULES, PACKAGE_ROOT, distDirName, projectPackagesDir, readJson, canonicalPath, pathKey, resetPathCaches, caseInsensitivePaths } from "./modulePaths.js"

const compiled = new Set()
const compiling = []
const graph = new Map()
const owners = new Map()

const CACHE_FILE = () => path.resolve(distDirName(), ".slim-cache.json")
export const CLIENTS_MANIFEST = ".slim-clients.json"
const hash = text => createHash("sha1").update(text).digest("hex")

let cache = { key: null, files: {}, outputs: [] }
let nextCache = { key: null, files: {} }
let written = new Set()
const changedTypes = new Set()
let reused = 0
let compilerSource = null

function compilerSourceHash() {
    if (compilerSource) return compilerSource
    const files = []
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) walk(full)
            else if (entry.name.endsWith(".js")) files.push(full)
        }
    }
    walk(path.join(PACKAGE_ROOT, "src"))
    const digest = createHash("sha1")
    for (const file of files.sort()) {
        digest.update(path.relative(PACKAGE_ROOT, file)).update("\0").update(fs.readFileSync(file)).update("\0")
    }
    compilerSource = digest.digest("hex")
    return compilerSource
}

function packageVersion() {
    try {
        return String(readJson(path.join(PACKAGE_ROOT, "package.json")).version ?? "")
    } catch {
        return ""
    }
}

function compilerFingerprint(config) {
    return hash([
        JSON.stringify(config),
        JSON.stringify({ jsdoc, declarations, check, release, useStyle, usePackages, globals, runtime }),
        autoImport ? exportsFingerprint(autoImport) : "",
        packageVersion(),
        compilerSourceHash()
    ].join("\n"))
}

function previousOutputs(saved) {
    if (Array.isArray(saved?.outputs)) return saved.outputs.filter(file => typeof file === "string")
    const found = []
    for (const entry of Object.values(saved?.files && typeof saved.files === "object" ? saved.files : {})) {
        if (typeof entry?.output !== "string") continue
        found.push(entry.output, entry.output.replace(/\.js$/, ".d.ts"), `${entry.output}.map`)
    }
    return found
}

function loadCache(key) {
    nextCache = { key, files: {} }
    written = new Set()
    if (cache.key === key) return
    let saved = null
    try {
        saved = readJson(CACHE_FILE())
    } catch {
    }
    const files = saved?.key === key && saved.files && typeof saved.files === "object" ? saved.files : {}
    cache = { key, files, outputs: previousOutputs(saved) }
}

function saveCache(complete) {
    cache = complete
        ? { key: nextCache.key, files: nextCache.files, outputs: [...written] }
        : { key: nextCache.key, files: { ...cache.files, ...nextCache.files }, outputs: [...new Set([...cache.outputs, ...written])] }
    fs.mkdirSync(path.dirname(CACHE_FILE()), { recursive: true })
    fs.writeFileSync(CACHE_FILE(), JSON.stringify(cache))
}

function isInside(parent, target) {
    const relative = path.relative(parent, target)
    return relative !== "" && relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative)
}

function shown(file) {
    return path.relative(".", file) || file
}

function checkDist() {
    const distRoot = pathKey(distDirName())
    const projectRoot = pathKey(".")
    if (distRoot === projectRoot || isInside(distRoot, projectRoot)) {
        fail({ name: "BuildError", message: `The output folder "${distDirName()}" is the project folder or contains it. Set "dist" in slimconfig.json to a folder inside the project, like "slim-dist"` })
    }
}

function claimOutput(outputPath, source) {
    const key = pathKey(outputPath)
    const other = owners.get(key)
    if (other && other !== source) {
        fail({ name: "BuildError", message: `${shown(other)} and ${shown(source)} both compile to ${shown(outputPath)}. Rename one of them or move it to another folder` })
    }
    owners.set(key, source)
}

function depSignature(dep) {
    const entry = nextCache.files[dep]
    return entry ? hash(`${entry.types}\0${entry.reactive}`) : null
}

function depsUnchanged(saved, deps) {
    if (!saved.deps || typeof saved.deps !== "object") return deps.length === 0
    return Object.keys(saved.deps).length === deps.length && deps.every(dep => saved.deps[dep] === depSignature(dep))
}

function outputIntact(saved) {
    if (typeof saved.outHash !== "string" || !fs.existsSync(saved.output)) return false
    if (!(saved.written ?? []).every(file => fs.existsSync(file))) return false
    return hash(fs.readFileSync(saved.output)) === saved.outHash
}

let usePackages = true
let jsdoc = false
let declarations = false
let check = true
let warnings = true
let sourceMaps = "inline"
let useStyle = "import"
let release = false
let globals = []
let host = null
let autoImport = null
let runtime = "globals"
let environment = null

const debug = (...args) => console.log("[SLIM]", ...args)

class BuildFailure extends Error {}

function fail(error) {
    throw new BuildFailure(`${error.tag ?? error.name}: ${error.message}`)
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

            if (fs.existsSync(distFull) && fs.statSync(srcFull).size === fs.statSync(distFull).size &&
                fs.readFileSync(srcFull).equals(fs.readFileSync(distFull))) continue

            fs.copyFileSync(srcFull, distFull)
            debug(`Synced: ${path.relative(".", distFull)}`)
        }
    }

    syncDir(srcExternal, distExternal)
}

function autoImportFor(file) {
    if (!autoImport) return null
    const abs = path.resolve(file)
    if (isInside(projectPackagesDir(), abs) || abs.split(path.sep).includes("node_modules")) return null
    return autoImport
}

function autoDependencies(code, file) {
    const index = autoImportFor(file)
    if (!index) return []
    try {
        return autoImportsFor(parseProgram(code, file), file, index).map(found => found.raw)
    } catch {
        return []
    }
}

function compileFile(slimFile) {
    const abs = canonicalPath(slimFile.endsWith(".slim") ? slimFile : slimFile + ".slim")

    if (compiled.has(abs)) return
    compiled.add(abs)

    if (!fs.existsSync(abs)) fail(new Error(`File not found: ${abs}`))

    const code = fs.readFileSync(abs, "utf8")
    const slimUses = findUses(code).filter(use => !use.plainImport || fs.existsSync(resolveSlimSource(use.source, abs) ?? ""))
    const uses = [...new Set([...slimUses.map(use => use.source), ...autoDependencies(code, abs)])]

    if (!usePackages && uses.length > 0) {
        fail(new UseError(
            `The "use" feature is disabled. Set "uses": { "enabled": true } in slimconfig.json to enable imports (in ${abs}, found: use ${uses[0]})`
        ))
    }

    const deps = []
    const linked = []
    let inCycle = false

    compiling.push(abs)
    if (host && abs !== host) {
        compileFile(host)
        deps.push(host)
        linked.push(host)
    }
    for (const raw of uses) {
        const depPath = resolveSlimSource(raw, abs)
        if (depPath === null) continue

        if (!fs.existsSync(depPath) && isCoreImport(raw)) {
            const modules = fs.readdirSync(CORE_MODULES).filter(name => name.endsWith(".slim")).map(name => `@slim/${name.slice(0, -5)}`)
            fail(new UseError(`Slim has no module "${raw}" — its modules are ${modules.join(", ")}; the standard library is @std, installed with "spm i std"`))
        }
        if (!fs.existsSync(depPath)) fail(new UseError(`Nothing found for "use ${raw}" (looked for ${depPath})`))
        if (depPath === abs) fail(new UseError(`${abs} uses itself`))
        linked.push(depPath)

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
    graph.set(abs, [...new Set(linked)])

    const outputPath = getDistPath(abs)
    claimOutput(outputPath, abs)
    const sourceHash = hash(code)
    const saved = process.env.SLIM_FORCE === "1" ? undefined : cache.files[abs]
    const signatures = Object.fromEntries(deps.map(dep => [dep, depSignature(dep)]))
    const upToDate = saved && !inCycle && saved.hash === sourceHash && saved.output === outputPath &&
        depsUnchanged(saved, deps) && outputIntact(saved) && deps.every(dep => !changedTypes.has(dep))

    if (upToDate) {
        importModuleTypes(abs, saved.types)
        nextCache.files[abs] = saved
        for (const file of saved.written ?? [saved.output]) written.add(file)
        reused++
        return
    }

    const { code: output, declarations: dts, warnings: found, map } = transform(code, abs, {
        jsdoc, declarations, check, release, globals, host, env: environment, autoImport: autoImportFor(abs), runtime, warnings, sourceMaps, uses: useStyle, outFile: outputPath
    })
    if (found.length > 0) console.warn(`\n${formatDiagnostics(found)}\n`)

    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    const files = [outputPath]
    written.add(outputPath)
    writeOutput(outputPath, output)

    if (dts) {
        const dtsPath = outputPath.replace(/\.js$/, ".d.ts")
        files.push(dtsPath)
        written.add(dtsPath)
        writeOutput(dtsPath, dts)
    }
    if (map) {
        const mapPath = `${outputPath}.map`
        files.push(mapPath)
        written.add(mapPath)
        writeOutput(mapPath, JSON.stringify(map))
    }

    const types = exportModuleTypes(abs)
    const reactive = JSON.stringify([...reactiveExports(abs)])
    if (!saved || saved.types !== types || saved.reactive !== reactive) changedTypes.add(abs)
    nextCache.files[abs] = { hash: sourceHash, output: outputPath, outHash: hash(output), written: files, deps: signatures, types, reactive }
}

function writeOutput(file, content) {
    if (caseInsensitivePaths && fs.existsSync(file) && path.basename(canonicalPath(file)) !== path.basename(file)) fs.rmSync(file)
    fs.writeFileSync(file, content)
}

function removeEmptyParents(dir, root) {
    while (isInside(root, dir)) {
        try {
            if (fs.readdirSync(dir).length > 0) return
            fs.rmdirSync(dir)
        } catch {
            return
        }
        dir = path.dirname(dir)
    }
}

function cleanDist() {
    const root = path.resolve(distDirName())
    const kept = new Set([...written, ...compiled].map(pathKey))

    for (const file of cache.outputs) {
        const full = path.resolve(file)
        if (kept.has(pathKey(full)) || !isInside(root, full)) continue
        if (!/\.(js|mjs|d\.ts|map)$/.test(full) || !fs.existsSync(full)) continue
        try {
            fs.rmSync(full)
        } catch {
            continue
        }
        debug(`Cleaned: ${shown(full)}`)
        removeEmptyParents(path.dirname(full), root)
    }
}

function writeClientManifest(clients) {
    const root = path.resolve(distDirName())
    const seen = new Set()
    const stack = [...clients]
    while (stack.length > 0) {
        const source = stack.pop()
        if (seen.has(source)) continue
        seen.add(source)
        stack.push(...(graph.get(source) ?? []))
    }

    const relative = file => isInside(root, file) ? path.relative(root, file).split(path.sep).join("/") : null
    const outputOf = source => nextCache.files[source]?.output ?? getDistPath(source)

    const files = new Set()
    for (const source of seen) {
        const entry = nextCache.files[source]
        for (const file of entry?.written ?? [outputOf(source)]) {
            if (file.endsWith(".d.ts") || relative(file) === null) continue
            files.add(relative(file))
        }
    }

    const modules = {}
    for (const [source, deps] of [...graph].sort(([a], [b]) => a.localeCompare(b))) {
        const name = relative(outputOf(source))
        if (name === null) continue
        modules[name] = [...new Set(deps.map(dep => relative(outputOf(dep))).filter(dep => dep !== null))].sort()
    }

    const target = path.resolve(root, CLIENTS_MANIFEST)
    const temporary = `${target}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify({ files: [...files].sort(), graph: modules }, null, 2) + "\n")
    try {
        fs.renameSync(temporary, target)
    } catch (error) {
        fs.rmSync(temporary, { force: true })
        throw error
    }
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

export function build() {
    let data

    try {
        data = readJson("slimconfig.json")
    } catch (error) {
        console.error("Error reading or parsing slimconfig.json:", error.message)
        return false
    }

    resetPathCaches()
    compiled.clear()
    compiling.length = 0
    graph.clear()
    owners.clear()
    changedTypes.clear()
    reused = 0

    const uses = data.uses && typeof data.uses === "object" ? data.uses : null
    usePackages = uses ? uses.enabled !== false : data.usePackages !== false
    useStyle = uses
        ? (typeof uses.style === "string" ? uses.style : "import")
        : (typeof data.uses === "string" ? data.uses : "import")
    jsdoc = data.jsdoc === true
    declarations = data.declarations === true
    check = data.check !== false && process.env.SLIM_NO_CHECK !== "1"
    warnings = data.warnings !== false
    sourceMaps = data.sourceMaps === false || data.sourceMaps === "none" ? false : data.sourceMaps === "file" ? "file" : "inline"
    release = data.release === true || process.env.SLIM_RELEASE === "1"
    globals = Array.isArray(data.globals) ? data.globals.filter(name => typeof name === "string") : []
    host = typeof data.host === "string" ? canonicalPath(data.host.endsWith(".slim") ? data.host : `${data.host}.slim`) : null
    runtime = data.runtime === "imports" ? "imports" : "globals"
    environment = data.env === "embedded" ? "embedded" : null
    autoImport = data.autoImport === true
        ? projectExports(path.resolve(typeof data.watch === "string" ? data.watch : "."), { skip: [path.resolve(distDirName()), projectPackagesDir()] })
        : null

    if (!("main" in data)) return true

    let loaded = false
    try {
        checkDist()
        syncExternal()
        loadCache(compilerFingerprint(data))
        loaded = true
        const entry = data.main.endsWith(".slim") ? data.main : `${data.main}.slim`
        setOutputPath(entry, path.resolve(distDirName(), `${data.main}.js`))
        compileFile(entry)
        const clients = []
        for (const client of Array.isArray(data.clients) ? data.clients : []) {
            if (typeof client !== "string" || !client.trim()) continue
            const clientFile = canonicalPath(client.endsWith(".slim") ? client : `${client}.slim`)
            compileFile(clientFile)
            clients.push(clientFile)
        }
        cleanDist()
        writeClientManifest(clients)
        saveCache(true)
        if (reused > 0) debug(`Up to date: ${reused} of ${compiled.size} files`)
        if (jsdoc) writeJsConfig()
        return true
    } catch (error) {
        if (loaded) {
            try {
                saveCache(false)
            } catch {
            }
        }
        console.error(`\n${error.slimTypeErrors || error.slimSyntaxError || error instanceof BuildFailure ? error.message : error}\n`)
        return false
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await import("./handlers/errorHandler.js")
    if (!build()) process.exit(1)
}
