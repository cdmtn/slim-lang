import { Owner, Signal, __computed__, owner, runWithOwner, untrack } from "../reactive.js"

export function createContext(fallback) {
    return { fallback }
}

const LIVE = Symbol("live")

export function __live__(read) {
    return { [LIVE]: read }
}

export function __lazy_children__(props, build) {
    const creator = owner
    let built = false
    let children
    return Object.defineProperty(props, "children", {
        enumerable: true,
        configurable: true,
        get() {
            if (!built) {
                built = true
                const scope = new Owner(owner ?? creator, false)
                if (creator) (creator.cleanups ??= []).push(() => scope.dispose())
                children = runWithOwner(scope, build)
            }
            return children
        }
    })
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
    const clear = () => {
        try {
            scope.clean()
        } catch (failure) {
            if (failed.peek() === null) queueError(failed, failure)
        }
    }
    const content = __computed__(() => {
        const error = failed.v
        clear()
        if (error) return untrack(() => fallback(error, reset))
        return runWithOwner(scope, () => {
            try {
                return render()
            } catch (failure) {
                clear()
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
