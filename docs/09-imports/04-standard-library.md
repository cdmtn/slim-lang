# Slim Modules and the Standard Library

## Slim modules

A few parts of Slim are modules rather than globals, so a program carries only what it imports. They come with `@slim-lang/core` and are imported from `@slim/...`:

| Module | Exports |
|---|---|
| `@slim/server` | `Server`, the HTTP server: see [Slim server](../11-server-rendering/02-slim-server.md) |
| `@slim/router` | `Router`, `Link`, `navigate`, `route`, `matchRoute`, `onShow`, `onHide`, `onLeave`, `onVisit`, `title`, `head`, `navigating`, `forget`: see [Routing](../10-reactivity/08-routing.md) |
| `@slim/forms` | `createForm`: see [Forms](../10-reactivity/04-forms.md#createform) |
| `@slim/test` | `assert`, `assertEqual`, `deepEqual` and the other assertions: see [Testing](../13-testing.md#outside-slmc-test) |

```js
use { Server } from @slim/server
use { Router, Link } from @slim/router
use { createForm } from @slim/forms
```

`@slim/...` always means these modules: a package in your packages folder can't take the name.

## The standard library

The standard library is the `std` package, developed in its own repository, [spm-libs/std](https://github.com/spm-libs/std): custom types (`positive`, `email`, `uuid`, `SemVer`...), converters, file reading, helpers and time formatting. Install it with [spm](../04-CLI/02-spm.md) and import it from `@std/...`:

```bash
spm i std
```

```js
use { even, odd } from @std/types/numerical
use { int } from @std/converters

let a: even = 4
let b: odd = int("3")

func half(n: even) -> int { return n ~/ 2 }
```

Every module is described in [its documentation](https://github.com/spm-libs/std/blob/main/docs/index.md).

Next: [Reactivity](../10-reactivity/index.md).
