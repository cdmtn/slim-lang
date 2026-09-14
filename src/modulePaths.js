import fs from "node:fs"
import path from "node:path"
import { isBuiltin } from "node:module"

const slimExtension = ".slim"

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
    const relative = isWithin(srcRoot, abs)
        ? path.relative(srcRoot, abs)
        : path.relative(projectRoot, abs)

    return path.resolve("dist", relative.replace(/\.slim$/, ".js"))
}

export function resolveSlimSource(raw, fromFile) {
    // Node builtins (e.g. "node:crypto", "fs", "path") are not Slim sources;
    // leave them for the JS import to resolve untouched.
    if (isBuiltin(raw)) return null

    if (raw.startsWith("@")) {
        const packagesRoot = path.resolve("packages")
        const packageName = raw.slice("@".length)
        const fileSource = path.resolve(packagesRoot, packageName + slimExtension)

        if (fs.existsSync(fileSource)) return fileSource

        const directorySource = path.resolve(packagesRoot, packageName, "main.slim")
        if (fs.existsSync(directorySource)) return directorySource

        if (isNodeModule(raw)) return null

        return fileSource
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
