# Conditions and Lists

## Conditions

`cond ? <A/> : <B/>` and `cond && <A/>` build a branch again only when the condition flips. When a branch is removed, its effects stop:

```js
component Toggle() {
    state open = false
    return <div>
        <button onClick=${() => { open = !open }}>toggle</button>
        ${open ? <p>Open</p> : <p>Closed</p>}
    </div>
}

const el = Toggle()
log(el.querySelector("p").textContent) // Closed
el.querySelector("button").click()
log(el.querySelector("p").textContent) // Open
```

## Lists

`items.map(item => <li>...</li>)` keeps rows by item, or by a `key=${item.id}` on the row. Rows that stay are moved, not rebuilt; a row whose item changed in place updates only its own bindings:

```js
component Todos() {
    state todos = [{ id: 1, text: "write docs" }, { id: 2, text: "ship" }]
    return <div>
        <ul>${todos.map(todo => <li key=${todo.id}>${todo.text}</li>)}</ul>
        <button onClick=${() => todos.reverse()}>reverse</button>
    </div>
}

const el = Todos()
const first = el.querySelector("li")
el.querySelector("button").click()
log(el.querySelector("ul").textContent)        // shipwrite docs
log(el.querySelectorAll("li")[1] === first)    // true: the row was moved, not rebuilt
```

## Keeping rows that leave

A row that leaves the list is removed and its effects stop. With `keep` on the row, it is kept instead, with its DOM, state and effects, and comes back when its key returns. `keep=${50}` keeps at most 50 rows, dropping the oldest:

```js
component Chats() {
    state archived = false
    state chats = [{ id: 1, title: "a", archived: false }, { id: 2, title: "b", archived: true }]
    const shown = chats.filter(chat => chat.archived == archived)
    return <div>
        <button onClick=${() => { archived = !archived }}>switch</button>
        <ul>${shown.map(chat => <li key=${chat.id} keep>${chat.title}</li>)}</ul>
    </div>
}
```

`keep` goes on an element row; kept rows are disposed with the list.

## Raw HTML in rows

`${raw(...)}` keeps its nodes when the new HTML is the same string. In a row, a binding that calls something (`${html(parse(p.name))}`, `title=${format(p.date)}`) runs again only when the item fields it reads change, not when another field of the item does. That cutoff covers the row's item, not a component's props: in a row component, put the value in a `const` (`const name = parse(p.name)`).

## Large lists

A comparison with a state in a row, like `class=${selected == row.id ? "active" : ""}`, only runs again in the two rows whose answer changes, so selecting in a list of 10,000 rows touches two of them. A row that shows its own key (`${row.id}` in a row keyed by `row.id`) shows it once, without a binding.

In the browser, `onClick`, `onInput` and other bubbling events are handled by one listener on the document per event type, so rows add no listeners; a tree that is not in the document yet gets the same handling on its root.

## Benchmark

Keyed tables from the repository's `test/bench-react/` folder against React 18.3.1 and 19.1.0 with `React.memo` rows, on one page in Chromium, taking turns sample by sample. Median in ms, lower is better; *script* is the framework's own work, *total* adds style and layout:

| | Slim script | React 18 script | React 19 script | Slim total | React 19 total |
|---|---|---|---|---|---|
| create 1,000 rows | 6.3 | 11.5 | 10.0 | 56.1 | 57.5 |
| replace 1,000 rows | 10.8 | 22.1 | 20.3 | 64.0 | 66.3 |
| update every 10th row | 1.0 | 1.2 | 1.4 | 9.7 | 10.2 |
| select row | 0.1 | 0.7 | 1.0 | 0.1 | 1.0 |
| swap rows | 0.5 | 9.2 | 9.4 | 8.8 | 58.8 |
| remove row | 0.4 | 1.1 | 1.6 | 8.1 | 10.0 |
| create 10,000 rows | 54.1 | 334.2 | 243.1 | 551.5 | 720.2 |
| append 1,000 rows | 8.1 | 12.0 | 11.6 | 70.4 | 77.8 |
| clear 1,000 rows | 4.8 | 10.5 | 10.0 | 5.0 | 10.1 |

Most of *total* is the browser's style and layout, which costs the same for the same rows whichever framework made them; that is why it moves less than *script*.

Run it from the repository with `node test/bench-react/build.mjs` and `node test/bench-react/serve.mjs`, then open `http://localhost:5178/test/bench-react/`.

Next: [Forms](04-forms.md).
