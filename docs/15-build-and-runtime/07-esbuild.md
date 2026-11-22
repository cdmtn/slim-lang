# esbuild

`@slim-lang/core/esbuild` is an esbuild plugin: esbuild bundles `.slim` files directly, and the whole project is type-checked before each build.

```javascript
import * as esbuild from "esbuild"
import { slim } from "@slim-lang/core/esbuild"

await esbuild.build({
    entryPoints: ["src/main.slim"],
    outdir: "dist",
    bundle: true,
    format: "esm",
    plugins: [slim({ root: import.meta.dirname })]
})
```

esbuild itself is not a dependency of Slim: install it in the project (`npm i -D esbuild`).

## Options

| Option | Meaning |
|---|---|
| `root` | the project folder: `slimconfig.json`, `packages/` and `node_modules/` are looked up there. The working directory when left out |
| `files` | the `.slim` files to check, as a list or a function that returns one. Every `.slim` file under `root` when left out |
| `host` | a `.slim` file with `global` lines for every file, as in [slimconfig.json](../04-CLI/03-configuration.md) |
| `release` | `true` leaves out the runtime type checks, as in [release mode](01-release-mode.md) |
| `globals` | names that come from elsewhere |
| `autoImport` | `true` imports names exported by the project's files where they are used, as in [Auto-import](../09-imports/03-auto-import.md); a folder or a list of folders limits it to those |
| `check` | `false` skips the type check |
| `passes` | the most times the check goes over the project, 8 when left out |

## What happens in a build

Before each build the plugin checks every file in `files`, the files a file imports before it, and goes over the project again until the types settle, so a type from one file is known in all the others whatever their order. The errors are reported as esbuild errors and the build fails. When no file has changed since the last check, the plugin reuses its result: one plugin passed to several builds checks the project once.

Then esbuild loads each `.slim` file it reaches; the plugin compiles it without checking it again, with the runtime imported (`runtime: "imports"`) from the package itself, so a bundle holds one copy of the runtime, and only the parts of it the code uses: a script that calls nothing from the runtime carries about 4 KB of it, the error reporting. In [release mode](01-release-mode.md) traits and type aliases no code uses by name are left out as well. Imports between `.slim` files lead to their sources, and nothing is written to `slim-dist`.

The default `files` skip `node_modules`, the [dist folder](../04-CLI/03-configuration.md) and folders whose names start with `.`, and follow junctions and symlinked folders, so a package linked into `packages/` is checked with the project.

In watch mode (`esbuild.context(...)` and `ctx.watch()`), a rebuild starts when a bundled file or the `host` file changes, and the project is checked again with its new files.

## Checking without a bundle

`check(options)` runs the same check alone and returns the error messages, one per file that does not compile, in import order:

```javascript
import { check } from "@slim-lang/core/esbuild"

const errors = check({ root: import.meta.dirname })
for (const text of errors) console.error(text)
process.exitCode = errors.length ? 1 : 0
```

The module also exports `slimFiles(folder)`, the `.slim` files the plugin checks when `files` is left out, and `runtimeDir`, the folder its bundles take the runtime from.
