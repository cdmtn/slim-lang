# Inference and Generics

## Type inference

Types are inferred for unannotated constants, for `for...of` variables and for callback parameters of array methods, `Map` and `Set`. `map`, `filter`, `find`, `reduce`, string methods, `Map.get` and the like have result types, and a function without `-> T` returns what its `return` statements return:

```js
struct User {
    name: string
    age: int
}

func names(users: User[]) {
    users.forEach(u => log(u.nmae))         // ❌ "User" has no field "nmae" — did you mean "name"?
    let ages: string[] = users.map(u => u.age) // ❌ "ages" expects string[], got int[]
    let first: User = users.find(u => u.age > 18) // ❌ "first" expects User, got (User | undefined)
}
```

An object literal kept in a `const` and never changed afterwards has the type of its fields, so it is checked where a struct is expected; a value from `JSON.parse` or another untyped source is still checked only at runtime.

A JSON file brought in with `import` has the type of its contents, so its fields are checked:

```js
import data from "./data.json"    // { "techs": [1, 2], "ratio": 0.5 }

const n: number = data.techs      // ❌ "n" expects number, got int[]
const r: int = data.ratio         // ❌ "r" expects int, got float
```

The checker also follows `await` (calling an `async func` without it gives `Promise<T>`), checks assignments to struct fields, and checks arguments of struct methods. `Promise.all`, `Promise.race`, `Date` methods, `fetch` and its `Response`, `Map` and `Set` iteration (`for (const [k, v] of map)`, `.keys()`, `.entries()`), `Object.entries`, `Object.values` and `Array.from` have types, and so does destructuring from them:

```js
async func loadCount() -> int { return 1 }
async func loadName() -> string { return "Ada" }

async func main() {
    const [count, name] = await Promise.all([loadCount(), loadName()])
    const n: int = name                 // ❌ "n" expects int, got string
    const r = await fetch("https://example.com")
    log(r.stauts)                       // ❌ Response has no property "stauts" — did you mean "status"?
}
```

`.then(cb)` gives a promise of what `cb` returns, and `.catch(cb)` adds it to the promised type:

```js
struct User { name: string }

func load() { return fetch("/me").then(r => User.verify(r)) }   // Promise<User>
const p: Promise<int> = load()      // ❌ "p" expects Promise<int>, got Promise<User>
```

## Generic functions and structs

Generic functions get their type parameters from each call, and generic struct methods from the instance:

```js
func first<T>(items: T[]) -> T? { return items[0] }

let n: int = first(["a"])   // ❌ "n" expects int, got string?

struct Box<T> {
    value: T
    set(value: T) { this.value = value }
}

const box: Box<int> = { value: 1 }
box.set("text")             // ❌ argument "value" of "Box<int>.set" expects int, got string
```

A type parameter can require a type with `extends`. Calls are checked against it, and inside the function the parameter has the fields of that type:

```js
trait Named {
    name: string
}

func label<T extends Named>(item: T) -> string { return item.name }

label(5)                    // ❌ type parameter "T" of "label" must fit Named, got int
```

A struct's type parameters take constraints the same way, checked wherever the struct is used as a type: with `struct Page<T extends Named>`, `Page<int>` is a compile error. `Box.new<int>(...)` or `first<string>(...)` use the type arguments they are given.

Function types keep their parameters and result, and a callback passed to a typed parameter gets its parameter types from it; see [Function types](../03-types/03-type-expressions.md#function-types).

## Classes

Typed class fields are checked like struct fields: assigning a value of the wrong type, writing a `readonly` field outside the constructor or a getter without a setter, and calling a method with wrong arguments are errors. Fields a class sets through `this` without declaring them stay allowed. `name!: string` says the field is set somewhere else, so it needs no starting value.

Class instances are checked like structs: an unknown field, the result of a method and a method taken off its object are reported. A class that extends something Slim can't see (`extends Error`, `extends HTMLElement`) or assigns `this[key]` is left open.

Instances of classes, declared in the file or imported with `use`, are checked by name: a subclass fits where its parent is expected, and nothing else does. `new P(...)`, `super(...)` and static members are checked too, and a static method's arguments and result are checked like an instance method's:

```js
class Point {
    x: int
    y: int
    static origin = 0
    constructor(x: int, y: int) {
        this.x = x
        this.y = y
    }
}

class Config {
    static port = 80
}

new Point("a", 1)                   // ❌ argument "x" of "new Point" expects int, got string
log(Config.prot)                    // ❌ "Config" has no static member "prot" — did you mean "port"?

class Api {
    static find(id: int) -> Point { return new Point(id, 0) }
}

Api.find("1")                       // ❌ argument "id" of "Api.find" expects int, got string
log(Api.find(1).z)                  // ❌ "Point" has no field "z"
```

Type names belong to the module that declares them. An imported struct keeps the field types of its own module, even when the importing file declares a type with the same name; such a type shows up in messages with its module's name, like `models.Ingredient`.

Next: [More checks](04-more-checks.md).
