# Context and Errors

## Context

`createContext(default)` makes a context; `provide` makes a value available to everything a component renders, however deep, and `inject` reads it. A provided state stays live:

```js
const Theme = createContext("light")

component Button({ children }) {
    const theme = inject(Theme)        // "dark", and follows App's state
    return <button class=${theme}>${children}</button>
}

component Toolbar() {
    return <nav><Button>Save</Button></nav>
}

component App() {
    state theme = "dark"
    provide(Theme, theme)
    return <main><Toolbar /></main>
}

log(App().querySelector("button").className) // dark
log(Button({ children: "x" }).className)     // light
```

Without a `provide` above, `inject` gives the context's default.

## Errors in components

`catchError` shows a fallback when its content throws, while it is built or later, in one of its updates. The fallback gets the error and a `reset` that tries again:

```js
component Chart({ data }) {
    if (data.length == 0) throw new Error("no data")
    return <svg></svg>
}

component Dashboard({ data }) {
    return <section>
        ${catchError(() => <Chart data=${data} />, (error, reset) =>
            <p>Chart failed: ${error.message} <button onClick=${reset}>retry</button></p>)}
    </section>
}

log(Dashboard({ data: [] }).querySelector("p").textContent) // Chart failed: no data retry
```

For errors outside components, see [Error handling](../12-error-handling.md).

Next: [Animations](07-animations.md).
