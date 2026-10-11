// Struct.verify / verifySafe / new on flat, nested and array-heavy data, success and failure.
// The failure path throws or builds a result per object, so it is capped at FAIL_CAP items.
const FAIL_CAP = 1000

const user = (i, roles = 3, tags = 2) => ({
    name: "u" + i, id: i,
    roles: Array.from({ length: roles }, (_, k) => "r" + k),
    tags: Array.from({ length: tags }, (_, k) => ({ name: "t" + k }))
})
const SHAPES = {
    flat: { struct: "Flat", ok: i => ({ name: "n" + i, id: i, active: true }), bad: o => ({ ...o, id: "x" }) },
    nested: {
        struct: "Team",
        ok: i => ({ title: "t" + i, lead: user(i), members: [user(i + 1), user(i + 2)] }),
        bad: o => ({ ...o, lead: { ...o.lead, id: "x" } })
    },
    array: { struct: "User", ok: i => user(i, 8, 4), bad: o => ({ ...o, roles: [...o.roles, 7] }) }
}

// Each op returns a function: object -> boolean "accepted".
const OPS = {
    verify: S => o => { try { S.verify(o); return true } catch { return false } },
    verifySafe: S => o => S.verifySafe(o).success === true,
    new: S => o => { try { return S.new(o) != null } catch { return false } }
}

function make(shape, op, path) {
    return async (ctx, size) => {
        const { module } = await ctx.load("runtime", ctx.fixture("runtime"))
        const spec = SHAPES[shape]
        const items = path === "fail" ? Math.min(size, FAIL_CAP) : size
        const data = Array.from({ length: items }, (_, i) => (path === "fail" ? spec.bad(spec.ok(i)) : spec.ok(i)))
        const accepts = OPS[op](module[spec.struct])
        // Single pre-check: the fixture itself must behave as labelled before timing starts.
        if (accepts(data[0]) !== (path === "ok")) throw new Error(`${shape}.${op}: fixture does not take the ${path} path`)
        return {
            run: () => {
                let accepted = 0
                for (let i = 0; i < data.length; i++) if (accepts(data[i])) accepted++
                return accepted
            },
            verify: accepted => {
                const expected = path === "ok" ? items : 0
                if (accepted !== expected) throw new Error(`${accepted} objects accepted, expected ${expected}`)
            },
            counters: { items, path, mode: ctx.mode }
        }
    }
}

export const setups = {}
for (const shape of Object.keys(SHAPES)) {
    for (const op of Object.keys(OPS)) {
        for (const path of ["ok", "fail"]) setups[`runtime.struct.${shape}.${op}.${path}`] = make(shape, op, path)
    }
}
