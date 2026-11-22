# State

`state name = value` declares a reactive variable. It goes at the top of a component body, a `use...` function or a module. Assign it, increment it, or change it in place: `items.push(x)`, `items[i].done = true` and `user.name = "x"` all update what reads it.

```js
component Counter() {
    state count = 0
    return <button onClick=${() => count++}>${count}</button>
}

const el = Counter()
el.click()
el.click()
log(el.textContent) // 2
```

A typed state (`state count: int = 0`) is checked like a typed `let`.

## Equal values

An assignment updates the page only when the new value is not `Object.is` the old one. `with equals(fn)` sets your own comparison; it gets the old and the new value and returns `true` when they count as the same:

```js
const sameSet = (a: string[], b: string[]) => a.length == b.length && a.every(x => b.includes(x))

component Speakers() {
    state speakers: string[] = [] with equals(sameSet)
    expose({ set(list) { speakers = list } })
    return <p>${speakers.join(", ")}</p>
}

const el = Speakers()
el.set(["ann", "bob"])
el.set(["bob", "ann"])  // same set: nothing updates
log(el.textContent)     // ann, bob
```

A change in place (`speakers.push(x)`) always updates.

## Derived values

A `const` that reads a state or props is recomputed when they change, at most once per change and only while something reads it. That covers reads in `items.filter(...)` and other array callbacks, in a function called right there, and destructuring (`const { name } = user`):

```js
component Todo() {
    state items = [{ text: "a", done: true }, { text: "b", done: false }]
    const left = items.filter(item => !item.done).length

    return <div>
        <span>${left} left</span>
        <button onClick=${() => { items[1].done = true }}>finish</button>
    </div>
}

const el = Todo()
log(el.querySelector("span").textContent)   // 1 left
el.querySelector("button").click()
log(el.querySelector("span").textContent)   // 0 left
```

Changing a derived `const` in place is a compile error: it is recomputed, so the change would be lost.

## Props stay live

`Badge({ count: items.length })` passes the current value on every read, so `Badge` updates its text without running again. This works for destructured props too; a default is made once per component:

```js
component Badge({ count, label = "items" }) {
    return <span title=${count}>${count} ${label}</span>
}

component Cart() {
    state items: string[] = []
    return <div>
        <Badge count=${items.length} />
        <button onClick=${() => items.push("x")}>add</button>
    </div>
}

const el = Cart()
el.querySelector("button").click()
log(el.querySelector("span").textContent) // 1 items
```

## State in functions

A function named `use...` can hold `state` and `effect`s, and each component that calls it gets its own. A `const` that holds what such a function returns counts as reactive, so a getter keeps the values live:

```js
func useCounter(start: () => int) {
    state count = start()
    return { get value() { return { count, inc: () => count++ } } }
}

component Clicks() {
    const counter = useCounter(() => 0)
    const { count, inc } = counter.value
    return <button onClick=${inc}>${count}</button>
}

const el = Clicks()
el.click()
log(el.textContent) // 1
```

## Shared state

A `state` at the top of a module is shared by every component that reads it, in that module and in the modules that `use` it. Importers read and assign it like their own:

```js
// cart.slim
export struct Item {
    name: string
    price: int
}

export state items: Item[] = []
export const total = items.reduce((sum, item) => sum + item.price, 0)

// index.slim
use { items, total } from "./cart"

component CartBadge() {
    return <span>${items.length} items, ${total} €</span>
}

const badge = CartBadge()
items.push({ name: "book", price: 12 })
log(badge.textContent) // 1 items, 12 €
```

## Changes the compiler can't see

A change written through the state's name (`dialogs[0].unread = 5`) updates the page. A change made through another reference, such as a function parameter or a module that holds the same object, is invisible. Call `touch(object)` after it: the states that hold the object (directly or as an array element) and the list rows whose item it is update. It returns the object:

```js
func markRead(dialog) {
    dialog.unread = 0
    touch(dialog)
}

component Dialogs() {
    state dialogs = [{ id: 1, unread: 3 }]
    return <ul>${dialogs.map(d => <li key=${d.id} onClick=${() => markRead(d)}>${d.unread}</li>)}</ul>
}
```

Assigning a copy (`dialogs = [...dialogs]`) does not refresh rows whose item is the same object: rows are kept by identity, so a copy that only reorders or filters stays cheap. Use `touch` for the changed items.

## What the compiler checks

An event handler knows its event: `onInput=${e => age = e.target.value}` with `state age: int` is an error, `e.target.value` is a string. A change through a copy of a state is an error too, since it would not update the page:

```js
component List() {
    state items: string[] = []
    const add = (x: string) => {
        const list = items
        list.push(x)            // ❌ "list" holds the state "items": a change through "list" doesn't update the page
    }
    return <button onClick=${() => add("a")}>${items.length}</button>
}
```

Next: [Effects](02-effects.md).
