# Routing

`<Router>` shows the page for the current path; `<Link>` and `navigate()` change it without a reload, and the back button works. They come from `@slim/router`, a module of Slim itself:

```js
use { Router, Link } from @slim/router

component Home() {
    return <h1>Home</h1>
}

component User({ params }) {
    return <h1>User ${params.id}</h1>
}

component NotFound() {
    return <h1>Not found</h1>
}

const routes = {
    "/": Home,
    "/users/:id": User,                      // User({ params: { id: "7" } })
    "/admin": () => import("./admin.js"),
    "*": NotFound
}

component App() {
    return <main>
        <nav><Link href="/users/7" active="current">Ann</Link></nav>
        <Router routes=${routes} />
    </main>
}
```

- A page gets `params`, `query`, `path` and `hash`, and `data` and `error` when its route [loads data](#loading-data-for-a-route).
- Moving between paths of the same route (`/users/7` to `/users/8`) keeps the page and updates its params.
- A route can be a function that imports a module; the module is loaded the first time the route is opened, and its default export (or its first exported component) is the page.
- `"*"` matches any path that no other route matches.
- A parameter ending in `?` at the end of a pattern may be left out: `"/users/:id/:tab?"` matches `/users/7` (no `tab` in `params`) and `/users/7/posts`.
- `route()` reads the current path, query, params, hash and `base` (the part of the path the page matched) anywhere. Called while a component renders, it keeps reading that page: `const page = route()` in the body, `page.params.id` in a handler later.
- `active` names a class a link has while it points at the current path. With `prefix` it also has it below that path (`/projects` for `/projects/7`); `match=${"/projects/*"}` takes a pattern or a list of them instead. A link with a query, like `?tab=2`, is active only while the query has those values.
- `navigate("/users/8")` changes the path from code; `navigate(path, { replace: true })` replaces the current history entry instead of adding one.
- `navigate(path, { reload: true })` builds the page again even when the path doesn't change.
- `navigate(path, { replace: true, silent: true })` rewrites the address, for example to a canonical one, and keeps the page as it is.
- `navigate(path, { state })` stores `state` in the history entry. Without `state`, a push stores `null` and a replace keeps the state the entry had. The route a page gets (and `route()`) has it as `state`, along with the route's `pattern`. Two history entries with the same address but different `state` are told apart: back and forward between them route again, so a `keepBy` that reads `state` shows the right page, and so does `navigate` to the address on screen with a new `state`.
- A route that loads a module keeps the old page on screen until the new one is ready. When another navigation comes first, the late module is not shown. When the module fails to load, the router shows its `fallback` (the page's error is in `route().error`) and tries the module again on the next visit.
- After a navigation the window scrolls to the element the hash names, or to the top; `navigate(path, { scroll: false })` leaves it. The hash stays in the address, and a back or forward that only changes the hash doesn't route again.

On the server the router follows the request's address: `server.page` passes it, and so does `renderToStringAsync(render, { url })`. `<Router url=${url} />` sets it by hand. `url` counts only while rendering on the server: in the browser the router reads the address, so the component the server rendered with `url` can be hydrated with the same props and still follow navigation.

[examples/spa](../../examples/spa) is a whole single-page app on the [Slim server](../11-server-rendering/02-slim-server.md): nested routers, kept pages, a guard, `onLeave`, titles, data from an API, and every path rendered on the server and hydrated.

## A section of a bigger site

A router can run one section of a site whose other pages come from the server:

```js
const projects = {
    "/": ProjectList,              // /projects
    "/:id": Project                // /projects/7
}

component ProjectsWindow() {
    return <div class="window">
        <Router base="/projects" routes=${projects} intercept />
    </div>
}
```

- With `base`, routes match the path below it, and links and `navigate` keep full paths (`/projects/7`).
- A path outside the base, or one that no route matches, loads as a normal page: `<Link>` and `navigate` leave it to the browser instead of showing `"*"`. The same holds for a router without `base` and without `"*"`.
- `intercept` also routes clicks on plain `<a href>` inside the router's pages, such as links in HTML from an API. A plain link outside the pages, in a header for example, is still followed by the browser: use `<Link>` there. Clicks with a modifier key, `target`, `download`, `rel="external"`, another origin, or an earlier `preventDefault` are left alone, and so are links inside an element that `ignore` names with a selector: `<Router intercept ignore=".editor" />`.

## Tabs in the query

`query` routes by one query parameter, on the page the router was opened on (or on `base`):

```js
const tabs = { "/": Profile, "profile": Profile, "security": Security }

component Settings() {
    return <section>
        <Link href="?page=security" active="on">Security</Link>
        <Router query="page" routes=${tabs} />
    </section>
}
```

`/settings?page=security` shows `Security`; `/settings` with no `page` uses the `"/"` route.

## Routers inside pages

A page whose route ends in `*` can have a router of its own for the rest of the path:

```js
const projectPages = {
    "/": Overview,                    // /projects/7
    "/files": Files,                  // /projects/7/files
    "/settings": ProjectSettings      // /projects/7/settings
}

component Project({ params }) {
    return <div class="project">
        <h1>Project ${params.id}</h1>
        <nav>
            <Link href="files" active="on">Files</Link>
            <Link href="settings" active="on">Settings</Link>
        </nav>
        <Router routes=${projectPages} />
    </div>
}

const routes = {
    "/": Home,
    "/projects/:id/*": Project
}
```

- A router inside a page routes the path below what the page matched: here `/projects/7`. A `base` given to it is a full path, as for any router.
- Its pages get the params of the pages around them too: `Files` reads `params.id`.
- Moving from `/projects/7/files` to `/projects/7/settings` changes only the inner page; `Project` stays as it is.
- A `<Link>` inside a page takes an `href` without a leading `/` from that page's path: `files` in `Project` is `/projects/7/files`, and `../8` is `/projects/8`. Its `href` attribute holds the full path.
- `navigate` takes a path as a browser link does. For a path from the page, keep `route()` from the body and use its `base`: ``navigate(`${page.base}/files`)``.
- On the server the inner router takes the path from the one around it, so only the outer `<Router>` needs `url`.

## Keeping pages

A page you leave is removed, and coming back builds it again. `keep` names the routes whose pages are kept instead:

```js
<Router routes=${routes} keep=${["/feed", "/messages/:chat"]} max=${5} />
```

- A kept page is taken off the screen but not removed: its state, effects and elements stay, so text in its fields and loaded data are there when you come back. The scroll position of the window and of the elements inside the page is saved and restored.
- Its elements are taken out of the document while it is hidden, so custom elements of other libraries run their disconnect and connect callbacks.
- Each path is kept apart: `/messages/1` and `/messages/2` are two pages, each with its own draft. A change of the query keeps the same page.
- A route ending in `*` is kept by the part of the path its pattern matched: with `"/photos/*"`, `/photos/albums` and `/photos/albums/3` are one kept page, and the router inside it follows the rest of the path.
- `keep` alone keeps every route; a string names one route.
- `max` is how many hidden pages are kept, 10 when left out. Past it, the page opened longest ago is removed for good.
- `navigate(path, { reload: true })` builds the kept page at that path again; the other kept pages stay.
- `onVisit(match => ...)` runs after every navigation that ends with the page on screen: when it is opened, opened again while it is already shown, or reached with the back and forward buttons. `onShow` runs only when a kept page comes back from hidden.
- `forget(path)` drops the hidden kept page at that path, so it is built again the next time it is opened. The page on screen is left alone.
- `keepBy=${match => ...}` chooses what a kept page is kept by instead of its path. With `keepBy=${match => match.pattern}`, `/video/1` and `/video/2` are one page whose `params` follow the address. `keepBy=${match => match.state?.key ?? match.path}` keeps a page by a key stored with `navigate(path, { state: { key } })`, so it is found again after its address was rewritten; `forget(path)` calls `keepBy` with no state.
- On the server `keep` changes nothing.

A kept page that does something in the background stops it while it is hidden:

```js
use { onHide, onShow } from @slim/router

component Feed() {
    let timer = setInterval(refresh, 30000)
    onHide(() => clearInterval(timer))
    onShow(() => {
        refresh()
        timer = setInterval(refresh, 30000)
    })
    return <section>...</section>
}
```

- `onHide` runs when the page is taken off the screen and kept, `onShow` when it comes back. They also run for the pages of routers inside it.
- They can be called in any component inside the page. In a page that isn't kept they never run: the page is removed instead, and `onCleanup` and `onUnmount` run as usual.
- A `<video>` or `<audio>` taken out of the document is paused by the browser; start it again in `onShow` if it should go on.

## Loading data for a route

A route can be `{ page, load }` instead of a component. The router calls `load` before it shows the page, and the page gets what it returns as `data`:

```js
use { Router } from @slim/router

component Project({ data }) {
    return <h1>${data.name}</h1>
}

const routes = {
    "/projects/:id": {
        page: Project,
        load: ({ params, signal }) => fetch(`/api/projects/${params.id}`, { signal }).then(r => r.json())
    }
}
```

- `load` gets `params`, `query`, `path`, `state` and `signal`, an `AbortSignal` that is aborted when another navigation comes before the data. A promise is waited for.
- The page on screen stays until the data comes, the same as with a route that imports a module; `page` can be such an import too, and both load at once. On the first page there is nothing to keep, so the router shows its `fallback`.
- `navigating()` is `true` while a router waits for data or a module, for a progress bar: `${navigating() ? <Spinner /> : null}`.
- When `load` throws or its promise fails, the page is shown with `error` and no `data`.
- `load` runs again when the params or the query change, and after `navigate(path, { reload: true })`. A page that isn't kept loads again each time it is opened; a kept page keeps its data while it is hidden and gets it back with the page.
- `route().data` and `route().error` read it in any component of the page.
- On the server the page is rendered after its data has come, and the data goes to the browser with the page, so hydration doesn't load it again. It has to be JSON there.
- A router inside a page loads after that page has its data, so nested routes load one after another, not at once.

## Titles and meta tags, leaving and guards

`head(values)` sets the document's title and meta tags while the page is shown:

```js
use { head } from @slim/router

component Project({ data }) {
    head(() => ({
        title: `${data.name} — Projects`,
        description: data.summary,
        meta: { "og:title": data.name, "og:image": data.cover },
        link: { canonical: `https://example.com/projects/${data.id}` }
    }))
    return <h1>${data.name}</h1>
}
```

- `title` is the tab's title and `description` is `<meta name="description">`. `meta` names other `<meta>` tags; names starting with `og:`, `fb:`, `article:` and the like are written as `property`, the rest as `name`. `link` sets `<link rel>` tags by their `rel`.
- It takes the values or a function, and a function is followed like markup.
- Calls stack: one in `App` sets what every page has, and a page's own `head` overrides it while the page is shown. When the page goes, its tags go with it and the ones under it are back; a tag nobody sets anymore is removed, or put back the way it was in the HTML.
- A hidden kept page's tags step aside and come back when it is shown again.
- `head` writes a tag only when its own value changes, so a title the page sets itself with `document.title` stays until `head` gives a new one.
- On the server the tags are rendered into the page's `<head>`, so search engines and link previews see them without running the script. A `title` given to `server.page` is the title of pages that don't set one.
- `title(text)` is the short form of `head({ title: text })`.

`onLeave(fn)` is asked before a navigation leaves the page. `fn` gets the path it goes to, and returning `false` stays on the page:

```js
use { onLeave } from @slim/router

component Editor() {
    state dirty = false
    onLeave(to => !dirty || confirm("Leave without saving?"))
    return <textarea onInput=${() => dirty = true}></textarea>
}
```

- It covers `navigate`, `<Link>`, intercepted links and the back and forward buttons; for those the address is put back.
- `navigate` returns `false` when a page stayed. `navigate(path, { force: true })` doesn't ask.
- Moving within the same page (`/users/7` to `/users/8`) doesn't ask; leaving a kept page does.
- Closing or reloading the tab is not covered: use `listen(window, "beforeunload", e => { if (dirty) e.preventDefault() })`.

`guard` on a router decides whether a route may be shown. It gets the route about to be shown (`path`, `params`, `query`, `pattern`) and returns `true` to show it or a path to go to instead, which replaces the history entry. `false` keeps the page that is on screen, but the address has already changed, so a path is usually the better answer:

```js
<Router routes=${routes} guard=${match => !match.path.startsWith("/admin") || signedIn || "/login"} />
```

## Types

The module has types, so a mistake in a router is a compile error: `<Router kepp />` gets `has no prop "kepp" — did you mean "keep"?`, `<Link>` without `href` is an error, and `navigate(5)` expects a string. Its traits can be imported too: `RouterProps`, `LinkProps`, `NavigateOptions`, `RouteMatch` (what `route()` gives), `PageProps` (what a page gets), `RouteConfig` (a route with `load`), `LoadArgs` (what `load` gets) and `HeadValues` (what `head` takes).

Next: [Portals and refs](09-portals-and-refs.md).
