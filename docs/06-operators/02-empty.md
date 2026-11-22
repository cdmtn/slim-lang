# empty Operator

Checks whether a value is empty, returning a `bool`. A value is empty when its [size](03-sizeof.md) is `0`:

```js
log(empty [])           // true
log(empty {})           // true
log(empty "")           // true
log(empty null)         // true
log(empty undefined)    // true
log(empty new Map())    // true
log(empty [1])          // false
log(empty "a")          // false
```

`empty` measures size, not truthiness: `empty 0` and `empty false` are both `false`.

Next: [`sizeof`](03-sizeof.md).
