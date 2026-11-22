# kindof Operator

Similar to `typeof`, `kindof` returns the type of a value in the Slim type format. Types in this format are used in all Slim functions and objects, so the result can be compared with the names you write in annotations.

```js
log(kindof 1)            // int
log(kindof "a")          // string
log(kindof [1, 2, 3])    // int[]
log(kindof [1, "hello"]) // array
```

`kindof` narrows a value for the static checker, just like `typeof`:

```js
func show(v: int | string) -> string {
    if (kindof v == "int") return `number ${v + 1}`
    return v.toUpperCase()
}

log(show(1))    // number 2
log(show("a"))  // A
```

The full list of results is in [About Slim types](../03-types/01-about-types.md#what-kindof-reports).

Next: [`empty`](02-empty.md).
