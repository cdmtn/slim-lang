# lock Operator

`const` only stops a variable from being assigned again; `lock` also locks the object's contents, nested objects included, against modifications.

It can be written on the declaration or as a statement:

```js
lock const settings = { theme: "dark", sizes: { base: 16 } }

const user = { name: "John" }
lock user

log(settings.theme, user.name) // dark John
```

If you try to modify the content, the static checker reports it and the program is not built:

```js
lock const obj = { a: true }

obj.a = false // ❌ "obj" is locked: changing "obj.a" throws
```

A change the checker can't see, for example through another reference, throws at runtime:

```js
lock const obj = { a: true }

const change = (target, value) => { target.a = value }
change(obj, false) // ❌ Error: locked object mutation
```

`lock` keeps working in [release mode](../15-build-and-runtime/01-release-mode.md).

Next: [`match`](06-match.md).
