import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { transform } from "./transform.js"
import { exportModuleTypes } from "./checker.js"
import { projectExports } from "./autoImport.js"
import { CORE_MODULES, PACKAGE_ROOT, distDir, getDistPath, pathKey, projectPackagesDir, projectRoot, resolveSlimSource, setProjectRoot } from "./modulePaths.js"

export const runtimeDir = path.join(PACKAGE_ROOT, "src", "external")

const IMPORT_SOURCE = /\b(?:from|use|import)\s*(?:["']([^"'\n]+)["']|(@[^\s;"'(){}]+))/g

function isInside(parent, target) {
    const relative = path.relative(parent, target)
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function collectFiles(dir, skip, seen, out) {
    let real
    try {
        real = pathKey(fs.realpathSync(dir))
    } catch {
        return out
    }
    if (seen.has(real)) return out
    seen.add(real)
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        const folder = entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(full, { throwIfNoEntry: false })?.isDirectory())
        if (folder) {
            if (!entry.name.startsWith(".") && entry.name !== "node_modules" && !skip.has(pathKey(full))) collectFiles(full, skip, seen, out)
        } else if (entry.name.endsWith(".slim")) {
            out.push(full)
        }
    }
    return out
}

export function slimFiles(dir = projectRoot()) {
    return collectFiles(path.resolve(projectRoot(), dir), new Set([pathKey(distDir())]), new Set(), [])
}

function settingsOf({ root = process.cwd(), files = null, host = null, release = false, globals = [], autoImport = false, check = true, passes = 8, env = null } = {}) {
    const base = path.resolve(root)
    return {
        root: base,
        files,
        host: host ? path.resolve(base, host.endsWith(".slim") ? host : host + ".slim") : null,
        release,
        globals,
        autoImport,
        check,
        env,
        passes: Math.max(1, Math.floor(passes))
    }
}

function enter(settings) {
    if (projectRoot() !== settings.root) setProjectRoot(settings.root)
}

function listFiles(settings) {
    const listed = typeof settings.files === "function" ? settings.files() : settings.files ?? slimFiles()
    return [...new Map(listed.map(file => path.resolve(settings.root, file)).map(file => [pathKey(file), file])).values()]
}

function exportsIndex(settings) {
    if (!settings.autoImport) return null
    const folders = settings.autoImport === true ? [settings.root] : [settings.autoImport].flat().map(folder => path.resolve(settings.root, folder))
    return projectExports(folders, { skip: [distDir(), projectPackagesDir()] })
}

function autoImportFor(index, file) {
    if (!index) return null
    if (isInside(projectPackagesDir(), file) || file.split(path.sep).includes("node_modules")) return null
    return index
}

function importGraph(files, sources) {
    const known = new Map(files.map(file => [pathKey(file), file]))
    return new Map(files.map(file => {
        const found = []
        for (const [, quoted, bare] of (sources.get(file) ?? "").matchAll(IMPORT_SOURCE)) {
            let target = null
            try {
                target = resolveSlimSource((quoted ?? bare).replace(/\.js$/, ""), file)
            } catch {
                target = null
            }
            const match = target && known.get(pathKey(target))
            if (match && !found.includes(match)) found.push(match)
        }
        return [file, found]
    }))
}

function orderByImports(files, graph) {
    const ordered = []
    const seen = new Set()
    const visit = file => {
        const key = pathKey(file)
        if (seen.has(key)) return
        seen.add(key)
        for (const dependency of graph.get(file) ?? []) visit(dependency)
        ordered.push(file)
    }
    for (const file of files) visit(file)
    return ordered
}

function largestCycle(files, graph) {
    let index = 0
    let largest = 0
    const indexOf = new Map()
    const low = new Map()
    const stack = []
    const onStack = new Set()
    const connect = file => {
        indexOf.set(file, index)
        low.set(file, index)
        index++
        stack.push(file)
        onStack.add(file)
        for (const next of graph.get(file) ?? []) {
            if (!indexOf.has(next)) {
                connect(next)
                low.set(file, Math.min(low.get(file), low.get(next)))
            } else if (onStack.has(next)) {
                low.set(file, Math.min(low.get(file), indexOf.get(next)))
            }
        }
        if (low.get(file) !== indexOf.get(file)) return
        let size = 0
        let member
        do {
            member = stack.pop()
            onStack.delete(member)
            size++
        } while (member !== file)
        if (size > 1 || (graph.get(file) ?? []).includes(file)) largest = Math.max(largest, size)
    }
    for (const file of files) if (!indexOf.has(file)) connect(file)
    return largest
}

function checkFiles(settings, files, sources, index) {
    const graph = importGraph(files, sources)
    const ordered = orderByImports(files, graph)
    const cycle = largestCycle(files, graph)
    const failed = new Map()
    const records = new Map()
    const seen = new Map()
    const imports = file => graph.get(file) ?? []
    const stale = file => failed.has(file) || imports(file).some((dependency, at) => seen.get(file)?.[at] !== records.get(dependency))
    let reader = exportModuleTypes
    let previous = null
    let stable = 0
    for (let pass = 0; pass < settings.passes; pass++) {
        let changed = false
        for (const file of ordered) {
            if (reader && pass >= 2 && !stale(file)) continue
            const before = [records.get(file), failed.get(file)]
            try {
                transform(sources.get(file), file, {
                    host: settings.host, globals: settings.globals, autoImport: autoImportFor(index, file), env: settings.env,
                    warnings: false, sourceMaps: false, test: file.endsWith(".test.slim")
                })
                failed.delete(file)
            } catch (error) {
                failed.set(file, error.message)
            }
            if (reader) records.set(file, reader(file) ?? "")
            seen.set(file, imports(file).map(dependency => records.get(dependency)))
            if (before[0] !== records.get(file) || before[1] !== failed.get(file)) changed = true
        }
        if (reader && pass === 0 && [...records.values()].every(record => record === "")) {
            reader = null
            records.clear()
        }
        if (reader) {
            if (pass >= 1 && !changed) break
            continue
        }
        const signature = JSON.stringify(ordered.map(file => failed.get(file) ?? null))
        stable = signature === previous ? stable + 1 : 0
        previous = signature
        if (stable >= (cycle === 0 ? 1 : cycle + 1)) break
    }
    return ordered.filter(file => failed.has(file)).map(file => failed.get(file))
}

function checker(settings) {
    let last = null
    return () => {
        enter(settings)
        const files = listFiles(settings)
        const all = settings.host && !files.some(file => pathKey(file) === pathKey(settings.host)) ? [settings.host, ...files] : files
        const sources = new Map(all.map(file => [file, fs.readFileSync(file, "utf8")]))
        const index = exportsIndex(settings)
        const hash = createHash("sha1")
        for (const [file, code] of sources) hash.update(`${file}\0${code}\0`)
        hash.update(JSON.stringify(index ? [...index] : null))
        const signature = hash.digest("hex")
        if (last?.signature === signature) return { errors: last.errors, index }
        const errors = checkFiles(settings, all, sources, index)
        last = { signature, errors }
        return { errors, index }
    }
}

export function check(options = {}) {
    return checker(settingsOf(options))().errors
}

function sourceCandidates(target) {
    const relative = path.relative(distDir(), target).replace(/\.js$/, ".slim")
    if (relative.startsWith("..") || path.isAbsolute(relative)) return []
    const root = projectRoot()
    const parts = relative.split(path.sep)
    const packages = projectPackagesDir()
    const candidates = [path.join(root, "src", relative), path.join(root, relative)]
    if (parts[0] === "@slim") candidates.unshift(path.join(CORE_MODULES, ...parts.slice(1)))
    if (parts[0] === path.basename(packages)) candidates.unshift(path.join(packages, ...parts.slice(1)))
    return candidates
}

export function slim(options = {}) {
    const settings = settingsOf(options)
    const runCheck = checker(settings)
    let index = null
    let byDist = null

    const distTargets = () => {
        if (!byDist) byDist = new Map(listFiles(settings).map(file => [pathKey(getDistPath(file)), file]))
        return byDist
    }

    const sourceOf = (importer, request) => {
        const target = path.resolve(path.dirname(getDistPath(importer)), request)
        for (const candidate of sourceCandidates(target)) {
            if (fs.existsSync(candidate) && pathKey(getDistPath(candidate)) === pathKey(target)) return candidate
        }
        const listed = distTargets().get(pathKey(target))
        if (listed) return listed
        const direct = path.resolve(path.dirname(importer), request).replace(/\.js$/, ".slim")
        return fs.existsSync(direct) ? direct : null
    }

    return {
        name: "slim",
        setup(build) {
            build.onStart(() => {
                enter(settings)
                byDist = null
                if (!settings.check) {
                    index = exportsIndex(settings)
                    return
                }
                const result = runCheck()
                index = result.index
                return { errors: result.errors.map(text => ({ text })) }
            })

            build.onResolve({ filter: /external\/runtime-(?:core|dom)\.js$/ }, args => ({
                path: path.join(runtimeDir, args.path.slice(args.path.lastIndexOf("/") + 1)),
                sideEffects: false
            }))

            build.onResolve({ filter: /^\.\.?\/.*\.js$/ }, args => {
                if (!args.importer.endsWith(".slim")) return undefined
                enter(settings)
                const source = sourceOf(args.importer, args.path)
                return source ? { path: source } : undefined
            })

            build.onLoad({ filter: /\.slim$/ }, args => {
                enter(settings)
                try {
                    const { code } = transform(fs.readFileSync(args.path, "utf8"), args.path, {
                        host: settings.host, globals: settings.globals, autoImport: autoImportFor(index, args.path),
                        check: false, release: settings.release, runtime: "imports"
                    })
                    return { contents: code, loader: "js", resolveDir: path.dirname(args.path), watchFiles: settings.host ? [settings.host] : [] }
                } catch (error) {
                    return { errors: [{ text: error.message }] }
                }
            })
        }
    }
}
