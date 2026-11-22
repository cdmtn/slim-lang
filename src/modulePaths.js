import fs from "node:fs"
import path from "node:path"
import { isBuiltin } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

const slimExtension = ".slim"

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

export function readJson(file) {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""))
}

let rootOverride = null

export function projectRoot() {
    return rootOverride ?? process.cwd()
}

export function setProjectRoot(dir) {
    rootOverride = dir ? path.resolve(dir) : null
    resetPathCaches()
}

export function readConfig() {
    try {
        return readJson(path.join(projectRoot(), "slimconfig.json"))
    } catch {
        return {}
    }
}

function configName(key, fallback) {
    const config = readConfig()
    const names = config.names && typeof config.names === "object" ? config.names : {}
    const value = names[key] ?? config[key]
    return typeof value === "string" && value.trim() ? value : fallback
}

let projectPackagesCache = null
export function projectPackagesDir() {
    if (projectPackagesCache) return projectPackagesCache

    projectPackagesCache = path.resolve(projectRoot(), configName("packages", "packages"))
    return projectPackagesCache
}

let distDirCache = null
export function distDirName() {
    if (distDirCache) return distDirCache

    distDirCache = configName("dist", "slim-dist")
    return distDirCache
}

export function distDir() {
    return path.resolve(projectRoot(), distDirName())
}

export const caseInsensitivePaths = process.platform === "win32" || process.platform === "darwin"
const canonicalCache = new Map()

export function pathKey(file) {
    const abs = path.resolve(file)
    return caseInsensitivePaths ? abs.toLowerCase() : abs
}

function nativeCase(abs) {
    const lower = abs.toLowerCase()
    const base = [projectRoot(), PACKAGE_ROOT].find(dir => lower.startsWith(dir.toLowerCase() + path.sep)) ?? path.parse(abs).root
    let current = base
    for (const part of abs.slice(base.length).split(path.sep).filter(Boolean)) {
        let next = part
        try {
            const entries = fs.readdirSync(current)
            if (!entries.includes(part)) next = entries.find(entry => entry.toLowerCase() === part.toLowerCase()) ?? part
        } catch {
        }
        current = path.join(current, next)
    }
    return current
}

export function canonicalPath(file) {
    const abs = path.resolve(file)
    if (!caseInsensitivePaths) return abs
    const cached = canonicalCache.get(abs)
    if (cached) return cached
    if (!fs.existsSync(abs)) return abs
    const result = nativeCase(abs)
    canonicalCache.set(abs, result)
    return result
}

export function resetPathCaches() {
    distDirCache = null
    projectPackagesCache = null
    canonicalCache.clear()
}

export const CORE_MODULES = path.join(PACKAGE_ROOT, "src", "lib")

export function isCoreImport(raw) {
    return raw === "@slim" || raw.startsWith("@slim/")
}

function isWithin(parent, target) {
    const relative = path.relative(parent, target)
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function bareName(raw) {
    const segments = raw.split("/")
    return raw.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]
}

function isNodeModule(raw) {
    if (raw.startsWith(".") || path.isAbsolute(raw)) return false
    return fs.existsSync(path.resolve(projectRoot(), "node_modules", bareName(raw)))
}

const outputOverrides = new Map()
let outputRoot = null

export function setOutputPath(slimFile, outFile) {
    outputOverrides.set(canonicalPath(slimFile), path.resolve(outFile))
}

export function setOutputRoot(dir) {
    outputRoot = dir ? path.resolve(dir) : null
}

export function getDistPath(slimFile) {
    const abs = canonicalPath(slimFile)
    if (outputOverrides.has(abs)) {
        const override = outputOverrides.get(abs)
        return outputRoot ? path.resolve(outputRoot, path.relative(distDir(), override)) : override
    }

    const root = projectRoot()
    const srcRoot = path.resolve(root, "src")
    const projectPackages = projectPackagesDir()

    let relative

    if (isWithin(CORE_MODULES, abs)) {
        relative = path.join("@slim", path.relative(CORE_MODULES, abs))
    } else if (isWithin(projectPackages, abs)) {
        relative = path.join(path.basename(projectPackages), path.relative(projectPackages, abs))
    } else if (isWithin(srcRoot, abs)) {
        relative = path.relative(srcRoot, abs)
    } else if (isWithin(root, abs)) {
        relative = path.relative(root, abs)
    } else {
        const outside = path.relative(root, abs)
        const stripped = (path.isAbsolute(outside) ? path.relative(path.parse(abs).root, abs) : outside).split(path.sep).filter(seg => seg && seg !== "..")
        relative = stripped.length ? path.join(...stripped) : path.basename(abs)
    }

    return path.resolve(outputRoot ?? distDir(), relative.replace(/\.slim$/, ".js"))
}

export function resolveSlimSource(raw, fromFile) {
    if (isBuiltin(raw)) return null

    if (isCoreImport(raw)) return canonicalPath(path.join(CORE_MODULES, raw.slice("@slim/".length) + slimExtension))

    if (raw.startsWith("@")) {
        const packageName = raw.slice("@".length)
        const packagesRoot = projectPackagesDir()

        const fileSource = path.join(packagesRoot, packageName + slimExtension)
        if (fs.existsSync(fileSource)) return canonicalPath(fileSource)

        const directorySource = path.join(packagesRoot, packageName, "main.slim")
        if (fs.existsSync(directorySource)) return canonicalPath(directorySource)

        if (isNodeModule(raw)) return null

        return fileSource
    }

    if (raw.endsWith(".js")) return null

    const localSource = path.resolve(path.dirname(fromFile), raw + slimExtension)
    if (fs.existsSync(localSource)) return canonicalPath(localSource)

    if (isNodeModule(raw)) return null

    return localSource
}

export function resolveSlimImport(raw, fromFile, distFrom = getDistPath(fromFile)) {
    if (raw.endsWith(".js")) return raw

    const slimSource = resolveSlimSource(raw, fromFile)
    if (slimSource === null) return raw

    const distTarget = getDistPath(slimSource)
    const relative = path.relative(path.dirname(distFrom), distTarget).replace(/\\/g, "/")
    if (path.isAbsolute(relative)) return pathToFileURL(distTarget).href

    return relative.startsWith("./") || relative.startsWith("../") ? relative : "./" + relative
}
