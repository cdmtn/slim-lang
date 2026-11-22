# Reactivity

A `state` is a variable whose changes show up wherever it is read. A component runs once; Slim compiles its markup into a template that is cloned per use, and each `${...}` into a binding that updates only its own text node or attribute. There is no virtual DOM to build and compare.

```js
component Counter() {
    state count = 0
    state items: string[] = []
    const double = count * 2           // recomputed when count changes

    effect(() => {
        document.title = `Clicks: ${count}`
    })

    return <div>
        <button onClick=${() => count++}>${count} × 2 = ${double}</button>
        <button onClick=${() => items.push("item " + count)}>add</button>
        ${count > 5 ? <p>That's a lot</p> : null}
        <ul>${items.map(item => <li>${item}</li>)}</ul>
    </div>
}
```

In short:

- **`state name = value`** goes at the top of a component body. Assign it, increment it, or change it in place: `items.push(x)`, `items[i].done = true` and `user.name = "x"` all update what reads it.
- **A `const` that reads a state or props** is recomputed when they change.
- **`effect(fn)`** runs after the component has its DOM, and again whenever what it read changes.
- **Event handlers** are batched: two assignments in one click update the DOM once.
- **Conditions and lists** build a branch or a row again only when they have to.

## Pages in this section

- [State](01-state.md): state, derived values, live props, state in functions, shared state
- [Effects](02-effects.md): `effect`, `watch`, `untrack`, `batch` and lifecycle callbacks
- [Conditions and lists](03-conditions-and-lists.md): branches, keyed lists and large lists
- [Forms](04-forms.md): `bind:value`, `bind:checked` and `createForm`
- [Loading data](05-loading-data.md): `resource`
- [Context and errors](06-context-and-errors.md): `provide`, `inject` and `catchError`
- [Animations](07-animations.md): `enter`, `leave` and `move`
- [Routing](08-routing.md): `Router`, `Link`, `navigate` and `route`
- [Portals and refs](09-portals-and-refs.md): `Portal`, `ref` and `expose`

Components can also be rendered on the server and taken over in the browser: see [Server rendering](../11-server-rendering/01-render-and-hydrate.md).

Next: [State](01-state.md).
