# Error Handling

## Uncaught errors

An uncaught top-level error is reported with the place in the `.slim` source where it happened, and the process exits with code 1. Where there is no `process` (a browser, an embedded engine), the error is reported and then thrown again, so the host sees an uncaught exception:

```text
StructError: "User.name" expected string, got int: 1
    at index.slim:3:12
```

Errors of async calls that nothing awaits (`main()` at the top level, `void save()`) go through the same output.

Use a handler when the process should stay alive:

```js
onError((err) => {
    log("handled:", err.message)
})

setTimeout(() => log("still alive"), 50)
throw new Error("boom")
```

```text
handled: boom
still alive
```

## Typed catch

A typed `catch` handles only errors of its type and lets the others through. Several types are written as a union:

```js
struct User {
    name: string
}

func save(data) {
    return User.verify(data)
}

try {
    save(JSON.parse(`{ "name": 1 }`))
} catch (e: StructError | TypeError) {
    log("invalid:", e.message)
}
```

## Slim error types

| Error | Thrown when |
|---|---|
| `StructError` | a struct rejects a value (`verify`, `new`, a struct-typed variable) |
| `TypeError` | a typed variable, parameter or return value gets a value of the wrong type |
| `EnumError` | `Enum.from` or `Enum.fromJSON` gets an unknown value |

`Struct.verifySafe` and [`Result`](03-types/05-result-and-option.md) are the ways to handle invalid data without exceptions. Inside components, use [`catchError`](10-reactivity/06-context-and-errors.md#errors-in-components).

Next: [Testing](13-testing.md).
