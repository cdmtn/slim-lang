import { Computation, Signal, __computed__, batch, effect, owner, untrack, update } from "../reactive.js"
import { hydrationData, serverData, serverRendering } from "./server.js"

export function sweep(keys) {
    for (const [key, node] of keys) if (!node.observers?.length) keys.delete(key)
    keys.limit = Math.max(256, keys.size * 2)
}

export function watchKeys(source) {
    const keys = new Map()
    keys.limit = 256
    let current = source.peek()
    const watcher = new Computation(() => {
        const next = source.v
        if (Object.is(next, current)) return
        const previous = current
        current = next
        const touched = keys.loose
            ? [...keys.keys()].filter(key => key == previous || key == next || Object.is(key, previous) || Object.is(key, next))
            : [previous, next]
        for (const key of touched) {
            const node = keys.get(key)
            if (!node) continue
            if (node.observers?.length) node.notify()
            else keys.delete(key)
        }
    }, true)
    watcher.isWatcher = true
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

    const start = input => {
        const current = ++version
        let pending
        try {
            pending = withSource ? loader(input) : loader()
        } catch (failure) {
            pending = Promise.reject(failure)
        }
        untrack(() => batch(() => {
            loading.v = true
            error.v = null
        }))
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
        let input
        let pending
        try {
            input = withSource ? untrack(source) : undefined
        } catch (failure) {
            pending = Promise.reject(failure)
        }
        const key = resourceKey(data, loader, input, owner)
        data.order.push(key)
        const known = data.results.get(key)
        if (known) {
            settle(known)
        } else {
            pending ??= untrack(() => {
                try {
                    return Promise.resolve(withSource ? loader(input) : loader())
                } catch (failure) {
                    return Promise.reject(failure)
                }
            })
            data.pending.push(pending.then(
                result => { data.results.set(key, { value: result }) },
                failure => { data.results.set(key, { error: failure }) }
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
        if (hydrated) {
            hydrated = false
            refresh()
            return
        }
        start()
    })
    return api

    function refresh() {
        const current = ++version
        let pending
        try {
            pending = loader()
        } catch (failure) {
            pending = Promise.reject(failure)
        }
        Promise.resolve(pending).then(
            result => {
                if (current === version && !Object.is(result, value.peek())) value.v = result
            },
            () => {}
        )
    }
}

resource.pages = function pages(first, second) {
    const withSource = typeof second === "function"
    const loader = withSource ? second : first
    const added = new Signal([])
    const adding = new Signal(false)
    const failed = new Signal(null)
    let version = 0
    let input

    const reset = value => {
        input = value
        version++
        untrack(() => batch(() => {
            added.v = []
            adding.v = false
            failed.v = null
        }))
    }
    const head = withSource
        ? resource(() => (input = first()), value => {
            reset(value)
            return loader(value, undefined)
        })
        : resource(() => {
            reset(undefined)
            return loader(undefined, undefined)
        })
    const loaded = __computed__(() => {
        const page = head.value
        return page == null ? [] : [page, ...added.v]
    })
    const items = __computed__(() => loaded.v.flatMap(page => page?.items ?? []))
    const cursor = () => {
        const list = loaded.peek()
        return list.length ? list[list.length - 1]?.next : undefined
    }

    return {
        get items() { return items.v },
        get pages() { return loaded.v },
        get loading() { return head.loading || adding.v },
        get error() { return head.error ?? failed.v },
        get done() {
            const list = loaded.v
            return !head.loading && list.length > 0 && list[list.length - 1]?.next == null
        },
        reload: () => head.reload(),
        more() {
            return untrack(() => {
                if (head.loading || adding.v || loaded.peek().length === 0) return Promise.resolve(false)
                const next = cursor()
                if (next == null) return Promise.resolve(false)
                const current = version
                batch(() => {
                    adding.v = true
                    failed.v = null
                })
                let pending
                try {
                    pending = loader(input, next)
                } catch (failure) {
                    pending = Promise.reject(failure)
                }
                return Promise.resolve(pending).then(
                    page => {
                        if (current !== version) return false
                        batch(() => {
                            added.v = [...added.peek(), page]
                            adding.v = false
                        })
                        return true
                    },
                    failure => {
                        if (current !== version) return false
                        batch(() => {
                            failed.v = failure
                            adding.v = false
                        })
                        return false
                    }
                )
            })
        }
    }
}

function serialize(value) {
    try {
        return JSON.stringify(value, (key, item) => {
            if (typeof item === "bigint") return `${item}n`
            if (typeof item === "function") return item.__component__ ? `<${item.name}>` : undefined
            if (item instanceof Map) return { "@map": [...item] }
            if (item instanceof Set) return { "@set": [...item] }
            if (item && typeof item === "object" && typeof item.nodeType === "number") return undefined
            return item
        }) ?? ""
    } catch {
        return ""
    }
}

export function componentKey(from) {
    for (let current = from; current; current = current.parent) {
        if (current.ssrKey !== undefined) return current.ssrKey
    }
    return ""
}

function resourceKey(data, loader, input, from) {
    const base = `${componentKey(from)}\u0000${String(loader)}\u0000${serialize(input)}`
    const seen = data.seen.get(base) ?? 0
    data.seen.set(base, seen + 1)
    return `${base}\u0000${seen}`
}

export function identify(fn, props) {
    const text = String(fn)
    let hash = 0
    for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0
    return `${hash.toString(36)}:${text.length}:${props === undefined ? "" : serialize(props)}`
}
