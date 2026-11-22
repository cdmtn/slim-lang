# Traits

A trait lists the fields and methods a struct has to provide. A method with a body is a default that structs get unless they define their own:

```js
trait Named {
    name: string
    describe() -> string
    greet() -> string { return "Hi, " + this.describe() }
}

struct User implements Named {
    name: string
    age: int
    describe() -> string { return `${this.name} (${this.age})` }
}

func welcome(who: Named) -> string { return who.greet() }

log(welcome(User.new({ name: "Ada", age: 36 })))  // Hi, Ada (36)
```

A trait can take type parameters, given where a struct implements it:

```js
trait Comparable<T> {
    compare(other: T) -> int
}

struct Money implements Comparable<Money> {
    cents: int
    compare(other: Money) -> int { return this.cents - other.cents }
}

log(Money.new({ cents: 500 }).compare(Money.new({ cents: 200 }))) // 300
```

The compiler reports a struct that misses a field or method of its trait, or has one of the wrong type:

```js
trait Named {
    name: string
    describe() -> string
}

struct Pet implements Named {  // ❌ "Pet" doesn't implement "describe() -> string" from trait "Named"
    name: string
}
```

A trait works as a type: a struct fits it when it says `implements`, and a class or an object when it has the fields and methods. Other fields are allowed, except in an object literal written right there. At runtime a trait checks the shape of the value.

In a trait, `this` stands for the type that implements it; see [the `this` type](../03-types/04-functions.md#the-this-type). Enums can implement traits as well: see [Enums with data](../05-enums/04-enums-with-data.md#methods-and-traits).

Traits also describe APIs that a page provides, with `global`: see [Host declarations](../14-static-checking/05-host-declarations.md).

Next: [Components](../08-components/01-creating.md).
