// On-disk cache for incremental builds. It lives in the output directory next to the files
// it describes, so deleting the output directory is always a full reset.
//
// A module is reused only when its *key* is unchanged. The key covers the module's own
// content, how each `use` resolved, and the keys of everything it uses, so editing a module
// invalidates exactly that module and its transitive dependents.

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { PACKAGE_ROOT } from "./modulePaths.js"

export const CACHE_FILE = ".slim-build-cache.json"
const CACHE_FORMAT = 1

const require = createRequire(import.meta.url)

export function hash(...parts) {
    const digest = crypto.createHash("sha256")
    for (const part of parts) {
        digest.update(String(part.length))
        digest.update(":")
        digest.update(part)
    }
    return digest.digest("hex")
}

function walk(dir, files = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full, files)
        else if (entry.name.endsWith(".js")) files.push(full)
    }
    return files
}

function dependencyVersion(name) {
    try {
        return require(`${name}/package.json`).version
    } catch {
        return "unknown"
    }
}

// Everything that can change what the compiler emits for the same source text.
export function compilerFingerprint(options, version) {
    const sources = []
    for (const entry of fs.readdirSync(path.join(PACKAGE_ROOT, "src"), { withFileTypes: true })) {
        // bin/ is the CLI and external/ is the runtime copied verbatim; neither shapes transform output.
        if (entry.isDirectory() && entry.name !== "handlers") continue
        const full = path.join(PACKAGE_ROOT, "src", entry.name)
        if (entry.isDirectory()) sources.push(...walk(full))
        else if (entry.name.endsWith(".js")) sources.push(full)
    }

    const compilerHash = hash(...sources.sort().flatMap(file => [path.relative(PACKAGE_ROOT, file), fs.readFileSync(file)]))

    return hash(
        String(CACHE_FORMAT),
        version,
        compilerHash,
        ...["@babel/parser", "@babel/traverse", "@babel/generator", "@babel/types",
            "@jridgewell/gen-mapping", "@jridgewell/remapping"].map(dependencyVersion),
        JSON.stringify(options)
    )
}

export function fileHash(file) {
    try {
        return hash(fs.readFileSync(file))
    } catch {
        return null
    }
}

export class BuildCache {
    constructor(dir, fingerprint, enabled = true) {
        this.file = path.join(dir, CACHE_FILE)
        this.fingerprint = fingerprint
        this.enabled = enabled
        this.previous = new Map()
        this.modules = new Map()

        if (!enabled) return

        try {
            const data = JSON.parse(fs.readFileSync(this.file, "utf8"))
            if (data.format === CACHE_FORMAT && data.fingerprint === fingerprint) {
                this.previous = new Map(Object.entries(data.modules))
            }
        } catch {
            // Missing or unreadable cache is just a cold build.
        }
    }

    pruneDeleted() {
        const dir = path.dirname(this.file)
        for (const [source, entry] of this.previous) {
            if (fs.existsSync(source)) continue
            for (const file of [entry.output, entry.declarations]) {
                if (!file) continue
                const relative = path.relative(dir, file)
                if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
                    fs.rmSync(file, { force: true })
                }
            }
            this.previous.delete(source)
        }
    }

    // A previous entry is usable only if its key matches and the files it produced are intact.
    lookup(file, key) {
        const entry = this.previous.get(file)
        if (!entry || entry.key !== key) return null

        if (fileHash(entry.output) !== entry.outputHash) return null
        if (entry.declarations && fileHash(entry.declarations) !== entry.declarationsHash) return null
        return entry
    }

    store(file, entry) {
        this.modules.set(file, entry)
    }

    save() {
        if (!this.enabled) return

        const modules = {}
        for (const file of [...this.modules.keys()].sort()) modules[file] = this.modules.get(file)

        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        const temp = `${this.file}.${process.pid}.tmp`
        fs.writeFileSync(temp, JSON.stringify({ format: CACHE_FORMAT, fingerprint: this.fingerprint, modules }, null, 1))
        fs.renameSync(temp, this.file)
    }
}
