import { provideData, serverData, serverRendering } from "./reactive/server.js"
import { componentKey, identify, resource, sweep, watchKeys } from "./reactive/resource.js"
import { __lazy_children__, __live__, catchError, createContext, inject, provide } from "./reactive/context.js"
export { setServerRendering, setServerData, setHydrationData, setServerStore, setClientStore, provideData, withoutHydration, awaitOnServer } from "./reactive/server.js"
export { resource } from "./reactive/resource.js"
export { createContext, __live__, __lazy_children__, provide, inject, catchError, live } from "./reactive/context.js"

const CLEAN = 0
const CHECK = 1
const DIRTY = 2
const DISPOSED = 3

let observer = null
export let owner = null
let batchDepth = 0
let queue = []
let flushing = false
let pendingEffects = null
let writes = 0

let rootHook = null

export function setRootHook(fn) {
    rootHook = fn
}

export class Owner {
    constructor(parent = owner, attach = true) {
        this.parent = parent
        this.owned = null
        this.cleanups = null
        this.context = null
        this.state = CLEAN
        if (parent && attach) (parent.owned ??= []).push(this)
    }

    clean() {
        const owned = this.owned
        const cleanups = this.cleanups
        this.owned = null
        this.cleanups = null
        let failed = false
        let failure
        if (owned) for (let i = 0; i < owned.length; i++) {
            try {
                owned[i].dispose()
            } catch (error) {
                if (!failed) {
                    failed = true
                    failure = error
                }
            }
        }
        if (cleanups) for (let i = 0; i < cleanups.length; i++) {
            try {
                cleanups[i]()
            } catch (error) {
                if (!failed) {
                    failed = true
                    failure = error
                }
            }
        }
        if (failed) throw failure
    }

    dispose() {
        if (this.state === DISPOSED) return
        this.state = DISPOSED
        this.clean()
    }
}

export class Signal {
    constructor(value) {
        this.value = value
        this.observers = null
        this.observerSlots = null
        this.equals = null
    }

    get v() {
        if (observer) track(this)
        return this.value
    }

    set v(next) {
        if (this.equals ? this.equals(this.value, next) : Object.is(next, this.value)) return
        this.value = next
        this.notify()
    }

    peek() {
        return this.value
    }

    notify() {
        if (!this.observers || this.observers.length === 0) return
        writes++
        mark(this.observers, DIRTY)
        if (batchDepth === 0) settle()
    }
}

export class Computation extends Owner {
    constructor(fn, isEffect) {
        super(owner, false)
        this.fn = fn
        this.value = undefined
        this.state = DIRTY
        this.sources = null
        this.sourceSlots = null
        this.observers = null
        this.observerSlots = null
        this.isEffect = isEffect
        this.isUser = false
        this.runs = 0
        this.failed = false
        this.error = undefined
        this.equals = null
        this.running = false
        this.rerun = false
        this.requeued = false
    }

    get v() {
        if (watchers !== null && batchDepth > 0 && !settling) settleWatchers()
        if (this.state === CLEAN || this.state === DISPOSED) {
            if (observer) track(this)
        } else {
            try {
                update(this)
            } finally {
                if (observer) follow(this)
            }
        }
        if (this.failed) throw this.error
        return this.value
    }

    peek() {
        if (watchers !== null && batchDepth > 0 && !settling) settleWatchers()
        if (this.state !== CLEAN && this.state !== DISPOSED) update(this)
        if (this.failed) throw this.error
        return this.value
    }

    notify() {
        if (!this.observers || this.observers.length === 0) return
        writes++
        mark(this.observers, DIRTY)
        if (batchDepth === 0) settle()
    }

    run() {
        this.clean()
        unsubscribe(this)
        this.runs++
        const previousObserver = observer
        const previousOwner = owner
        observer = this
        owner = this
        try {
            const next = this.fn(this.value)
            const changed = !this.isEffect && (this.failed || !(this.equals ? this.equals(this.value, next) : Object.is(next, this.value)))
            this.value = next
            if (changed) stale(this)
        } finally {
            observer = previousObserver
            owner = previousOwner
        }
    }

    dispose() {
        if (this.state === DISPOSED) return
        unsubscribe(this)
        this.state = DISPOSED
        this.clean()
    }
}

function track(source) {
    const o = observer
    if (source.trackedBy === o && source.trackedRun === o.runs) return
    source.trackedBy = o
    source.trackedRun = o.runs

    const sourceSlot = source.observers ? source.observers.length : 0
    if (o.sources) {
        o.sources.push(source)
        o.sourceSlots.push(sourceSlot)
    } else {
        o.sources = [source]
        o.sourceSlots = [sourceSlot]
    }
    const observerSlot = o.sources.length - 1
    if (source.observers) {
        source.observers.push(o)
        source.observerSlots.push(observerSlot)
    } else {
        source.observers = [o]
        source.observerSlots = [observerSlot]
    }
}

function follow(source) {
    track(source)
    if (source.state !== CLEAN && source.state !== DISPOSED) mark([observer], CHECK)
}

function stale(node) {
    const observers = node.observers
    if (!observers) return
    for (let i = 0; i < observers.length; i++) {
        const o = observers[i]
        if (o.running && o.isEffect) o.rerun = DIRTY
        else mark([o], DIRTY)
    }
}

function unsubscribe(node) {
    const sources = node.sources
    if (!sources) return
    const slots = node.sourceSlots
    while (sources.length) {
        const source = sources.pop()
        const index = slots.pop()
        const observers = source.observers
        if (!observers || observers.length === 0) continue
        const last = observers.pop()
        const lastSlot = source.observerSlots.pop()
        if (index < observers.length) {
            last.sourceSlots[lastSlot] = index
            observers[index] = last
            source.observerSlots[index] = lastSlot
        }
    }
    node.sources = null
    node.sourceSlots = null
    if (node.trackedBy !== undefined) node.trackedBy = null
}

function mark(observers, state) {
    for (let i = 0; i < observers.length; i++) {
        const o = observers[i]
        if (o.state >= state) {
            if (o.running && o.isEffect && (state === CHECK || (observer !== null && observer !== o)) && !(o.rerun >= state)) o.rerun = state
            continue
        }
        const wasClean = o.state === CLEAN
        o.state = state
        if (!wasClean) continue
        if (o.isWatcher) (watchers ??= []).push(o)
        else if (o.isEffect) queue.push(o)
        else if (o.observers) mark(o.observers, CHECK)
    }
}

let watchers = null

function settleWatchers() {
    if (!watchers || settling) return
    settling = true
    batchDepth++
    try {
        while (watchers) {
            const pending = watchers
            watchers = null
            for (const node of pending) if (node.state !== CLEAN && node.state !== DISPOSED) update(node)
        }
    } finally {
        settling = false
        batchDepth--
    }
}

let settling = false

function settle() {
    settleWatchers()
    flush()
}

function runTop(node) {
    const chain = []
    for (let current = node; current; current = current.parent) {
        if (current.state === DISPOSED) return
        if (current instanceof Computation && current.state !== CLEAN) chain.push(current)
        const driver = current.driver
        if (driver && driver.state !== CLEAN && driver.state !== DISPOSED) chain.push(driver)
    }
    for (let i = chain.length - 1; i >= 0; i--) {
        const current = chain[i]
        if (current.state !== CLEAN && current.state !== DISPOSED) update(current)
    }
}

export function update(node) {
    if (node.running) return
    if (node.state === CHECK && node.sources) {
        const sources = node.sources
        const before = writes
        for (let i = 0; i < sources.length; i++) {
            const source = sources[i]
            if (source instanceof Computation) {
                try {
                    update(source)
                } catch {
                    node.state = DIRTY
                }
                if (source.state === CHECK || source.state === DIRTY) node.state = DIRTY
                if (node.state === DIRTY) break
            }
        }
        if (node.state === CHECK && writes !== before) {
            for (let i = 0; i < sources.length; i++) {
                const source = sources[i]
                if (source instanceof Computation && (source.state === CHECK || source.state === DIRTY)) {
                    node.state = DIRTY
                    break
                }
            }
        }
    }
    if (node.state === DIRTY) {
        if (!node.isEffect) return compute(node)
        node.requeued = false
        node.running = true
        try {
            node.run()
        } catch (error) {
            node.running = false
            const again = node.rerun
            node.rerun = false
            if (node.state !== DISPOSED) node.state = CLEAN
            if (again && node.state !== DISPOSED) {
                node.state = again
                node.requeued = true
                queue.push(node)
            }
            throw error
        }
        node.running = false
        if (node.state === DISPOSED) return
        node.state = CLEAN
        if (!node.rerun) return
        node.state = node.rerun
        node.rerun = false
        queue.push(node)
        if (!flushing && batchDepth === 0) flush()
        return
    }
    if (node.state !== DISPOSED) node.state = CLEAN
}

function compute(node) {
    node.state = CLEAN
    node.running = true
    batchDepth++
    try {
        node.run()
        node.failed = false
        node.error = undefined
    } catch (error) {
        node.failed = true
        node.error = error
        stale(node)
        throw error
    } finally {
        node.running = false
        if (--batchDepth === 0 && (queue.length > 0 || watchers)) settle()
    }
}

function handleError(node, error) {
    for (let current = node; current; current = current.parent) {
        if (current.onError && current.state !== DISPOSED) {
            current.onError(error)
            return true
        }
    }
    return false
}

const MAX_ROUNDS = 1000

function flush() {
    if (flushing) return
    flushing = true
    let failure = null
    try {
        for (let round = 0; queue.length > 0 || (watchers && !settling); round++) {
            settleWatchers()
            if (round === MAX_ROUNDS) {
                queue = []
                throw new Error("Effects keep changing the state they read: an effect writes a value it depends on")
            }
            const effects = queue
            queue = []
            for (const effect of effects) {
                if (effect.state === CLEAN || effect.state === DISPOSED) continue
                try {
                    runTop(effect)
                } catch (error) {
                    if (effect.requeued) effect.requeued = false
                    else if (effect.state !== DISPOSED) effect.state = CLEAN
                    if (!handleError(effect, error)) failure ??= error
                }
            }
        }
    } finally {
        flushing = false
        changedObjects = null
    }
    if (failure) throw failure
}

export function __render_effect__(fn) {
    const parent = owner
    const node = new Computation(fn, true)
    update(node)
    if (node.sources || node.owned || node.cleanups) {
        if (parent) (parent.owned ??= []).push(node)
    }
    return node
}

const states = new Set()
const touchers = new Set()
const collected = new FinalizationRegistry(({ set, ref }) => set.delete(ref))

function hold(set, value) {
    const ref = new WeakRef(value)
    set.add(ref)
    collected.register(value, { set, ref }, ref)
    return () => {
        set.delete(ref)
        collected.unregister(ref)
    }
}

export function __signal__(value, equals) {
    const node = new Signal(value)
    if (typeof equals === "function") node.equals = equals
    if (serverRendering) return node
    const forget = hold(states, node)
    if (owner) (owner.cleanups ??= []).push(forget)
    return node
}

export function __computed__(fn) {
    const node = new Computation(fn, false)
    if (owner) (owner.owned ??= []).push(node)
    return node
}

const notifying = () => !observer || observer.isUser

const settled = (previous, next) => Object.is(previous, next) && (next === null || (typeof next !== "object" && typeof next !== "function"))

export function __field__(fn) {
    const node = __computed__(fn)
    node.equals = settled
    return node
}

export function onTouch(fn) {
    return hold(touchers, fn)
}

export function touch(object) {
    if (object === null || (typeof object !== "object" && typeof object !== "function") || !notifying()) return object
    batch(() => {
        (changedObjects ??= new Set()).add(object)
        for (const ref of states) {
            const value = ref.deref()?.value
            if (value === object || (Array.isArray(value) && value.includes(object))) ref.deref().notify()
        }
        for (const ref of touchers) ref.deref()?.(object)
    })
    return object
}

export function __mut__(source, result) {
    if (notifying()) source.notify()
    return result
}

let changedObjects = null

export function changedInPlace(value) {
    return changedObjects !== null && changedObjects.has(value)
}

export function __mut_deep__(source, change, object) {
    const result = change(object)
    if (notifying()) {
        if (object !== null && typeof object === "object") (changedObjects ??= new Set()).add(object)
        source.notify()
    }
    return result
}

export function untrack(fn) {
    const previous = observer
    observer = null
    try {
        return fn()
    } finally {
        observer = previous
    }
}

export function batch(fn) {
    batchDepth++
    try {
        return fn()
    } finally {
        if (--batchDepth === 0) settle()
    }
}

export function onCleanup(fn) {
    if (owner) (owner.cleanups ??= []).push(fn)
}

export function cleanupOf(target, fn) {
    if (target.state === DISPOSED) fn()
    else (target.cleanups ??= []).push(fn)
}

export function effect(fn) {
    if (serverRendering) return () => {}
    const node = new Computation(() => {
        const cleanup = fn()
        if (typeof cleanup === "function") onCleanup(cleanup)
    }, true)
    node.isUser = true
    if (owner) (owner.owned ??= []).push(node)
    if (pendingEffects) pendingEffects.push(node)
    else update(node)
    return () => node.dispose()
}

export function watch(source, fn) {
    let previous
    return effect(() => {
        const value = source()
        const before = previous
        previous = value
        return untrack(() => fn(value, before))
    })
}

export function __is__(source, key, strict) {
    const keys = source.selected ??= watchKeys(source)
    if (observer) {
        let node = keys.get(key)
        if (!node) {
            if (keys.size >= keys.limit) sweep(keys)
            keys.set(key, node = new Signal(undefined))
        }
        if (!strict) keys.loose = true
        track(node)
    }
    const value = source.peek()
    return strict ? value === key : value == key
}

export function runWithOwner(target, fn) {
    const previousOwner = owner
    const previousObserver = observer
    owner = target
    observer = null
    try {
        return fn()
    } finally {
        owner = previousOwner
        observer = previousObserver
    }
}

export function getOwner() {
    return owner
}

export function __component__(fn, props) {
    const top = owner === null
    const scope = new Owner()
    if (serverRendering && serverData) {
        const slot = `${componentKey(scope.parent)}/${identify(fn, props)}`
        const counts = serverData.components ??= new Map()
        const seen = counts.get(slot) ?? 0
        counts.set(slot, seen + 1)
        scope.ssrKey = `${slot}#${seen}`
    }
    const previousPending = pendingEffects
    const effects = pendingEffects = []
    let result
    try {
        result = runWithOwner(scope, fn)
    } finally {
        pendingEffects = previousPending
    }
    runWithOwner(scope, () => {
        for (const node of effects) if (node.state !== DISPOSED) update(node)
    })
    if (top && rootHook) rootHook(result)
    return result
}

export function __defaults__(props, defaults) {
    const made = {}
    const view = Object.create(null)
    for (const key of Object.keys(props)) {
        if (!(key in defaults)) Object.defineProperty(view, key, { get: () => props[key], enumerable: true })
    }
    for (const key of Object.keys(defaults)) {
        Object.defineProperty(view, key, {
            enumerable: true,
            get() {
                const value = props[key]
                if (value !== undefined) return value
                if (!(key in made)) made[key] = defaults[key]()
                return made[key]
            }
        })
    }
    return view
}

export const REACTIVE_GLOBALS = {
    effect, watch, untrack, batch, onCleanup, resource, provideData, createContext, provide, inject, catchError, touch,
    __signal__, __computed__, __field__, __mut__, __mut_deep__, __is__, __render_effect__, __component__, __defaults__, __live__, __lazy_children__
}
