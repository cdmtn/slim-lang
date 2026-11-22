# Slim SPA example

A single-page app on Slim's server and router. From this folder:

```bash
slmc server --dev
```

and open http://localhost:3100.

- `server.slim`: one catch-all page (`/{...path}`) that renders and hydrates `App`, and the API it reads.
- `app.slim`: the router. Home and the projects are kept pages, a project has its own router for its tabs, the projects load their data in their routes, pages set their title and meta tags with `head`, the editor asks before it is left with unsaved text, and `/admin` is guarded.
- `api.slim`: reads the data directly on the server and through the API in the browser.
