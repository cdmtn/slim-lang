// Annotated let / parameters / returns, and kindof on arrays. Typed and plain variants
// run the same loop so the difference is the guard cost; results are verified, not just timed.
const triangle = n => (n * (n - 1)) / 2
const load = ctx => ctx.load("runtime", ctx.fixture("runtime")).then(r => r.module)

const loop = (call, expected, extra = {}) => async (ctx, size) => {
    const m = await load(ctx)
    const arg = call.arg ? await call.arg(ctx, size, m) : size
    return {
        run: () => m[call.fn](arg),
        verify: v => { if (v !== expected(size)) throw new Error(`${call.fn} returned ${v}, expected ${expected(size)}`) },
        counters: { items: size, ...extra }
    }
}

const users = size => Array.from({ length: size }, (_, i) => ({ name: "u" + i, id: i, roles: ["a"], tags: [{ name: "x" }] }))
const KINDS = [[[1, 2], "int[]"], [["a"], "string[]"], [[{}], "object[]"], [[1, "a"], "array"], [[[1]], "array"]]

export const setups = {
    "runtime.typed.let-int": loop({ fn: "loopLetTyped" }, triangle),
    "runtime.typed.let-plain": loop({ fn: "loopLetPlain" }, triangle),
    "runtime.typed.let-array": loop({ fn: "loopLetArray" }, n => 3 * n),
    "runtime.typed.let-struct": loop({ fn: "loopLetStruct", arg: (_, size) => users(size) }, triangle),
    "runtime.typed.call-typed": loop({ fn: "loopTypedCall" }, n => n),
    "runtime.typed.call-plain": loop({ fn: "loopPlainCall" }, n => n),
    // Failure path: a wrong argument type throws in dev and is erased in release.
    async "runtime.typed.call-typed-fail"(ctx) {
        const m = await load(ctx)
        const calls = 1000
        const expected = ctx.mode === "dev" ? calls : 0
        return {
            run: () => {
                let thrown = 0
                for (let i = 0; i < calls; i++) { try { m.typedAdd("x", 1) } catch { thrown++ } }
                return thrown
            },
            verify: thrown => { if (thrown !== expected) throw new Error(`${thrown} throws, expected ${expected} in ${ctx.mode}`) },
            counters: { calls, expected_throws: expected }
        }
    },
    async "runtime.kindof.mixed-arrays"(ctx, size) {
        const m = await load(ctx)
        const list = Array.from({ length: size }, (_, i) => KINDS[i % KINDS.length][0])
        let expected = 0
        for (let i = 0; i < size; i++) expected += KINDS[i % KINDS.length][1].length
        return {
            run: () => m.loopKind(list),
            verify: v => { if (v !== expected) throw new Error(`kind label lengths ${v}, expected ${expected}`) },
            counters: { items: size, kinds: KINDS.length }
        }
    },
    async "runtime.kindof.large-int-array"(ctx, size) {
        const { type } = await ctx.src("src/external/core.js")
        const big = Array.from({ length: size }, (_, i) => i)
        return {
            run: () => type(big),
            verify: v => { if (v !== "int[]") throw new Error(`type() returned ${v}`) },
            counters: { elements: size }
        }
    }
}
