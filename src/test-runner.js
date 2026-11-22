import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { transform } from "./transform.js"
import { findUses } from "./syntax/index.js"
import { caseInsensitivePaths, distDirName, getDistPath, PACKAGE_ROOT, projectPackagesDir, readJson, resolveSlimSource, setOutputRoot } from "./modulePaths.js"
import { collectCoverage, formatCoverage } from "./coverage.js"

const root = process.cwd()
const runtimeFiles = ["defaults.js", "core.js", "runtime-dom.js", "runtime-core.js", "router.js"]
const testing = pathToFileURL(path.join(PACKAGE_ROOT, "src", "external", "testing.js")).href

function findTests(target) {
    if (target) {
        const file = target.endsWith(".slim") ? target : target + ".slim"
        return [path.resolve(file)]
    }

    const results = []
    const same = (a, b) => caseInsensitivePaths ? a.toLowerCase() === b.toLowerCase() : a === b
    const packages = projectPackagesDir()
    const walk = dir => {
        if (!fs.existsSync(dir)) return
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                const child = path.join(dir, entry.name)
                if (entry.name !== "node_modules" && entry.name !== distDirName() && !entry.name.startsWith(".") && !same(child, packages)) {
                    walk(child)
                }
            } else if (entry.name.endsWith(".test.slim")) {
                results.push(path.join(dir, entry.name))
            }
        }
    }
    walk(root)
    return results
}

function withRuntime(code, outFile) {
    let result = code
    for (const name of runtimeFiles) {
        const relative = path.relative(path.dirname(outFile), path.resolve(distDirName(), "external", name)).replace(/\\/g, "/")
        const specifier = relative.startsWith(".") ? relative : `./${relative}`
        const runtime = pathToFileURL(path.join(PACKAGE_ROOT, "src", "external", name)).href
        result = result.split(JSON.stringify(specifier)).join(JSON.stringify(runtime))
    }
    return result
}

function projectOptions() {
    let config = {}
    try {
        config = readJson("slimconfig.json")
    } catch {
        return {}
    }
    const uses = config.uses && typeof config.uses === "object" ? config.uses : null
    return {
        uses: uses ? (typeof uses.style === "string" ? uses.style : "import") : (typeof config.uses === "string" ? config.uses : "import"),
        globals: Array.isArray(config.globals) ? config.globals.filter(name => typeof name === "string") : [],
        host: typeof config.host === "string" ? path.resolve(config.host.endsWith(".slim") ? config.host : `${config.host}.slim`) : null,
        check: config.check !== false
    }
}

function buildDependencies(file, settings, built, stack = []) {
    const dependencies = findUses(fs.readFileSync(file, "utf8")).map(use => resolveSlimSource(use.source, file))
    if (settings.host && file !== settings.host) dependencies.unshift(settings.host)
    for (const dependency of dependencies) {
        if (!dependency || built.has(dependency) || stack.includes(dependency) || !fs.existsSync(dependency)) continue
        buildDependencies(dependency, settings, built, [...stack, file])
        built.add(dependency)
        const outFile = getDistPath(dependency)
        const { code } = transform(fs.readFileSync(dependency, "utf8"), dependency, { ...settings, outFile })
        fs.mkdirSync(path.dirname(outFile), { recursive: true })
        fs.writeFileSync(outFile, withRuntime(code, outFile))
    }
}

export function runTests(target, options = {}) {
    const files = findTests(target)

    if (files.length === 0) {
        console.log("No test files found (*.test.slim)")
        return 0
    }

    const outDir = fs.mkdtempSync(path.join(root, ".slim-tests-"))
    setOutputRoot(outDir)
    try {
        return runFiles(files, outDir, options)
    } finally {
        setOutputRoot(null)
        fs.rmSync(outDir, { recursive: true, force: true })
    }
}

function runFiles(files, outDir, options) {
    let failed = 0
    const settings = projectOptions()
    const built = new Set()
    const coverageDir = options.coverage ? path.join(outDir, "__coverage__") : null
    const env = { ...process.env }
    if (options.filter) env.SLIM_TEST_FILTER = options.filter
    if (coverageDir) env.NODE_V8_COVERAGE = coverageDir

    for (const file of files) {
        const outFile = getDistPath(file).replace(/\.js$/, ".mjs")
        let code
        try {
            buildDependencies(file, settings, built)
            code = transform(fs.readFileSync(file, "utf8"), file, { ...settings, test: true, outFile }).code
        } catch (error) {
            console.log(`
${path.relative(root, file)}
${error.slimTypeErrors || error.slimSyntaxError ? error.message : error}`)
            failed++
            continue
        }
        fs.mkdirSync(path.dirname(outFile), { recursive: true })
        fs.writeFileSync(outFile, `import ${JSON.stringify(testing)};\n${withRuntime(code, outFile)}`)

        console.log(`\n${path.relative(root, file)}`)
        const result = spawnSync(process.execPath, ["--enable-source-maps", "--no-warnings", outFile], {
            stdio: "inherit",
            env
        })
        if (result.status !== 0) failed++
    }

    if (coverageDir) {
        const tests = new Set(files.map(file => path.resolve(file)))
        const coverage = collectCoverage(coverageDir, { include: file => !tests.has(file) && !file.endsWith(".test.slim") })
        console.log(`
${formatCoverage(coverage, root)}`)
    }

    return failed > 0 ? 1 : 0
}
