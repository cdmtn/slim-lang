# Runtimes

Compiled Slim code relies on a small runtime: the type checks, structs, enums, operators, `log` and the component layer. The build copies it into `slim-dist/external/`.

## Two runtimes

Slim uses one of two runtimes per file:

- `external/core.js` — the type system, structs, enums, operators and test helpers. It imports no Node built-in, touches no filesystem, and assumes no DOM. Every `process` reference is guarded, so the module loads where `process` does not exist at all.
- `external/defaults.js` — the core plus the DOM layer components render through (linkedom on the server, loaded only there) and the file reading that puts a source line in an error.

Files without components use `core.js`, so they also run where there is no DOM: in a Web Worker, a service worker or an edge function.

## Runtime imports

By default the compiled files load `external/defaults.js` or `external/core.js`, and those put the runtime (`log`, `raw`, `__insert__` and the rest) on `globalThis`. With `"runtime": "imports"`, each file imports by name only what it uses, from `external/runtime-dom.js` or `external/runtime-core.js`, and nothing is added to `globalThis`:

```json
{
    "main": "index",
    "runtime": "imports"
}
```

```javascript
import { __insert__, __template__, log } from "./external/runtime-dom.js";
```

A bundler can then leave out what no file uses, and Slim's names don't meet the page's own globals.

## Embedded engines

The core runtime also runs in an engine without Node, such as V8 inside a game:

- an error thrown while a module loads is printed and then thrown again, so the engine sees an uncaught exception and the rest of the bundle doesn't run (under Node the process exits with code 1, see [Error handling](../12-error-handling.md));
- a [host file](../14-static-checking/05-host-declarations.md) that only declares things (`global`, traits, type aliases, functions and `use` of such files) is not imported at runtime: a file imports from it only the types it checks at runtime, by name, so a small script doesn't carry the whole host API;
- the assertions are available from `@slim/test` and need no timers (see [Testing](../13-testing.md#outside-slmc-test)).

Typed parameters and return values of `int`, `float`, `number`, `string` and `bool` are checked inline, and a return the static checker has already proved is not checked again, so dev builds stay usable in a game loop. Writing one key of a typed `Record` or one field of a trait-typed value checks only that key.

Next: [TypeScript](03-typescript.md).
