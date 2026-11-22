# Portals and Refs

## Portals

`<Portal>` shows its children somewhere else in the page, a modal in `document.body` for example. They still belong to the component that wrote them and go away with it:

```js
component Dialog({ onClose }) {
    return <div class="dialog"><button onClick=${onClose}>close</button></div>
}

component Page() {
    state open = true
    return <main>
        ${open && <Portal to="#modals"><Dialog onClose=${() => { open = false }} /></Portal>}
    </main>
}
```

`to` is a selector or an element; without it the children go to `document.body`. `position` says where in it: `"append"` (the default), `"prepend"`, or `"before"`/`"after"` to put the children next to `to` instead of inside it. Both can change, and the children move:

```js
component Dock({ header }) {
    state docked = true
    return <Portal to=${docked ? header : document.body} position=${docked ? "after" : "append"}>
        <div class="dock"><button onClick=${() => { docked = !docked }}>move</button></div>
    </Portal>
}
```

A portal renders nothing on the server.

## Refs and element methods

`ref` hands an element to a variable, a field or a function as the markup is built, before `onMount` runs:

```js
component Search() {
    let input
    onMount(() => input.focus())
    return <form><input ref=${input}><i ref=${node => log(node.tagName)}></i></form>
}

Search() // I
```

`expose` puts methods and getters on the component's element, so code outside it can call them. They are there before any `onMount` callback runs:

```js
component ChatRow({ dialog }) {
    state unread = dialog.Unread
    expose({
        setUnread(count) { unread = count },
        get unread() { return unread }
    })
    return <a class="chat">${dialog.Name} <b>${unread}</b></a>
}

const row = ChatRow({ dialog: { Name: "Ada", Unread: 0 } })
row.setUnread(3)
log(row.unread, row.querySelector("b").textContent) // 3 3
```

Next: [Server rendering](../11-server-rendering/01-render-and-hydrate.md).
