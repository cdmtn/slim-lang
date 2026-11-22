# Animations

`enter="name"` puts a class on an element while it appears and takes it off when its animation ends. `leave="name"` puts a class on when it is removed and removes the element once its animations finish:

```js
component Panel() {
    state open = false
    return <div>
        <button onClick=${() => { open = !open }}>toggle</button>
        ${open && <div class="panel" enter="fade-in" leave="fade-out">Hello</div>}
    </div>
}
```

```css
.fade-in { animation: fade 150ms reverse }
.fade-out { animation: fade 150ms forwards }
@keyframes fade { to { opacity: 0 } }
```

`move` (or `move="300"`, in ms) makes a row slide to its new place when its list is reordered:

```js
component Playlist() {
    state items = [{ id: 1, name: "a" }, { id: 2, name: "b" }]
    return <div>
        <ul>${items.map(item => <li key=${item.id} move>${item.name}</li>)}</ul>
        <button onClick=${() => items.reverse()}>shuffle</button>
    </div>
}
```

Next: [Routing](08-routing.md).
