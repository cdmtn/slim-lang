export let serverRendering = false

export function setServerRendering(on) {
    serverRendering = on
}

export let serverData = null
export let hydrationData = null

export function setServerData(data) {
    serverData = data
}

export function setHydrationData(data) {
    hydrationData = data
}

let serverStore = null
let clientStore = null

export function setServerStore(store) {
    serverStore = store
}

export function setClientStore(store) {
    clientStore = store
}

export function provideData(key, compute) {
    if (clientStore && Object.hasOwn(clientStore, key)) return clientStore[key]
    if (serverStore && Object.hasOwn(serverStore, key)) return serverStore[key]
    const value = typeof compute === "function" ? compute() : compute
    if (serverStore) Object.defineProperty(serverStore, key, { value, enumerable: true, writable: true, configurable: true })
    return value
}

export function takeData(key) {
    for (const store of [clientStore, globalThis.__slimStore]) {
        if (!store || typeof store !== "object" || !Object.hasOwn(store, key)) continue
        const value = store[key]
        delete store[key]
        return { value }
    }
    return null
}

export function withoutHydration(fn) {
    const previous = hydrationData
    const previousStore = clientStore
    hydrationData = null
    clientStore = null
    try {
        return fn()
    } finally {
        hydrationData = previous
        clientStore = previousStore
    }
}

export function awaitOnServer(promise) {
    if (serverRendering && serverData && promise) serverData.pending.push(promise)
}
