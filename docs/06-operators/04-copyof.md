# copyof Operator

`copyof` creates a copy of an array or an object, rather than another reference to it:

```js
let originalArray = [1, 2, 3]
let copiedArray = copyof originalArray

originalArray.push(4)

log(copiedArray) // [1, 2, 3]
```

The copy is shallow: the array or object itself is new, but nested objects are shared with the original:

```js
const original = { name: "Ada", tags: ["admin"] }
const copy = copyof original

copy.name = "Bob"
copy.tags.push("editor")

log(original.name)  // Ada
log(original.tags)  // ["admin", "editor"]
```

Use `structuredClone(value)` for a deep copy. `copyof` on anything other than an array or an object throws `TypeError: Copy target must be object or array, not int` when it runs.

Next: [`lock`](05-lock.md).
