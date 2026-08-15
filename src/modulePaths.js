import fs from "node:fs"
import path from "node:path"

const slimExtension = ".slim"

function isWithin(parent, target) {
    const relative = path.relative(parent, target)
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
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
    if (raw.startsWith("@slim/")) {
        const libraryRoot = path.resolve("packages/slim")
        const libraryName = raw.slice("@slim/".length)
        const fileSource = path.resolve(libraryRoot, libraryName + slimExtension)

        if (fs.existsSync(fileSource)) return fileSource

        const directorySource = path.resolve(libraryRoot, libraryName, "main.slim")
        if (fs.existsSync(directorySource)) return directorySource

        return fileSource
    }

    if (raw.endsWith(".js")) return null

    return path.resolve(path.dirname(fromFile), raw + slimExtension)
}

export function resolveSlimImport(raw, fromFile) {
    if (raw.endsWith(".js")) return raw

    const slimSource = resolveSlimSource(raw, fromFile)
    const distTarget = getDistPath(slimSource)
    const distFrom = getDistPath(fromFile)
    const relative = path.relative(path.dirname(distFrom), distTarget).replace(/\\/g, "/")

    return relative.startsWith(".") ? relative : "./" + relative
}
