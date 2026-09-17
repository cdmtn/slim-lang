import fs from "node:fs"
import path from "node:path"
import { isBuiltin } from "node:module"
import { fileURLToPath } from "node:url"

const slimExtension = ".slim"

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function readConfig() {
    try {
        return JSON.parse(fs.readFileSync(path.join(process.cwd(), "slimconfig.json"), "utf8"))
    } catch {
        return {}
    }
}

let projectPackagesCache = null
export function projectPackagesDir() {
    if (projectPackagesCache) return projectPackagesCache

    const dir = readConfig().packages
    projectPackagesCache = path.resolve(typeof dir === "string" && dir.trim() ? dir : "packages")
    return projectPackagesCache
}

let distDirCache = null
export function distDirName() {
    if (distDirCache) return distDirCache

    const dir = readConfig().dist
    distDirCache = typeof dir === "string" && dir.trim() ? dir : "slim-dist"
    return distDirCache
}

function packageRoots() {
    const projectPackages = projectPackagesDir()
    const shippedPackages = path.join(PACKAGE_ROOT, "packages")

    return projectPackages === shippedPackages
        ? [projectPackages]
        : [projectPackages, shippedPackages]
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
    return fs.existsSync(path.resolve("node_modules", bareName(raw)))
}

export function getDistPath(slimFile) {
    const abs = path.resolve(slimFile)
    const srcRoot = path.resolve("src")
    const projectRoot = path.resolve(".")
    const shippedPackages = path.join(PACKAGE_ROOT, "packages")
    const projectPackages = projectPackagesDir()

    let relative

    if (isWithin(shippedPackages, abs)) {
        relative = path.join("packages", path.relative(shippedPackages, abs))
    } else if (isWithin(projectPackages, abs)) {
        relative = path.join(path.basename(projectPackages), path.relative(projectPackages, abs))
    } else if (isWithin(srcRoot, abs)) {
        relative = path.relative(srcRoot, abs)
    } else if (isWithin(projectRoot, abs)) {
        relative = path.relative(projectRoot, abs)
    } else {
        // Drop leading "../" so out-of-project sources can't escape the dist dir.
        const stripped = path.relative(projectRoot, abs).split(path.sep).filter(seg => seg !== "..")
        relative = stripped.length ? path.join(...stripped) : path.basename(abs)
    }

    return path.resolve(distDirName(), relative.replace(/\.slim$/, ".js"))
}

export function resolveSlimSource(raw, fromFile) {
    if (isBuiltin(raw)) return null

    if (raw.startsWith("@")) {
        const packageName = raw.slice("@".length)
        const roots = packageRoots()

        for (const packagesRoot of roots) {
            const fileSource = path.join(packagesRoot, packageName + slimExtension)
            if (fs.existsSync(fileSource)) return fileSource

            const directorySource = path.join(packagesRoot, packageName, "main.slim")
            if (fs.existsSync(directorySource)) return directorySource
        }

        if (isNodeModule(raw)) return null

        return path.join(roots[0], packageName + slimExtension)
    }

    if (raw.endsWith(".js")) return null

    const localSource = path.resolve(path.dirname(fromFile), raw + slimExtension)
    if (fs.existsSync(localSource)) return localSource

    if (isNodeModule(raw)) return null

    return localSource
}

export function resolveSlimImport(raw, fromFile) {
    if (raw.endsWith(".js")) return raw

    const slimSource = resolveSlimSource(raw, fromFile)
    if (slimSource === null) return raw

    const distTarget = getDistPath(slimSource)
    const distFrom = getDistPath(fromFile)
    const relative = path.relative(path.dirname(distFrom), distTarget).replace(/\\/g, "/")

    return relative.startsWith(".") ? relative : "./" + relative
}
