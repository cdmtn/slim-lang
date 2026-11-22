import assert from "node:assert/strict"
import { test } from "node:test"
import { Signal, Owner, __computed__, effect, runWithOwner, batch } from "../src/external/reactive.js"

test("a change made while a computation runs is not lost, and later changes still reach its readers", () => {
    const route = new Signal("a")
    const owner = new Owner(null)
    const seen = []
    runWithOwner(owner, () => {
        const target = __computed__(() => route.v)
        const key = __computed__(() => target.v + "!")
        const page = __computed__(() => {
            const id = key.v
            if (id == "b!") route.v = "c"
            return id
        })
        effect(() => seen.push(page.v))
    })
    route.v = "b"
    route.v = "d"
    batch(() => { route.v = "e" })
    assert.deepEqual(seen, ["a!", "c!", "d!", "e!"])
    owner.dispose()
})

test("an effect that writes a signal it reads directly runs once, as before", () => {
    const count = new Signal(0)
    const owner = new Owner(null)
    let runs = 0
    runWithOwner(owner, () => effect(() => {
        runs++
        count.v = count.v + 1
    }))
    assert.equal(runs, 1)
    assert.equal(count.peek(), 1)
    owner.dispose()
})
