// match on enum members and plain values; Proxy guard on annotated structs.
const load = ctx => ctx.load("runtime", ctx.fixture("runtime")).then(r => r.module)
const sumPattern = (n, table) => { let s = 0; for (let i = 0; i < n; i++) s += table[i % table.length]; return s }
const owner = () => ({ name: "u", id: 0, roles: ["a"], tags: [{ name: "x" }] })

export const setups = {
    async "runtime.match.enum"(ctx, size) {
        const m = await load(ctx)
        const expected = sumPattern(size, [1, 2, 3])
        return {
            run: () => m.loopMatchEnum(size),
            verify: v => { if (v !== expected) throw new Error(`match.enum ${v}, expected ${expected}`) },
            counters: { items: size }
        }
    },
    async "runtime.match.value"(ctx, size) {
        const m = await load(ctx)
        const expected = sumPattern(size, [1, 2, 3, 4])
        return {
            run: () => m.loopMatchValue(size),
            verify: v => { if (v !== expected) throw new Error(`match.value ${v}, expected ${expected}`) },
            counters: { items: size }
        }
    },
    async "runtime.proxy.guarded-write"(ctx, size) {
        const m = await load(ctx)
        const target = owner()
        return {
            run: () => m.guardedWrite(target, size),
            verify: v => { if (v !== size - 1 || target.id !== size - 1) throw new Error(`last write ${v}/${target.id}, expected ${size - 1}`) },
            counters: { writes: size }
        }
    },
    async "runtime.proxy.plain-write"(ctx, size) {
        const m = await load(ctx)
        const target = owner()
        return {
            run: () => m.plainWrite(target, size),
            verify: v => { if (v !== size - 1) throw new Error(`last write ${v}, expected ${size - 1}`) },
            counters: { writes: size }
        }
    },
    // Failure path: invalid writes are rejected by the guard in dev, and pass through in release.
    async "runtime.proxy.write-fail"(ctx) {
        const m = await load(ctx)
        const writes = 1000
        const expected = ctx.mode === "dev" ? writes : 0
        return {
            run: () => m.guardedBadWrite(owner(), writes),
            verify: v => { if (v !== expected) throw new Error(`${v} rejected writes, expected ${expected} in ${ctx.mode}`) },
            counters: { writes, expected_rejected: expected }
        }
    }
}
