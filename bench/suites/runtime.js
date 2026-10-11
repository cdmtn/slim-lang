// Runtime suite catalog. Every case runs in dev and with SLIM_RELEASE=1 (separate
// processes, because core.js reads the flag once at load).
const both = ["dev", "release"]
const rt = (name, area, extra = {}) => ({ name: `runtime.${name}`, suite: "runtime", area, modes: both, ...extra })

const structs = []
for (const shape of ["flat", "nested", "array"]) {
    for (const op of ["verify", "verifySafe", "new"]) {
        for (const path of ["ok", "fail"]) {
            structs.push(rt(`struct.${shape}.${op}.${path}`, "structs", { sizeKind: "items" }))
        }
    }
}

export const runtimeCases = [
    ...structs,
    rt("typed.let-int", "typed", { sizeKind: "items" }),
    rt("typed.let-plain", "typed", { sizeKind: "items" }),
    rt("typed.let-array", "typed", { sizeKind: "items" }),
    rt("typed.let-struct", "typed", { sizeKind: "items" }),
    rt("typed.call-typed", "typed", { sizeKind: "items" }),
    rt("typed.call-plain", "typed", { sizeKind: "items" }),
    rt("typed.call-typed-fail", "typed"),
    rt("kindof.mixed-arrays", "typed", { sizeKind: "items" }),
    rt("kindof.large-int-array", "typed", { sizeKind: "items" }),
    rt("match.enum", "matchproxy", { sizeKind: "items" }),
    rt("match.value", "matchproxy", { sizeKind: "items" }),
    rt("proxy.guarded-write", "matchproxy", { sizeKind: "items" }),
    rt("proxy.plain-write", "matchproxy", { sizeKind: "items" }),
    rt("proxy.write-fail", "matchproxy"),
    rt("component.create", "components"),
    rt("startup.hello", "startup", { budgetFactor: 4 }),
    rt("startup.node-baseline", "startup", { budgetFactor: 4 }),
    rt("size.generated-js", "startup", { sizeKind: "decls", metric: true, modes: ["dev"] }),
    rt("size.runtime", "startup", { metric: true, modes: ["dev"] })
]
