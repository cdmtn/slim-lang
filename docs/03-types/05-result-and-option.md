# Result and Option

`Result<T, E>` and `Option<T>` are built in. They let a function report failure or a missing value as an ordinary return value, and the `?` operator passes it up without `if` chains.

- `Result.Ok(value)` and `Result.Err(error)` build a `Result<T, E>`;
- `Option.Some(value)` and `Option.None` build an `Option<T>`.

A `?` after a value unwraps an `Ok` or a `Some`, and returns an `Err` or a `None` from the function right away:

```js
func parsePort(raw: string) -> Result<int, string> {
    const n = Number(raw)
    if (!Number.isInteger(n)) return Result.Err(`"${raw}" is not a port`)
    return Result.Ok(n)
}

func address(host: string, raw: string) -> Result<string, string> {
    const port = parsePort(raw)?
    return Result.Ok(`${host}:${port}`)
}

log(address("db", "5432").unwrap())  // db:5432
log(address("db", "x").unwrapOr("-")) // -
log(address("db", "x").isErr())      // true
```

## Methods

| Method | Result | Option |
|---|---|---|
| `unwrap()` | the value of an `Ok`, throws for an `Err` | the value of a `Some`, throws for `None` |
| `unwrapOr(fallback)` | the value, or `fallback` for an `Err` | the value, or `fallback` for `None` |
| `map(fn)` | maps the value of an `Ok` | maps the value of a `Some` |
| `mapErr(fn)` | maps the error of an `Err` | — |
| `isOk()` / `isErr()` | which one it is | — |
| `isSome()` / `isNone()` | — | which one it is |

Helpers turn other values into a `Result` or an `Option`:

- `Result.attempt(() => JSON.parse(raw))` turns an exception into an `Err` (and a returned promise into a promise of a `Result`);
- `Result.fromPromise(promise)` does the same for a promise;
- `Option.from(value)` gives `None` for `null` and `undefined`, and `Some(value)` otherwise.

```js
const parsed = Result.attempt(() => JSON.parse("{ broken"))
log(parsed.isErr())                       // true

const name = Option.from(null).unwrapOr("anonymous")
log(name)                                 // anonymous
log(Option.Some(2).map(n => n * 10).unwrap()) // 20
```

## Rules for `?`

`?` binds to the value right before it (`parse(raw)? * 2`) and works in arrows and `async` functions, but not at the top level of a module. The compiler knows the unwrapped type and reports a `?` on a value that isn't a `Result` or an `Option`, or in a function whose return type can't hold the failure:

```js
func parsePort(raw: string) -> Result<int, string> {
    const n = Number(raw)
    if (!Number.isInteger(n)) return Result.Err(`"${raw}" is not a port`)
    return Result.Ok(n)
}

func port(raw: string) -> int {
    return parsePort(raw)?   // ❌ "?" returns the Err from "port", but "port" returns int
}
```

`Ok`, `Err`, `Some` and `None` are not globals: write `Result.Ok(1)`, not `Ok(1)`.

In the browser, `Option` keeps meaning the DOM's `new Option(...)` outside Slim code: the compiled files use `__Option__` instead.

Next: [slmc](../04-CLI/01-slmc.md).
