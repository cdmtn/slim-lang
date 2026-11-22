# JavaScript API

## Compiling from JavaScript

The `@slim-lang/core` package can be used from a build script or a tool:

```javascript
import { transform, build, formatSlim, projectExports } from "@slim-lang/core"

const { code, warnings } = transform(`const n: int = 1`, "app.slim")  // throws on a compile error
const ok = build()                                                    // builds the project in the current folder, by its slimconfig.json
const pretty = formatSlim(source)
```

`transform(code, file, options)` compiles one file. A compile error throws. For type errors, the error's `slimTypeErrors` lists each problem with `message`, `line`, `column` and `sourceLine`; a syntax error has `slimSyntaxError: true` and its location in `message`. The options mirror [slimconfig.json](../04-CLI/03-configuration.md):

| Option | Meaning |
|---|---|
| `runtime` | `"imports"` to import runtime functions instead of using globals |
| `globals` | names that come from elsewhere |
| `host` | a `.slim` file with `global` lines for every file |
| `autoImport` | an index of project exports: `projectExports(folder)` |
| `warnings` | `false` turns warnings off |
| `jsdoc`, `declarations`, `release`, `check`, `sourceMaps`, `uses` | as in `slimconfig.json` (`uses` is the `uses.style` value) |

`build()` returns `true` when the build succeeded.

The package exposes these and the [esbuild plugin](07-esbuild.md), `@slim-lang/core/esbuild`; its `src/` files are not part of it.

## Converting JavaScript and TypeScript

The separate package `@slim-lang/convert` turns existing code into Slim, keeps its formatting and comments, and compiles the result to report what is left:

```bash
npx slim-convert src
```

Next: [esbuild](07-esbuild.md).
