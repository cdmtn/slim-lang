# Rendering and Hydration

Components run on the server as well as in the browser. On the server, the runtime builds the DOM with linkedom (loaded only where there is no DOM), so the same component can produce HTML for the first response and then become interactive in the browser.

## renderToString and hydrate

`renderToString` renders a component to HTML on the server, with markers around each `${...}`. `hydrate` runs the same component in the browser and takes over the nodes that are already there instead of building new ones, so the page is live without being drawn twice:

```js
component Counter({ start }) {
    state count = start
    return <button onClick=${() => count++}>${count}</button>
}

const html = renderToString(() => Counter({ start: 5 }))
log(html) // <button><!--[-->5<!--]--></button>
```

```javascript
// browser, with the same props
hydrate(() => Counter({ start: 5 }), document.getElementById("root"))
```

Effects don't run on the server; they start in the browser after `hydrate`. Event handlers are ordinary closures and keep everything they capture. The nodes stay where they are while the page is taken over, so focus, scroll positions and iframes are kept.

## Waiting for data

`renderToStringAsync` waits for the page's [resources](../10-reactivity/05-loading-data.md): it renders, waits for what they started loading, and renders again with the results until nothing new is loading (at most 5 times; the `passes` option changes that). It gives the HTML and a `<script>` with the data, and `hydrate` starts from that data, so the page doesn't show a loading state or load anything again:

```js
const api = {
    user: async (id: string) => ({ name: `user ${id}` })
}

component Profile({ id }) {
    const user = resource(() => id, id => api.user(id))
    return <h2>${user.value?.name ?? "…"}</h2>
}

const { html, script } = await renderToStringAsync(() => Profile({ id: "7" }))
const page = `<div id="root">${html}</div>${script}`
```

Data that is already known before rendering goes in a store. `provideData(key, compute)` returns the store's value for `key`; without one it calls `compute`, and on the server keeps the result, so the browser gets the same value with the page instead of computing it again:

```js
component Greeting() {
    const name = provideData("name", () => "guest")
    return <p>Hello, ${name}</p>
}

const { html } = await renderToStringAsync(() => Greeting(), { store: { name: "Ann" } })
```

`store` fills the store before the first render; the values must be JSON data.

`url` is the request's address: routers and `<Link active>` follow it on the server. The result also has `head`, the `<title>` and meta tags the pages set with [`head`](../10-reactivity/08-routing.md#titles-and-meta-tags-leaving-and-guards), to put into the document's `<head>`; `title` names the document when no page does.

## Custom elements

A [custom element](../08-components/02-custom-elements.md) takes over what was rendered inside it when it has the `hydrate` attribute:

```js
element("x-counter") component XCounter({ start }) {
    state count = start
    return <button onClick=${() => count++}>${count}</button>
}

const html = `<x-counter hydrate>${renderToString(() => XCounter({ start: 5 }))}</x-counter>`
```

## Running anywhere

The compiled output runs in the browser as is. Files without components use the core runtime, which needs no DOM at all; see [Runtimes](../15-build-and-runtime/02-runtimes.md).

The [Slim server](02-slim-server.md) does all of this for you when a page names what the browser takes over.

Next: [Slim server](02-slim-server.md).
