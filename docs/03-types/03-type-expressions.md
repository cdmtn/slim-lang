# Type Expressions

Besides type names, an annotation can be a type expression built from other types. The static checker checks all of them. At runtime a value is checked against them too, with the exceptions noted below: a function type only checks that the value is a function, a promise's contents aren't checked, and `as` checks nothing.

## Nullable types

A trailing `?` marks a type nullable: `T?` means `T | null | undefined`.

```js
let name: string? = null // ok
name = "Slim"            // ok
name = 42                // ❌ "name" expects string?, got int
```

A nullable value has to be checked before it is used; see [Narrowing and null safety](../14-static-checking/02-narrowing-and-null-safety.md).

## Unions and intersections

Types combine with `|` (union: the value matches any of them) and `&` (intersection: the value matches all of them):

```js
type Id = int | string

let a: Id = 1      // ok
let b: Id = "x"    // ok
let c: Id = true   // ❌ "c" expects Id, got bool
```

A union only fits where every part of it fits, so an `int | string` can't be passed where an `int` is expected until it is narrowed.

## Literal types

Literal types restrict a value to exact strings, numbers or booleans:

```js
type Level = 1 | 2 | 3

let level: Level = 2 // ok
level = 4            // ❌ "level" expects Level, got 4
```

## Arrays and tuples

`T[]` (or `Array<T>`) is an array whose items are all `T`. A tuple type validates a fixed-length array element by element:

```js
let ids: int[] = [1, 2, 3]
let pair: [int, string] = [1, "a"] // ok
let bad: [int, string] = [1]       // ❌ "bad" expects [int, string], got [int]
```

`readonly T[]` is an array that can't be changed: `push`, `sort`, `a[0] = x` and the like are compile errors, the value is protected at runtime, and it can't be passed where a plain `T[]` is expected:

```js
func total(items: readonly int[]) -> int {
    items.push(0)                                       // ❌ "items" is readonly int[]: "push" would change it
    return items.reduce((sum, n) => sum + n, 0)
}
```

## Object types

An object type describes a value without declaring a struct. Like a struct, it rejects missing and unknown fields, statically and at runtime:

```js
func connect(options: { host: string, port?: int }) { return options.host }

connect({ host: "db" })            // ok
connect({ hots: "db" })            // ❌ "{ host, port? }" has no field "hots" — did you mean "host"?
```

`Record<K, V>` is an object used as a dictionary: every key fits `K` and every value fits `V`. Reading a key gives `V | undefined`, since the key may be missing:

```js
let scores: Record<string, int> = { ada: 3, bob: "x" }  // ❌ "scores"["bob"] expects int, got string
```

## Generic containers

`Set<T>` and `Map<K, V>` validate their contents too:

```js
let ids: Array<int> = [1, 2]                     // ok
let names: Set<string> = new Set(["a"])          // ok
let ages: Map<string, int> = new Map([["a", 1]]) // ok

let mixed: Array<int> = JSON.parse(`[1, "a"]`)   // ❌ TypeError: The "mixed" is of type int[], but was assigned a array: [1,"a"]
```

`Promise<T>` and bare built-ins (`Map`, `Set`, `Date`, `RegExp`, `Error`) are matched by constructor. A promise resolves too late for its contents to be checked.

`Struct<T>` is a struct itself, not one of its values. With it a function can take a struct and give back its instances:

```js
struct User { name: string }

func load<T>(model: Struct<T>, data: any) -> T { return model.verify(data) }

const user = load(User, { name: "Ada" })  // user is a User
load(5, {})                               // ❌ argument "model" of "load" expects Struct<any>, got int
```

## Function types

A function type keeps its parameters and result: `(n: int) => string`. A callback passed to a typed parameter gets its parameter types from it:

```js
func apply(cb: (n: int) => string, n: int) -> string { return cb(n) }

apply(n => `#${n}`, 1)        // ok, n is an int
apply(n => n * 2, 1)          // ❌ argument "cb" of "apply" expects (n: int) => string, got (n: int) => int
```

Parameters in a function type need names: in `(int) => int`, `int` is a parameter name, not its type, and the checker reports it.

The last parameter can be a rest parameter with an array type. It takes any number of arguments, each checked against the element type:

```js
type Log = (...args: any[]) => void
const join: (sep: string, ...parts: string[]) => string = (sep, ...parts) => parts.join(sep)

join(", ", "a", "b")   // ok
join(", ", "a", 1)     // ❌ argument "parts" of "join" expects string, got int
```

## Keys and indexed access

`keyof T` is the union of the field names of a struct, trait or object type, and the key type of a `Record`. `T[K]` is the type of the field `K` of `T`. Together they type an event API:

```js
trait Events {
    tick: (dt: float) => void
    chat: (who: string, text: string) => void
}

func on<K extends keyof Events>(event: K, handler: Events[K]) {}

on("tick", dt => log(dt))          // ok, dt is a float
on("tick", (a: string) => {})      // ❌ argument "handler" of "on" expects Events["tick"], got (a: string) => undefined
on("tock", () => {})               // ❌ type parameter "K" of "on" must fit keyof Events, got "tock"
```

At runtime `keyof T` accepts the field names of a struct or trait, and `T[K]` checks a value against that field's type.

## Markup

A markup value has the type `Html` (`SafeHtml` is the same type). It fits `Html` and `object`, and nothing else:

```js
func row(name: string) -> Html { return <li>${name}</li> }

const item: Html = row("a")       // ok
const n: int = row("a")           // ❌ "n" expects int, got Html
```

`+` with a string and `.join(...)` turn markup into a plain string, which the next markup escapes. The checker warns about both: put the list in markup as `${list}`, or use `raw.join(list, separator)`.

## never

`never` is the type of a function that doesn't finish normally. It has to end with `throw` (or a call to another `never` function), and a call to it counts as leaving the code path:

```js
func fail(message: string) -> never { throw new Error(message) }

func port(value: int?) -> int {
    if (value == null) return fail("no port")
    return value
}

log(port(80)) // 80
```

## Typed destructuring

You can destructure a typed value; the source is validated before it is unpacked:

```js
struct User {
    name: string
    id: int
}

const { name, id }: User = JSON.parse(`{ "name": "Ada", "id": 1 }`)
const [x, y]: [int, int] = JSON.parse("[1, 2]")

log(name, id, x, y) // Ada 1 1 2

const [a, b]: [int, int] = JSON.parse("[1]") // ❌ TypeError: destructured value does not match type [int, int]: [1]
```

## Type assertions

`value as T` makes the checker treat a value as `T`, and `value!` as not `null` or `undefined`. Neither checks anything at runtime, so prefer a typed variable or a struct when the value comes from outside:

```js
const port = JSON.parse("8080") as int
const input = [1, 2].find(n => n > 1)!

log(port + input) // 8082
```

Next: [Typed functions](04-functions.md).
