# More Checks

Code that would only fail when it runs, or would silently do the wrong thing, is reported before that. Each line marked ❌ below is a compile error.

## Declarations and numbers

```js
log(total)                          // ❌ "total" is used before its declaration — move the declaration above
let total = 0

let count: int = 0
count += 0.5                        // ❌ "count" is int, but "+=" makes it float
func open(port: int = "80") {}      // ❌ the default of "port" must be int, got string
type positive(v) { return v > 0 }
let p: positive = -1                // ❌ "p" expects positive, got -1
let half: int = 10 / 2              // ❌ "half" expects int, got float — "/" always gives a float, use "~/" for integer division
const big = 9007199254740993        // ❌ 9007199254740993 is too large to be stored exactly (beyond ±2^53), it becomes 9007199254740992 — write 9007199254740993n for a bigint
const ys: int[] = [1, , 3]          // ❌ "ys" expects int[], got (int | undefined)[]
```

At runtime an `int` must be an exact integer (within ±2^53) and an array with holes doesn't pass as `int[]`. A literal given to a [custom type](../03-types/02-custom-types.md#validator-types) with a simple body is checked by working the body out.

A regular expression that can't be compiled is reported too, since the whole file would fail to load:

```js
const re = /(\d+/                   // ❌ invalid regular expression: /(\d+/: Unterminated group — the whole file would fail to load
```

## Enums and literals

A literal passed where an enum with values is expected must be one of those values, and some errors say how to fix them:

```js
enum Color {
    Red: "red"
    Green: "green"
}
enum Level {
    Low: 1
    High: 3
}

func paint(c: Color) { return c }
const color: Color = Color.Red
const x = JSON.parse("1")

paint("blue")              // ❌ argument "c" of "paint" expects Color, got "blue" — use one of "red", "green"
if (color == "blu") {}     // ❌ this comparison is always false: Color and "blu" have no value in common
if (typeof x == "strng") {} // ❌ typeof never gives "strng" — did you mean "string"?
Level.Low + Level.High     // ❌ "Level.Low" is Level::Low, an enum member and not a number — use Level.Low.value
```

## Structs, arrays and maps

```js
struct User {
    name: string
    age: int
}

func save(u: User) { return u }

const user = new User()             // ❌ "User" is a struct, not a class: create it with User.new({ ... }) or a literal
const draft = { name: "Ada" }
save(draft)                         // ❌ argument "u" of "save" expects User, got { name: string } — it has no "age"

const xs: int[] = [1, 2, 3]
xs.map((s: string) => s.length)     // ❌ parameter "s" is string, but it gets int here

const cache = new Map<string, int>()
cache.set("a", "x")                 // ❌ argument "value" of "Map<string, int>.set" expects int, got string

const m = "abc".match(/z/)
log(m[0])                           // ❌ "m" may be null here (string[] | null)
```

## Methods and indexes

```js
class Counter {
    n: int = 0
    next() -> int { return ++this.n }
}

const counter = new Counter()
const xs = [1, 2, 3]

const g = counter.next              // ❌ "counter.next" loses its "this" when taken off the object — call it in place, use counter.next.bind(counter) or wrap it
log(counter.nxt)                    // ❌ "Counter" has no field "nxt" — did you mean "next"?
log(xs[xs.length])                  // ❌ "xs[xs.length]" is always undefined: the last index is length - 1
for (let i = 0; i <= xs.length; i++) log(xs[i])   // ❌ "i <= xs.length" goes one step too far — use "i < xs.length"
```

## Async code

Two common async mistakes are compile errors:

```js
struct User { name: string }

async func save(user: User) { return user }

async func main(user: User, users: User[]) {
    save(user)                                  // ❌ "save" is async and nothing awaits it
    void save(user)                             // ok: runs in the background on purpose
    users.forEach(async u => { await save(u) }) // ❌ forEach doesn't wait for async callbacks
    await Promise.all(users.map(u => save(u)))  // ok
}
```

`filter`, `some`, `every` and `find` with an async callback are reported too: they get a promise, which is always truthy. Errors of async calls that nothing awaits (`main()` at the top level, `void save()`) still go through Slim's error output.

A `?` on a promise is reported with a fix:

```js
async func loadUser() -> Result<string, string> { return Result.Ok("Ada") }

async func main() -> Result<string, string> {
    const user = loadUser()?   // ❌ "?" needs a Result or an Option, got Promise<Result<string, string>> — await it first: (await loadUser(...))?
    return Result.Ok(user)
}
```

## Common JavaScript mistakes

```js
func save() { return true }

const name: string? = null
const big = 10n
const n = 1.5
let x = 1
const items = [3, 10, 9]

log("hi " + name)                   // ❌ "name" is null here (null) — "+" would put "null" into the text: check it first or use name ?? ""
log(big + 1)                        // ❌ "+" can't mix bigint and number: it throws at runtime — write 1n, or Number(...) on the bigint side
if (n == NaN) {}                    // ❌ NaN is not equal to anything, itself included, so this is always false — use Number.isNaN(n)
if (x = 2) {}                       // ❌ this assigns instead of comparing — write == to compare, or wrap it in extra parentheses if the assignment is meant
if (items) {}                       // ❌ "items" is int[], so this condition is always true — an empty array is truthy too: use items.length > 0
if (save) {}                        // ❌ "save" is () => bool, so this condition is always true — did you mean to call it: save()?
items.sort()                        // ❌ "sort()" without a comparator sorts numbers as text (10 comes before 9) — pass (a, b) => a - b
delete items[0]                     // ❌ "delete" on an array element leaves a hole and keeps the length — use items.splice(index, 1)
items.forEach(x => { return true }) // ❌ "forEach" ignores what its callback returns, so this return value goes nowhere — use some(), find() or a for…of loop
```

In a function type, every parameter needs a name:

```js
func apply(f: (int) => int) {}      // ❌ "int" here is a parameter name, not its type — write (value: int) => ...
```

A line that starts with `[` or `(` continues the line above, as in JavaScript:

```js
const list = [1]
[2].forEach(log)                    // ❌ this line starts with "[", so it continues the line above as an index — put ; at the end of the line above
```

## Names

```js
log(compute())                      // ❌ "compute" is not defined — declare it, import it with "use", or list it in "globals" in the config
const r = Ok(1)                     // ❌ "Ok" is not defined — write Result.Ok

func add(a: int, b: int) -> int { return a + b }
const names = ["a", "b"]
add(...names)                       // ❌ argument "a" of "add" expects int, got string from "...names"
```

Names that the page or another script provides go in `globals` or are declared with `global`; see [Host declarations](05-host-declarations.md).

## Also reported

- a key, a struct field, an enum member or a `case` written twice, `x = x`, `"a" instanceof String`, and a write to the `length` of a string or the `size` of a `Map`;
- a `const` assigned again (`=`, `+=`, `++`), and wrong arguments of built-in string and array methods (`name.indexOf(1)`, `ids.push("x")` on an `int[]`); a spread in a struct literal brings in the fields of the spread value with their types;
- destructuring or spreading a value that may be `null`, calling a value that isn't a function, `this` inside a `function` passed to `forEach`, `then` or `setTimeout` (use an arrow function), `setTimeout("code")`, `~/ 0`, deleting a required struct field, `++` on a non-number, a struct field default of the wrong type, `Struct.new` without a required field, a typed class field with no starting value and no assignment in the constructor, writes to an object after `lock`, and a `case` that can never match the `switch` value;
- in markup: a tag with no component behind it (`<Helo />`), an attribute set twice, `className` or `htmlFor` (write `class` and `for`), component props of the wrong type (`<Card count="3" />` passes a string), and `onclick=${fn}` (write `onClick=${fn}`);
- an `isolated component` that uses a name from outside it.

Next: [Host declarations](05-host-declarations.md).
