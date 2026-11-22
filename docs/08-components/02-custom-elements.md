# Custom Elements

Mark a component as `element` to compile it as both a custom element and a function. `Tab` becomes `slim-tab`, `TabBar` becomes `slim-tab-bar`, and the tag is available as `Tab.tag`:

```js
element component Tab(props) {
    onMount((host) => {
        host.setLabel = (text) => { host.querySelector(".label").textContent = text }
    })

    onConnect((host) => { log("in the document") })
    onUnmount((host) => { log("removed") })

    return <div class="tab"><span class="label">${props.label}</span></div>
}

log(Tab.tag) // slim-tab
```

```html
<slim-tab label="Overview"></slim-tab>
```

The host element is the mount target, and `onMount` receives it. In this example, `host.setLabel` becomes a method of `<slim-tab>`: `document.querySelector("slim-tab").setLabel("…")`.

`onConnect` runs on every `connectedCallback`. `onUnmount` runs when the element is removed and still out of the document once the task ends, so moving it to another parent is not a removal. A removed element is disposed, and if it comes back it renders again from its props, into the same host. Add listeners to the host with `listen(host, ...)`, not `addEventListener`: `listen` removes them with the component, so they don't pile up when it renders again. With the `keep-alive` attribute or `keepAlive()`, it keeps its state instead: `onUnmount` and `onConnect` then run on every removal and return.

## Attributes of the element itself

Markup that starts with `<host>` describes the custom element itself: the attributes of `<host>` go on the element, with their bindings, and what is inside `<host>` becomes its content.

```js
element("pinned-bar") component PinnedBar() {
    state pins: string[] = []
    return <host class="pinned ${pins.length > 1 ? "many" : ""}" hidden=${pins.length == 0}>
        <span>${pins[0] ?? ""}</span>
    </host>
}
```

`class=` on `<host>` changes only its own classes, so classes the page adds to the element stay. `<host>` is only for element components; in a plain component it is a compile error.

## Choosing the tag name

`element("name")` sets the tag name yourself:

```js
element("empty-state") component EmptyState({ icon }) {
    return <div class="empty">${icon}</div>
}

log(EmptyState.tag) // empty-state
```

Both forms give the custom element itself, with its methods ready:

```javascript
EmptyState({ icon: "inbox" })         // <empty-state>, rendered
document.createElement("empty-state") // <empty-state>, rendered once it gets props, is connected or upgraded
```

## Methods of the element

Interpolating a component keeps its DOM node, including its methods and listeners:

```js
component SideLeft(props) {
    onMount((el) => { el.setActive = (id) => { el.dataset.active = id } })
    return <nav class="side-left">${props.items}</nav>
}

element("music-left") component MusicLeft() {
    return ${SideLeft({ items: ["Liked", "Recent"] })}
}
```

The nav is placed inside the host, so the method is on the nav: `MusicLeft().querySelector("nav").setActive(…)`. To put methods on the custom element itself, set them on the host in `onMount` or use [`expose`](../10-reactivity/09-portals-and-refs.md#refs-and-element-methods).

## Props

Props can come from attributes or the `props` property. Properties take precedence, accept any value, and update the element when reassigned. Values set before the element upgrades are preserved:

```javascript
const tab = document.createElement("slim-tab")
tab.props = { label: "Overview", items: [1, 2, 3] }
document.body.append(tab)
```

In markup, an object, array or function given to a custom element's attribute goes to its props, not to a text attribute, and the markup written inside the tag arrives as `props.children`:

```js
component Feed({ post }) {
    return <wall-post post=${post}><span>pinned</span></wall-post>
}
```

A tag renders the first time it gets `props`, is connected, or is reached by `upgrade(root)`. A component upgrades the tags in its own markup before its `onMount` runs, so their methods are there. `upgrade(root)` does the same for markup built some other way, such as `innerHTML`, also while `root` is not in the document. Reassigning `props` or changing an attribute updates the bindings that read them; state inside the tag is kept.

## Server rendering and hydration

With the `hydrate` attribute, a custom element takes over the markup rendered inside it on the server instead of building it again; see [Server rendering](../11-server-rendering/01-render-and-hydrate.md#custom-elements). On the server or in an embedded engine, registration is skipped and the component remains a function.

Next: [Markup](03-markup.md).
