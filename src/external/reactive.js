
const CLEAN = 0
const CHECK = 1
const DIRTY = 2
const DISPOSED = 3

let observer = null
let owner = null
let batchDepth = 0
let queue = []
let flushing = false
let pendingEffects = null
let serverRendering = false
let rootHook = null

export function setServerRendering(on) {
    serverRendering = on
}

let serverData = null
let hydrationData = null

export function setServerData(data) {
    serverData = data
}

export function setHydrationData(data) {
    hydrationData = data
}

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
        if (owned) for (let i = 0; i < owned.length; i++) owned[i].dispose()
        if (cleanups) for (let i = 0; i < cleanups.length; i++) cleanups[i]()
    }

    dispose() {
        if (this.state === DISPOSED) return
        this.clean()
        this.state = DISPOSED
    }
}

export class Signal {
    constructor(value) {
        this.value = value
        this.observers = null
        this.observerSlots = null
    }

    get v() {
        if (observer) track(this)
        return this.value
    }

    set v(next) {
        if (Object.is(next, this.value)) return
        this.value = next
        this.notify()
    }

    peek() {
        return this.value
    }

    notify() {
        if (!this.observers || this.observers.length === 0) return
        mark(this.observers, DIRTY)
        if (batchDepth === 0) flush()
    }
}

class Computation extends Owner {
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
    }

    get v() {
        if (this.state !== CLEAN && this.state !== DISPOSED) update(this)
        if (observer) track(this)
        return this.value
    }

    peek() {
        if (this.state !== CLEAN && this.state !== DISPOSED) update(this)
        return this.value
    }

    notify() {
        if (!this.observers || this.observers.length === 0) return
        mark(this.observers, DIRTY)
        if (batchDepth === 0) flush()
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
            if (!this.isEffect && !Object.is(next, this.value) && this.observers) {
                for (let i = 0; i < this.observers.length; i++) this.observers[i].state = DIRTY
            }
            this.value = next
        } finally {
            observer = previousObserver
            owner = previousOwner
        }
    }

    dispose() {
        if (this.state === DISPOSED) return
        unsubscribe(this)
        this.clean()
        this.state = DISPOSED
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
        if (o.state >= state) continue
        const wasClean = o.state === CLEAN
        o.state = state
        if (!wasClean) continue
        if (o.isEffect) queue.push(o)
        else if (o.observers) mark(o.observers, CHECK)
    }
}

function update(node) {
    if (node.state === CHECK && node.sources) {
        const sources = node.sources
        for (let i = 0; i < sources.length; i++) {
            const source = sources[i]
            if (source instanceof Computation) {
                update(source)
                if (node.state === DIRTY) break
            }
        }
    }
    if (node.state === DIRTY) node.run()
    if (node.state !== DISPOSED) node.state = CLEAN
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
        for (let round = 0; queue.length > 0; round++) {
            if (round === MAX_ROUNDS) {
                queue = []
                throw new Error("Effects keep changing the state they read: an effect writes a value it depends on")
            }
            const effects = queue
            queue = []
            for (const effect of effects) {
                if (effect.state === CLEAN || effect.state === DISPOSED) continue
                try {
                    update(effect)
                } catch (error) {
                    effect.state = CLEAN
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

export function __signal__(value) {
    return new Signal(value)
}

export function __computed__(fn) {
    const node = new Computation(fn, false)
    if (owner) (owner.owned ??= []).push(node)
    return node
}

const notifying = () => !observer || observer.isUser

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
        if (--batchDepth === 0) flush()
    }
}

export function onCleanup(fn) {
    if (owner) (owner.cleanups ??= []).push(fn)
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
        track(node)
    }
    const value = source.peek()
    return strict ? value === key : value == key
}

function sweep(keys) {
    for (const [key, node] of keys) if (!node.observers?.length) keys.delete(key)
    keys.limit = Math.max(256, keys.size * 2)
}

function watchKeys(source) {
    const keys = new Map()
    keys.limit = 256
    let current = source.peek()
    const watcher = new Computation(() => {
        const next = source.v
        if (Object.is(next, current)) return
        for (const key of [current, next]) {
            const node = keys.get(key)
            if (!node) continue
            if (node.observers?.length) node.notify()
            else keys.delete(key)
        }
        current = next
    }, true)
    watcher.parent = null
    update(watcher)
    return keys
}

export function resource(first, second, third) {
    const withSource = typeof second === "function"
    const source = withSource ? first : null
    const loader = withSource ? second : first
    const value = new Signal(withSource ? third : second)
    const loading = new Signal(true)
    const error = new Signal(null)
    let version = 0
    let lastInput

    const settle = result => {
        if (result.error !== undefined) error.value = result.error
        else value.value = result.value
        loading.value = false
    }

    const start = (input, quiet = false) => {
        const current = ++version
        let pending
        try {
            pending = withSource ? loader(input) : loader()
        } catch (failure) {
            pending = Promise.reject(failure)
        }
        if (!quiet) {
            untrack(() => batch(() => {
                loading.v = true
                error.v = null
            }))
        }
        Promise.resolve(pending).then(
            result => {
                if (current === version) batch(() => { value.v = result; loading.v = false; error.v = null })
            },
            failure => {
                if (current === version) batch(() => { error.v = failure; loading.v = false })
            }
        )
    }

    const api = {
        get value() { return value.v },
        get loading() { return loading.v },
        get error() { return error.v },
        set value(next) { value.v = next },
        reload: () => untrack(() => start(lastInput))
    }

    if (serverRendering) {
        const data = serverData
        if (!data) return api
        const slot = data.index++
        const known = data.results[slot]
        if (known) {
            settle(known)
        } else {
            const pending = untrack(() => {
                try {
                    return Promise.resolve(withSource ? loader(source()) : loader())
                } catch (failure) {
                    return Promise.reject(failure)
                }
            })
            data.pending.push(pending.then(
                result => { data.results[slot] = { value: result } },
                failure => { data.results[slot] = { error: failure } }
            ))
        }
        return api
    }

    let hydrated = false
    if (hydrationData && hydrationData.index < hydrationData.values.length) {
        const sent = hydrationData.values[hydrationData.index++]
        if (sent) {
            settle(sent.error !== undefined ? { error: new Error(sent.error) } : sent)
            hydrated = true
        }
    }

    effect(() => {
        if (withSource) {
            const input = lastInput = source()
            if (hydrated) {
                hydrated = false
                return
            }
            untrack(() => start(input))
            return
        }
        start(undefined, hydrated)
        hydrated = false
    })
    return api
}


export function createContext(fallback) {
    return { fallback }
}

const LIVE = Symbol("live")

export function __live__(read) {
    return { [LIVE]: read }
}

export function provide(context, value) {
    if (!owner) throw new Error("provide() can only be called while a component renders")
    ;(owner.context ??= new Map()).set(context, value)
}

export function inject(context) {
    for (let current = owner; current; current = current.parent) {
        if (current.context?.has(context)) {
            const value = current.context.get(context)
            return value && typeof value === "object" && LIVE in value ? value[LIVE]() : value
        }
    }
    return context?.fallback
}


export function catchError(render, fallback) {
    const failed = new Signal(null)
    const scope = new Owner()
    scope.onError = error => { failed.v = error }
    const reset = () => { failed.v = null }
    const content = __computed__(() => {
        const error = failed.v
        if (error) return untrack(() => fallback(error, reset))
        return runWithOwner(scope, () => {
            try {
                return render()
            } catch (failure) {
                failed.peek() === null && queueError(failed, failure)
                return untrack(() => fallback(failure, reset))
            }
        })
    })
    return live(() => content.v)
}

export function live(read) {
    read.__slimLive = true
    return read
}

function queueError(failed, failure) {
    failed.value = failure
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

export function __component__(fn) {
    const top = owner === null
    const scope = new Owner()
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
    effect, watch, untrack, batch, onCleanup, resource, createContext, provide, inject, catchError,
    __signal__, __computed__, __mut__, __mut_deep__, __is__, __render_effect__, __component__, __defaults__, __live__
}
