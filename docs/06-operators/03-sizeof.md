# sizeof Operator

Returns the size of a value as an `int`:

```js
log(sizeof [])                  // 0
log(sizeof [1, 2, 3])           // 3
log(sizeof { a: true })         // 1
log(sizeof "hello")             // 5
log(sizeof new Set([1, 2]))     // 2
log(sizeof null)                // 0
```

| Value | Size |
|---|---|
| array, string | its length |
| object | the number of its own keys |
| `Map`, `Set` | its `size` |
| number | the number of characters it is written with (`sizeof 12345` is `5`) |
| bool | `1` |
| `null`, `undefined` | `0` |

Next: [`copyof`](04-copyof.md).
