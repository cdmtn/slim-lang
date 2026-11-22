import { VARIANT } from "./matching.js"
import { unlockedKey } from "./lock.js"

const __test_stats__ = { passed: 0, failed: 0, skipped: 0 }

const testRoot = { name: null, parent: null, before: [], after: [], beforeAll: [], afterAll: [], skip: false, only: false, tests: 0, done: 0, started: false }
let currentGroup = testRoot
const testList = []
let testsRunning = null
let hasOnly = false
const activeSpies = []
const rootAfterAll = []

const testFilter = typeof process !== "undefined" ? process.env?.SLIM_TEST_FILTER ?? "" : ""

function groupChain(group) {
    const chain = []
    for (let entry = group; entry; entry = entry.parent) chain.unshift(entry)
    return chain
}

function groupTitle(group) {
    return groupChain(group).map(entry => entry.name).filter(name => name !== null)
}

let summaryHooked = false

function hookSummary() {
    if (summaryHooked || typeof process === "undefined" || typeof process.on !== "function") return
    summaryHooked = true
    process.on("exit", () => {
        const total = __test_stats__.passed + __test_stats__.failed + __test_stats__.skipped
        if (total === 0) return
        const skipped = __test_stats__.skipped ? `, ${__test_stats__.skipped} skipped` : ""
        console.log(`\n${__test_stats__.passed} passed, ${__test_stats__.failed} failed${skipped}`)
    })
}

function scheduleTests() {
    hookSummary()
    if (testsRunning) return
    testsRunning = new Promise(resolve => setTimeout(resolve, 0)).then(runQueuedTests)
}

function withTimeout(result, ms, title) {
    if (!ms || !(result instanceof Promise)) return result
    let timer
    return Promise.race([
        result.finally(() => clearTimeout(timer)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`"${title}" took longer than ${ms}ms`)), ms) })
    ])
}

async function runHooks(hooks) {
    for (const hook of hooks) await hook()
}

function failTest(title, err) {
    __test_stats__.failed++
    if (typeof process !== "undefined") process.exitCode = 1
    console.log(`  ✗ ${title}\n      ${String(err?.message ?? err).split("\n").join("\n      ")}`)
}

async function runQueuedTests() {
    while (testList.length > 0) {
        const entry = testList.shift()
        const chain = groupChain(entry.group)
        const title = [...groupTitle(entry.group), entry.name].join(" › ")
        const skipped = entry.skip || chain.some(group => group.skip) ||
            (hasOnly && !entry.only && !chain.some(group => group.only)) ||
            (testFilter && !title.toLowerCase().includes(testFilter.toLowerCase()))
        if (skipped) {
            __test_stats__.skipped++
            if (!testFilter && !hasOnly) console.log(`  - ${title} (skipped)`)
        } else {
            try {
                for (const group of chain) {
                    if (group.started) continue
                    group.started = true
                    await runHooks(group.beforeAll)
                }
                try {
                    await runHooks(chain.flatMap(group => group.before))
                    await withTimeout(entry.fn(), entry.timeout, title)
                } finally {
                    while (activeSpies.length > 0) activeSpies.pop().restore()
                    await runHooks(chain.slice().reverse().flatMap(group => group.after))
                }
                __test_stats__.passed++
                console.log(`  ✓ ${title}`)
            } catch (err) {
                failTest(title, err)
            }
        }
        for (const group of chain.slice().reverse()) {
            group.done++
            if (group.done !== group.tests || !group.started || group === testRoot) continue
            try {
                await runHooks(group.afterAll)
            } catch (err) {
                failTest(`${groupTitle(group).join(" › ")} (afterAll)`, err)
            }
        }
    }
    testsRunning = null
    if (rootAfterAll.length > 0 && testRoot.started) {
        const hooks = rootAfterAll.splice(0)
        try {
            await runHooks(hooks)
        } catch (err) {
            failTest("afterAll", err)
        }
    }
}

function registerGroup(name, fn, flags) {
    const group = { name, parent: currentGroup, before: [], after: [], beforeAll: [], afterAll: [], tests: 0, done: 0, started: false, ...flags }
    if (flags.only) hasOnly = true
    currentGroup = group
    try {
        fn()
    } finally {
        currentGroup = group.parent
    }
}

export function describe(name, fn) {
    registerGroup(name, fn, { skip: false, only: false })
}
describe.skip = (name, fn) => registerGroup(name, fn, { skip: true, only: false })
describe.only = (name, fn) => registerGroup(name, fn, { skip: false, only: true })

function registerTest(name, fn, options, flags) {
    if (flags.only) hasOnly = true
    for (let group = currentGroup; group; group = group.parent) group.tests++
    testList.push({ name, fn, group: currentGroup, timeout: options?.timeout ?? 5000, ...flags })
    scheduleTests()
}

export function test(name, fn, options) {
    registerTest(name, fn, options, { skip: false, only: false })
}
test.skip = (name, fn, options) => registerTest(name, fn ?? (() => {}), options, { skip: true, only: false })
test.only = (name, fn, options) => registerTest(name, fn, options, { skip: false, only: true })

export function beforeEach(fn) { currentGroup.before.push(fn) }
export function afterEach(fn) { currentGroup.after.push(fn) }
export function beforeAll(fn) { currentGroup.beforeAll.push(fn) }
export function afterAll(fn) { (currentGroup === testRoot ? rootAfterAll : currentGroup.afterAll).push(fn) }

function showValue(value) {
    if (typeof value === "string") return JSON.stringify(value)
    if (typeof value === "bigint") return `${value}n`
    if (typeof value === "function") return `function ${value.name || "(anonymous)"}`
    if (value instanceof Map) return `Map(${showValue([...value])})`
    if (value instanceof Set) return `Set(${showValue([...value])})`
    if (value?.[VARIANT]) return String(value)
    try {
        return JSON.stringify(value, (_, item) => typeof item === "bigint" ? `${item}n` : item) ?? String(value)
    } catch {
        return String(value)
    }
}

export function assert(condition, message = "assertion failed") {
    if (!condition) throw new Error(message)
}

export function assertEqual(actual, expected, message) {
    if (!Object.is(actual, expected)) {
        throw new Error(message ?? `expected ${showValue(expected)}, got ${showValue(actual)}`)
    }
}

const MISSING = Symbol("missing")

export function deepEqual(a, b, seen = new Map()) {
    if (Object.is(a, b)) return true
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
    if (seen.get(a) === b) return true
    seen.set(a, b)
    if (a instanceof Date) return a.getTime() === b.getTime()
    if (a instanceof RegExp) return String(a) === String(b)
    if (a instanceof Map) {
        if (a.size !== b.size) return false
        for (const [key, value] of a) {
            const plain = unlockedKey(key)
            const other = b.has(plain) ? b.get(plain) : b.has(key) ? b.get(key) : MISSING
            if (other === MISSING || !deepEqual(value, other, seen)) return false
        }
        return true
    }
    if (a instanceof Set) {
        if (a.size !== b.size) return false
        const unmatched = [...b].filter(value => !a.has(value))
        for (const value of a) {
            if (b.has(value)) continue
            if (typeof value !== "object" || value === null) return false
            const index = unmatched.findIndex(candidate => deepEqual(value, candidate, new Map(seen)))
            if (index === -1) return false
            unmatched.splice(index, 1)
        }
        return true
    }
    if (Array.isArray(a) && a.length !== b.length) return false
    const keys = Reflect.ownKeys(a)
    if (keys.length !== Reflect.ownKeys(b).length) return false
    return keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key], seen))
}

export function assertDeepEqual(actual, expected, message) {
    if (!deepEqual(actual, expected)) {
        throw new Error(message ?? `expected ${showValue(expected)}, got ${showValue(actual)}`)
    }
}

function errorMatches(err, expected) {
    if (expected === undefined) return true
    if (typeof expected === "string") return String(err?.message ?? err).includes(expected)
    if (expected instanceof RegExp) return expected.test(String(err?.message ?? err))
    if (typeof expected === "function") return err instanceof expected
    return false
}

function expectedText(expected) {
    if (expected === undefined) return ""
    if (typeof expected === "function") return ` ${expected.name}`
    return ` matching ${expected instanceof RegExp ? String(expected) : showValue(expected)}`
}

export function assertThrows(fn, expected, message) {
    try {
        fn()
    } catch (err) {
        if (!errorMatches(err, expected)) {
            throw new Error(message ?? `expected an error${expectedText(expected)}, got ${err?.name ?? "error"}: ${err?.message ?? err}`)
        }
        return err
    }
    throw new Error(message ?? `expected an error${expectedText(expected)}, but nothing was thrown`)
}

export async function assertRejects(fn, expected, message) {
    try {
        await (typeof fn === "function" ? fn() : fn)
    } catch (err) {
        if (!errorMatches(err, expected)) {
            throw new Error(message ?? `expected a rejection${expectedText(expected)}, got ${err?.name ?? "error"}: ${err?.message ?? err}`)
        }
        return err
    }
    throw new Error(message ?? `expected a rejection${expectedText(expected)}, but it resolved`)
}

export function mock(implementation) {
    let impl = implementation
    const queued = []
    const fake = function (...args) {
        fake.calls.push(args)
        fake.callCount++
        if (queued.length > 0) return queued.shift()
        if (impl) return impl.apply(this, args)
        return fake.returnValue
    }
    fake.calls = []
    fake.callCount = 0
    fake.returnValue = undefined
    fake.returns = value => { fake.returnValue = value; return fake }
    fake.returnsOnce = value => { queued.push(value); return fake }
    fake.implement = next => { impl = next; return fake }
    fake.calledWith = (...args) => fake.calls.some(call => deepEqual(call, args))
    fake.lastCall = () => fake.calls.at(-1)
    fake.reset = () => { fake.calls = []; fake.callCount = 0; queued.length = 0; return fake }
    return fake
}

export function spyOn(object, method) {
    const original = object[method]
    if (typeof original !== "function") throw new TypeError(`spyOn: "${String(method)}" is not a function`)
    const own = Object.prototype.hasOwnProperty.call(object, method)
    const spy = mock(function (...args) { return original.apply(this, args) })
    spy.restore = () => {
        if (own) object[method] = original
        else delete object[method]
        return spy
    }
    object[method] = spy
    activeSpies.push(spy)
    return spy
}
