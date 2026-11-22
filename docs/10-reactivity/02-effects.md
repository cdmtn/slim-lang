# Effects

## effect

`effect(fn)` runs after the component has its DOM, and again whenever what it read changes. A function it returns runs before the next run and when the component goes away:

```js
const runs = []

component Ticker() {
    state count = 0

    effect(() => {
        runs.push(count)
        return () => runs.push("cleanup")
    })

    return <button onClick=${() => count++}>${count}</button>
}

const el = Ticker()
el.click()
log(runs.join(" ")) // 0 cleanup 1
```

An async effect only tracks what it reads before its first `await`. Effects don't run on the server; after server rendering they start in the browser when the page is [hydrated](../11-server-rendering/01-render-and-hydrate.md).

## watch

`watch(() => source, (value, previous) => ...)` reacts only to what `source` reads. The callback runs once right away (with `previous` undefined), then each time the source changes:

```js
const seen = []

component Pager() {
    state query = ""
    state page = 1

    watch(() => page, (value, previous) => {
        seen.push(`${previous}->${value}`)
    })

    return <div>
        <button class="type" onClick=${() => { query = query + "a" }}>type</button>
        <button class="next" onClick=${() => page++}>next</button>
    </div>
}

const el = Pager()
el.querySelector(".type").click()   // query changes: the watch doesn't run
el.querySelector(".next").click()
log(seen.join(", ")) // undefined->1, 1->2
```

## untrack and batch

`untrack(() => ...)` reads without subscribing, and `batch(() => ...)` applies several changes as one update.

Event handlers are batched already, those in markup and those added with `listen`: two assignments in one click update the DOM once, after the handler returns, so the DOM read inside the handler right after an assignment still shows the old value:

```js
const runs = []

component Pair() {
    state a = 1
    state b = 1
    effect(() => { runs.push(a + b) })
    return <button onClick=${() => { a = 10; b = 20 }}>${a + b}</button>
}

const el = Pair()
el.click()
log(runs.join(","), el.textContent) // 2,30 30
```

## Lifecycle callbacks

Besides effects, a component can register:

- `onMount(fn)`: runs with the element once the markup is built;
- `onConnect(fn)`: runs when the element is added to the document;
- `onUnmount(fn)`: runs when it is removed.

Next: [Conditions and lists](03-conditions-and-lists.md).
