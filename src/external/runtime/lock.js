const IMMUTABLE = new WeakMap()
const LOCKED_VIEWS = new WeakSet()
const lockedMutation = () => {
    throw new Error("locked object mutation")
}
const DATE_MUTATORS = new Set(Object.getOwnPropertyNames(Date.prototype).filter(name => name.startsWith("set")))
const MAP_MUTATORS = new Set(["set", "delete", "clear"])
const SET_MUTATORS = new Set(["add", "delete", "clear"])
const VIEW_MUTATORS = new Set(["set", "fill", "copyWithin", "reverse", "sort"])
const BUFFER_MUTATORS = new Set(["resize", "transfer", "transferToFixedLength"])

function slotMutators(obj) {
    if (obj instanceof Map || obj instanceof WeakMap) return MAP_MUTATORS
    if (obj instanceof Set || obj instanceof WeakSet) return SET_MUTATORS
    if (obj instanceof Date) return DATE_MUTATORS
    if (obj instanceof DataView) return new Set(Object.getOwnPropertyNames(DataView.prototype).filter(name => name.startsWith("set")))
    if (ArrayBuffer.isView(obj)) return VIEW_MUTATORS
    if (obj instanceof ArrayBuffer) return BUFFER_MUTATORS
    return null
}

const LOCKED_ORIGINALS = new WeakMap()
export const unlockedKey = value => LOCKED_ORIGINALS.get(value) ?? value

function lockedIterator(iterator, map) {
    return {
        next() {
            const step = iterator.next()
            return step.done ? step : { done: false, value: map(step.value) }
        },
        [Symbol.iterator]() { return this }
    }
}

function lockedMapReaders(map, self) {
    const pair = ([key, value]) => [__lock_object__(key), __lock_object__(value)]
    return {
        get: key => __lock_object__(map.get(unlockedKey(key))),
        has: key => map.has(unlockedKey(key)),
        keys: () => lockedIterator(map.keys(), __lock_object__),
        values: () => lockedIterator(map.values(), __lock_object__),
        entries: () => lockedIterator(map.entries(), pair),
        [Symbol.iterator]: () => lockedIterator(map.entries(), pair),
        forEach: (fn, thisArg) => map.forEach((value, key) => fn.call(thisArg, __lock_object__(value), __lock_object__(key), self()))
    }
}

function lockedViewReaders(view) {
    if (typeof view.subarray !== "function") return {}
    return {
        subarray: (...args) => __lock_object__(view.subarray(...args))
    }
}

function lockedSetReaders(set, self) {
    return {
        has: value => set.has(unlockedKey(value)),
        keys: () => lockedIterator(set.values(), __lock_object__),
        values: () => lockedIterator(set.values(), __lock_object__),
        entries: () => lockedIterator(set.values(), value => [__lock_object__(value), __lock_object__(value)]),
        [Symbol.iterator]: () => lockedIterator(set.values(), __lock_object__),
        forEach: (fn, thisArg) => set.forEach(value => fn.call(thisArg, __lock_object__(value), __lock_object__(value), self()))
    }
}

export function __lock_object__(obj) {
    if (obj === null || typeof obj !== "object") return obj

    if (LOCKED_VIEWS.has(obj)) return obj
    if (IMMUTABLE.has(obj)) return IMMUTABLE.get(obj)

    const mutators = slotMutators(obj)
    const handler = {
        set() {
            throw new Error("locked object mutation")
        },
        deleteProperty() {
            throw new Error("locked object mutation")
        },
        defineProperty() {
            throw new Error("locked object mutation")
        },
        setPrototypeOf() {
            throw new Error("locked object mutation")
        }
    }

    let wrapped
    if (mutators) {
        const bound = new Map()
        const readers = obj instanceof Map ? lockedMapReaders(obj, () => wrapped)
            : obj instanceof Set ? lockedSetReaders(obj, () => wrapped)
            : ArrayBuffer.isView(obj) ? lockedViewReaders(obj)
            : null
        const view = ArrayBuffer.isView(obj)
        handler.get = (target, key) => {
            const value = Reflect.get(target, key, target)
            if (view && key === "buffer") return __lock_object__(value)
            if (typeof value !== "function") return value
            if (mutators.has(key)) return lockedMutation
            if (readers && Object.hasOwn(readers, key)) return readers[key]
            if (!bound.has(key)) bound.set(key, value.bind(target))
            return bound.get(key)
        }
    }

    wrapped = new Proxy(obj, handler)
    IMMUTABLE.set(obj, wrapped)
    LOCKED_VIEWS.add(wrapped)
    LOCKED_ORIGINALS.set(wrapped, obj)

    if (obj instanceof Map) {
        for (const [key, value] of obj) {
            __lock_object__(key)
            __lock_object__(value)
        }
    }
    else if (obj instanceof Set) {
        for (const value of obj) __lock_object__(value)
    }

    for (const key of Reflect.ownKeys(obj)) {
        const descriptor = Object.getOwnPropertyDescriptor(obj, key)
        const value = descriptor.value
        if (!value || typeof value !== "object") continue

        const locked = __lock_object__(value)
        if (descriptor.writable) obj[key] = locked
    }

    if (!ArrayBuffer.isView(obj)) Object.freeze(obj)

    return wrapped
}
