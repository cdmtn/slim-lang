// Compiler suite catalog: stages are measured separately, then whole-file shapes.
// Bodies live in bench/cases/stages.js and bench/cases/shapes.js.
const stage = (name, extra = {}) => ({ name: `compiler.${name}`, suite: "compiler", area: "stages", sizeKind: "decls", ...extra })
const shape = (name, extra = {}) => ({ name: `compiler.${name}`, suite: "compiler", area: "shapes", ...extra })

export const compilerCases = [
    stage("lexer"),
    stage("preprocess"),
    stage("parse"),
    stage("check"),
    stage("check-errors"),
    stage("generate"),
    stage("sourcemap"),
    stage("transform"),
    stage("transform-check"),
    stage("format"),
    shape("deep-nesting"),
    shape("many-types"),
    shape("module-graph", { sizeKind: "files" }),
    shape("cold-first-call", { budgetFactor: 4 }),
    {
        name: "compiler.sourcemap-remap", suite: "compiler",
        unsupported: "remapping and buildPreMap are internal to transform(); not separable without changing src"
    },
    {
        name: "compiler.build-cache", suite: "compiler",
        unsupported: "slmc rebuilds every file; there is no build cache to measure warm vs cold"
    }
]
