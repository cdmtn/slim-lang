# Slim Server

`@slim/server` is a small HTTP server, a module of Slim itself (see [Slim modules](../09-imports/04-standard-library.md)). It serves pages rendered from components, JSON APIs, static files and redirects, and with `slmc server --dev` it rebuilds and reloads the page on every change.

```js
use { Server } from @slim/server
use { App } from "./app"

const server = new Server()

server.page("/", props => App(props), { hydrate: App, title: "Home" })
server.get("/user/{id}", (req, res, params) => { res.end("user " + params.id) })
server.api("/api/echo", async (data, req) => ({ received: data }))

server.start()
```

Run it with:

```bash
slmc server          # production mode
slmc server --dev    # watch, rebuild, live reload, request logs
```

The server reads its settings from [`slimserver.json`](../04-CLI/03-configuration.md#slimserverjson) next to the entry file (`slmc create --server` creates one): the port, static folders, redirects and the body limit of API routes.

## Routes

| Method | Purpose |
|---|---|
| `page(path, render, options?)` | An HTML page. `render(props)` returns markup (or a promise of it); `props` has `params`, `url` and `dev`. A render function that returns a plain object answers with JSON |
| `get(path, (req, res, params) => ...)` | A route that writes the response itself with Node's `req` and `res` |
| `api(path, (data, req) => result, options?)` | A JSON API. `data` is the parsed JSON body (or `null`), and the returned value is sent as JSON |
| `redirect([{ from, to }])` | Redirects (also set in `slimserver.json`) |
| `static([{ from, to }])` | Static folders (also set in `slimserver.json`) |
| `start()` / `stop()` | Start or stop listening |

Path segments in braces are parameters: `/user/{id}` gives `params.id`. `{...name}` takes the rest of the path, slashes included: `/files/{...path}` gives `params.path` = `a/b.txt` for `/files/a/b.txt`, and `/{...path}` answers every path. Such a route is tried last, after the other routes, the APIs and the static folders, so one page can serve a whole single-page app:

```js
server.api("/api/projects", async () => projects)
server.page("/{...path}", props => App(props), { hydrate: App })
```

`page` options:

- `hydrate`: the component (or `"module:Export"`, or the path of a browser module) the browser takes over; see below;
- `load`: for a hydrated page, a function (or a list of them) that gets the props and returns an object of store keys; see below;
- `title`: the document title, for a hydrated page the title of routes that set none with [`head`](../10-reactivity/08-routing.md#titles-and-meta-tags-leaving-and-guards);
- `icon`: the favicon URL;
- `head`: a list of `.css` and `.js` URLs to add to the page's head;
- `onload`: a function that runs in the browser when the page loads.

Pages, `get` routes and static files answer `GET` and `HEAD` (other methods get 405); `api` routes take any method, and their bodies are limited to 1 MB unless `"bodyLimit"` in `slimserver.json` or `server.api(path, handler, { limit })` says otherwise. A body that is not valid JSON gets a 400, a body over the limit a 413. Static files support ranges and caching headers. A route that throws answers 500 and the error is logged. The live-reload endpoint exists only in dev mode. There a change to a `.slim` file rebuilds and reloads the page, which keeps its address and scroll, and a change to a `.css` file swaps the page's stylesheets with that name without a reload.

## Hydrated pages

When a page has `hydrate`, it is rendered with `renderToStringAsync` inside `<div id="slim-root">` after `<!doctype html>` and the tags its pages set with `head`, the props (with the request's `url`) go to `window.__slimProps`, and the server adds a small module script that imports the component and calls `hydrate(() => App(window.__slimProps), …)`. A component given to `hydrate` must be a named export.

`load` gets the page's data before rendering. Each function gets the page's props and returns an object; several run in parallel, and the keys of what they return fill the store that [`provideData`](01-render-and-hydrate.md#waiting-for-data) reads, on the server and then in the browser:

```js
use { Server } from @slim/server
use { Profile } from "./profile"
use { db } from "./db"

const server = new Server()
server.page("/user/{id}", props => Profile(props), {
    hydrate: Profile,
    load: async ({ params }) => ({ user: await db.user(params.id) })
})
server.start()
```

`Profile` reads it with `provideData("user", () => null)`.

A loader that returns `null` adds nothing; one that returns something other than an object is ignored with a warning.

The browser loads compiled modules from `/@slim/…`. The server serves the module a page hydrates and everything it imports, and nothing else: server code and build files stay private. A browser module that no page hydrates (a script you load yourself) is listed in `clients` in `slimconfig.json`, and its imports are served with it:

```json
{
    "main": "server",
    "clients": ["widgets"]
}
```

A page that hydrates a module the build never produced fails when it is registered, with a message naming the file.

Next: [Error handling](../12-error-handling.md).
