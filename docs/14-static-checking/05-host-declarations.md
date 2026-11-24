# Host Declarations

A name that nothing declares is a compile error. When a value comes from outside Slim, such as another script on the page, a payment widget or an embedding application, tell the checker about it.

## globals

Names that come from elsewhere go in `globals` in `slimconfig.json`. The checker treats them as declared, with a type it doesn't know, and still suggests them for typos:

```json
{
    "main": "index",
    "globals": ["YurbaLib", "EmptyState"]
}
```

`transform(code, file, { globals: [...] })` takes the same list.

## global

When the type of such a name is known, `global` states it. The page provides the value, a payment widget's script for example, and Slim checks every use of it:

```js
trait Checkout {
    open(amount: int, currency: string) -> void
    close() -> void
}

global checkout: Checkout

checkout.open(1500, "EUR")
checkout.open("1500", "EUR")     // ❌ argument "amount" of "Checkout.open" expects int, got string
checkout.opne(1500, "EUR")       // ❌ "Checkout" has no field "opne" — did you mean "open"?
```

There are three forms:

| Form | Meaning |
|---|---|
| `global world: World` | provided from outside and read only: assigning it is an error |
| `global kit?: Kit` | may be missing: it reads as `undefined` until something provides it, so the checker asks for a check or `?.` |
| `global let mode: string` | scripts may set it too: every write is checked against the type |

`global let kit?: Kit` combines the last two. A global is read and written as `globalThis.name`, so a missing one is `undefined` instead of a `ReferenceError`, and a script sets one by assigning it, with no `globalThis as any`. A local name with the same name hides the global, as usual.

## host

A `global` line holds for its own file. For an API that the whole project sees, put the traits and the `global` lines in one file and name it in `host`. Every file sees its traits and `global` lines as if they were written at its top. The file is built like any other file, and a value checked against one of its traits is checked at runtime too. A host that only declares things (traits, type aliases, functions, `global` and `use` of such files) is not imported at runtime: a file that checks one of its types at runtime imports that type from where it is defined. A host with any other code is imported by every file. In other files a trait name from `host` is a type only: to call `Checkout.verify(...)`, import it with `use`:

```json
{
    "main": "index",
    "host": "types/page"
}
```

```js
// types/page.slim
export trait Checkout {
    open(amount: int, currency: string) -> void
    close() -> void
}

global checkout: Checkout
```

`transform(code, file, { host: "types/page.slim" })` takes the same path, reads the file itself and reads it again when it changes. A host file with an error is reported again for every file, not only for the first one.

## Writing globals

Writes to a global are checked against its type, and only a `global let` can be assigned:

```js
global let mode: string
global let kit?: Kit
global world: World

mode = 2          // ❌ "mode" expects string, got int
kit = makeKit()   // ok: every file now sees it
kit.spawn()       // ⚠️ "kit" may be undefined here (Kit | undefined) — check it first or use "?."
world = makeWorld() // ❌ "world" is a read-only global: the host provides it, so it can't be assigned here
```

`globalThis.name = value` is checked against the same type.

## env

For a host without a browser or Node, such as an embedded engine, set `"env": "embedded"` in `slimconfig.json` (or `transform(code, file, { env: "embedded" })`). The checker then knows only the JavaScript built-ins (`Math`, `JSON`, `Promise`, `console` and the like) and Slim's own names, so `setTimeout`, `document`, `process` and `fetch` are errors until the host declares them.

Next: [Build and runtime: release mode](../15-build-and-runtime/01-release-mode.md).
