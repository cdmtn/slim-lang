# Loading Data

`resource(loader)` loads data, and loads again when what the loader read before its first `await` changes. A slower, older answer never replaces a newer one:

```js
struct User {
    name: string
}

const api = {
    user: async (id: string) -> User => User.new({ name: `user ${id}` })
}

component Profile({ id }) {
    const user = resource(() => api.user(id))
    return <section>
        ${user.loading ? <p>Loading…</p> : user.error ? <p>${user.error.message}</p> : <h2>${user.value.name}</h2>}
    </section>
}
```

A resource has:

- `loading`: true while the loader runs;
- `error`: the error the loader threw, if any;
- `value`: the loaded value. Assigning `user.value` shows a value right away (an optimistic update);
- `reload()`: loads again on demand.

## With a source

With a source, only the source is tracked and the loader is called with its value. This is the form to use with [server rendering](../11-server-rendering/01-render-and-hydrate.md), where the data comes with the page and nothing is loaded twice:

```js
const api = {
    user: async (id: string) => ({ name: `user ${id}` })
}

component Profile({ id }) {
    const user = resource(() => id, id => api.user(id))
    return <h2>${user.value?.name ?? "…"}</h2>
}
```

Without a source, a hydrated page shows the server's data at once, and the loader runs once more in the background so the resource knows what it reads.

## Pages

`resource.pages(source, loader)` loads a list page by page, for infinite scroll. The loader gets the source value and a cursor (`undefined` for the first page) and returns `{ items, next }`; a `next` of `null` or `undefined` means there are no more pages:

```js
const api = {
    feed: async (query: string, page = 0) => ({ items: [`${query} ${page}`], next: page < 4 ? page + 1 : null })
}

component Feed({ query }) {
    const feed = resource.pages(() => query, (query, page) => api.feed(query, page))
    return <section>
        <ul>${feed.items.map(item => <li>${item}</li>)}</ul>
        ${feed.done ? null : <button onClick=${() => feed.more()}>${feed.loading ? "…" : "more"}</button>}
    </section>
}
```

It has `items` (every loaded item), `pages`, `loading`, `error`, `done`, `reload()` and `more()`. `more()` loads the next page and resolves to `true` when one was added; it does nothing while a page loads or after the last one. When the source changes, the list starts over from the first page, and a page still loading for the old source is dropped. The first page comes with server rendering like any resource.

Next: [Context and errors](06-context-and-errors.md).
