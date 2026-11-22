# Dev Server

`slmc server --dev` (or `"dev": true` in `slimserver.json`) builds the project, runs it, and watches it. On a change to a `.slim` file it rebuilds, restarts the program and reloads the open pages; requests are logged. `node_modules`, the output folder and `.git` are ignored.

A change to a `.css` file doesn't restart anything: the open pages load the stylesheet again in place, so the page keeps its state and scroll. The `<link rel="stylesheet">` tags whose file has the changed file's name are swapped; when none has it, every stylesheet on the page is.

```bash
slmc server --dev
```

Point the watcher at a specific folder with the `watch` key in `slimconfig.json`:

```json
{
    "main": "index",
    "watch": "src"
}
```

Rebuilds are incremental, as with `slmc build`. A change to `slimconfig.json` or `slimserver.json` also rebuilds and restarts the server.

`slmc run --dev` runs the program once with the same dev features (`SLIM_DEV=1`), without watching.

See [Slim server](../11-server-rendering/02-slim-server.md) for writing the server itself.

Next: [Formatter and REPL](05-formatter-and-repl.md).
