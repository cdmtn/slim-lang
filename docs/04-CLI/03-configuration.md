# Configuration

A Slim project is configured by `slimconfig.json` in the project root. `slmc init` and `slmc create --config` create it, and `slmc config` reads and edits it:

```bash
slmc config                         # print the whole config
slmc config -K main                 # print one key
slmc config -S main=index           # set a key
slmc config -R watch                # remove a key
```

A minimal config only names the entry file:

```json
{
    "main": "index"
}
```

## Keys

| Key | Default | Meaning |
|---|---|---|
| `main` | — | The entry file, without `.slim`. It is compiled to `<dist>/<main>.js` together with every file it imports |
| `names.dist` (or `dist`) | `"slim-dist"` | Output folder. It must be a folder inside the project. When both are set, `names.dist` wins |
| `names.packages` (or `packages`) | `"packages"` | Folder that `spm` installs packages into and `@name` imports resolve from. When both are set, `names.packages` wins |
| `uses.enabled` | `true` | Allows `use` imports. With `false`, a `use` is a build error |
| `uses.style` | `"import"` | How `use name from "module"` is read: `"import"` makes a bare name a default import, like JavaScript; `"named"` reads it as `use { name }` |
| `check` | `true` | Static type checking. `false` (or `slmc build --no-check`) turns it off |
| `warnings` | `true` | Show warnings in the terminal during a build: compiler warnings (unused names, unreachable code) and build warnings such as a circular `use`. `false` hides them all; errors are always shown. `slmc init` and `slmc create --config` write it as `true` |
| `sourceMaps` | `"inline"` | `"inline"` puts the source map in the compiled file, `"file"` writes `index.js.map` next to it, `false` leaves it out |
| `release` | `false` | [Release mode](../15-build-and-runtime/01-release-mode.md): leave implicit runtime type checks out of the output |
| `globals` | `[]` | Names that come from elsewhere (other scripts on the page). See [Host declarations](../14-static-checking/05-host-declarations.md) |
| `host` | — | A `.slim` file with `global` lines and traits that every file sees. See [Host declarations](../14-static-checking/05-host-declarations.md) |
| `runtime` | `"globals"` | `"imports"` makes each compiled file import the runtime functions it uses instead of putting them on `globalThis`. See [Runtimes](../15-build-and-runtime/02-runtimes.md) |
| `autoImport` | `false` | Import names from the project files that export them without writing `use`. See [Auto import](../09-imports/03-auto-import.md) |
| `jsdoc` | `false` | Add JSDoc to the compiled JavaScript for editors and `tsc --checkJs`. See [TypeScript](../15-build-and-runtime/03-typescript.md) |
| `declarations` | `false` | Write a `.d.ts` file next to each compiled module |
| `watch` | `"."` | Folder that the dev server watches (and that `autoImport` scans) |
| `clients` | `[]` | Browser modules that no page hydrates but that the Slim server should serve. See [Slim server](../11-server-rendering/02-slim-server.md) |

A full example:

```json
{
    "main": "src/index",
    "names": {
        "dist": "slim-dist",
        "packages": "packages"
    },
    "uses": {
        "style": "import",
        "enabled": true
    },
    "watch": "src",
    "globals": ["YurbaLib"],
    "runtime": "imports",
    "sourceMaps": "file",
    "jsdoc": true
}
```

## slimserver.json

The [Slim server](../11-server-rendering/02-slim-server.md) reads `slimserver.json` from the folder of the entry file. `slmc create --server` creates one:

```json
{
    "port": 3000,
    "dev": false,
    "statics": [{ "from": "/public", "to": "./public" }],
    "redirects": [{ "from": "/github", "to": "https://example.com" }]
}
```

| Key | Default | Meaning |
|---|---|---|
| `port` | `3000` | Port to listen on |
| `dev` | `false` | Dev mode (watch, rebuild, live reload, request logs), the same as `slmc server --dev` |
| `statics` | `[]` | Folders served as static files: `from` is the URL prefix, `to` the folder |
| `redirects` | `[]` | Redirects: `from` is the path, `to` the target URL |
| `bodyLimit` | `1048576` | Largest accepted body of an `api` route, in bytes |

## Environment variables

| Variable | Effect |
|---|---|
| `SLIM_DEV=1` | Puts the [Slim server](../11-server-rendering/02-slim-server.md) in dev mode (set by `slmc run --dev` and `slmc server --dev`) |
| `SLIM_RELEASE=1` | Skip runtime type checks: at build time it leaves them out of the output, at run time it skips them in output built without release mode |
| `SLIM_NO_CHECK=1` | Skip static checking (set by `--no-check`) |
| `SLIM_FORCE=1` | Ignore the build cache (set by `slmc build --force`) |

Next: [Enums](../05-enums/01-creating.md).
