// Case catalog: metadata only. Case bodies are imported lazily by the worker,
// so --list is instant and never loads the compiler or runtime.
import { compilerCases } from "./suites/compiler.js"
import { runtimeCases } from "./suites/runtime.js"
import { exampleCases } from "./suites/examples.js"
import { sizesFor } from "./options.js"

export const allCases = () => [...compilerCases, ...runtimeCases, ...exampleCases()]

// Expand selected cases into rows: {name, suite, size, mode, unsupported?}.
export function planRows(options) {
    const rows = []
    const wanted = options.filter.map(f => f.toLowerCase())
    for (const def of allCases()) {
        if (!options.suites.includes(def.suite)) continue
        if (wanted.length && !wanted.some(f => def.name.toLowerCase().includes(f))) continue
        const sizes = def.sizeKind ? sizesFor(options, def.sizeKind) : [null]
        for (const size of sizes) {
            if (def.unsupported) {
                rows.push({ name: def.name, suite: def.suite, size, mode: "dev", unsupported: def.unsupported })
                continue
            }
            for (const mode of def.modes ?? ["dev"]) {
                if (options.modes.includes(mode)) rows.push({ name: def.name, suite: def.suite, size, mode })
            }
        }
    }
    // A suite where no case supports release (compiler stages are dev only)
    // reports it once, as an unsupported row, instead of repeating it per case.
    if (options.modes.includes("release")) {
        for (const suite of options.suites) {
            const catalog = allCases().filter(c => c.suite === suite && !c.unsupported)
            const supported = catalog.some(c => (c.modes ?? ["dev"]).includes("release"))
            if (!supported && rows.some(r => r.suite === suite)) {
                rows.push({
                    name: `${suite}.*`, suite, size: null, mode: "release",
                    unsupported: "compiler stages are measured in dev only; release changes the emitted code, not the compiler"
                })
            }
        }
    }
    return rows
}

export const rowKey = r => `${r.case ?? r.name}@${r.size ?? "-"}:${r.mode}`
export const findCase = name => allCases().find(c => c.name === name)
