# Typed Functions

Slim adds the `func` keyword (a shorter `function`), typed parameters and return types. Both are checked at compile time where possible and at runtime for every call.

## Typed parameters

```js
func greet(name: string, times: int) {
    return name.repeat(times)
}

log(greet("hi ", 2))           // hi hi
greet("hi ")                   // ❌ "greet" expects 2 arguments, got 1
greet("hi ", JSON.parse("1.5")) // ❌ TypeError: function "greet": argument<1> "times" expected int, got float
```

A parameter can have a default; the default must fit the type (`func open(port: int = "80")` is a compile error). An optional parameter is written `name?: string` and reads as `string | undefined`.

## Return types

A function can declare its return type with `-> Type`. Slim checks each `return` and verifies the value at runtime:

```js
func parse(raw: string) -> int {
    return JSON.parse(raw).value
}

log(parse(`{ "value": 7 }`))  // 7
parse(`{ "value": "seven" }`) // ❌ TypeError: function "parse" must return int, got string: "seven"
```

This works with `func`, methods, arrows, and `async` functions. Nested functions keep their own return type:

```js
struct User {
    name: string
}

const double = (n: int) -> int => n * 2

async func load(name: string) -> User {
    return User.new({ name })
}

log(double(4))                // 8
log((await load("Ada")).name) // Ada
```

A function with a return type can't reach its end without a `return`, unless the type allows `undefined` (`void`, `int?`, ...). A `switch` counts as complete when it has a `default` or handles every member of an enum. At runtime, falling off the end fails the same way as `return undefined`:

```js
enum Status {
    Draft: 1
    Sent: 2
    Paid: 3
}

func label(s: Status) -> string {      // ❌ "label" must return string, but it can reach the end without a return — the switch on "Status" does not handle Status.Paid
    switch (s) {
        case Status.Draft: return "draft"
        case Status.Sent: return "sent"
    }
}
```

A function without `-> T` returns what its `return` statements return, and the checker uses that type at the call sites.

With [JSDoc or declarations](../15-build-and-runtime/03-typescript.md) enabled, the return type is also available to TypeScript (`async` becomes `Promise<T>`).

## Generic functions

Generic functions get their type parameters from each call:

```js
func first<T>(items: T[]) -> T? { return items[0] }

let s: string? = first(["a"])  // ok
let n: int = first(["a"])      // ❌ "n" expects int, got string?
```

A type parameter can require a type with `extends`. Calls are checked against it, and inside the function the parameter has the fields of that type:

```js
trait Named {
    name: string
}

func label<T extends Named>(item: T) -> string { return item.name }

log(label({ name: "Ada" }))   // Ada
label(5)                      // ❌ type parameter "T" of "label" must fit Named, got int
```

Type arguments can also be given explicitly: `first<string>(items)`.

## The `this` type

Inside a class, struct, enum or trait, `this` is a type: the type of the object the method was called on. A method that returns `this` keeps the subclass in a chain, and a parameter typed `this` only takes the same type as the receiver:

```js
class Shape {
    name: string = ""
    next: this? = null
    rename(name: string) -> this {
        this.name = name
        return this
    }
    same(other: this) -> bool { return other.name == this.name }
}

class Circle extends Shape {
    radius: int = 1
    grow() -> this {
        this.radius += 1
        return this
    }
}

new Circle().rename("c").grow()        // rename returns Circle, so grow is there
new Shape().rename("s").grow()         // ❌ "Shape" has no field "grow"
new Circle().same(new Shape())         // ❌ argument "other" of "Circle.same" expects Circle, got Shape

class Copy {
    clone() -> this { return new Copy() }   // ❌ a new Copy is not this for a subclass of Copy — return this, or declare -> Copy
}
```

In a trait, `this` stands for the type that implements it, so `compare(other: this) -> int` in `trait Ord` means `compare(other: Money)` in `struct Money implements Ord`. At runtime a `this` check uses the class of the receiver (`this.constructor`), and the error names it: `function "rename" must return Circle, got object`. `this` is not a type outside a method or field, in a static method, or for a variable.

## Generators

`func* name()` declares a generator:

```js
func* range(n: int) {
    for (let i = 0; i < n; i++) yield i
}

log([...range(3)]) // [0, 1, 2]
```

Next: [Result and Option](05-result-and-option.md).
