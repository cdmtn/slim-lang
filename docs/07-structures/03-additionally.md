# Additional Features of Structures

In the previous sections, we covered the main principle of working with structures. This section outlines all the additional features.

## Optional fields

Optional fields are not required. If an optional field is missing from the data, no error occurs; if it is present, it is validated just like all the others. An optional field reads as `T | undefined`.

__Example of use__
```js
struct User {
    name: string
    age?: int
}

log(User.verifySafe({ name: "Ada" }).success)                       // true
log(User.verifySafe(JSON.parse(`{ "name": "Ada", "age": "old" }`)).success) // false
```

## Multi-types

If a field may have one of several types, separate them with `|`. A trailing `?` allows `null` and `undefined`, but the key must still be present; to let it be missing, make the field optional (`nickname?: string`):

__Example of use__
```js
struct User {
    age: int | float
    nickname: string?
}

log(User.verifySafe({ age: 1.5, nickname: null }).success) // true
```

## Structure defaults

Fields can declare defaults. `.new()` (and an object literal of a struct type) fills them in when the data has no such field, and validates the result. A default may span several lines as long as it is inside brackets.

__Example of use__
```js
struct User {
    name: string
    role: string = "member"
    active: bool = true
}

log(User.new({ name: "Alice" })) // { role: "member", active: true, name: "Alice" }
```

## Structure methods

You can declare methods in a structure. They are available on objects created with `.new()` (or with a literal of the struct type), and they are inherited through `extends`. Method calls are type-checked like function calls:

```js
struct Greeter {
    name: string
    greet() -> string { return "Hi " + this.name }
}

log(Greeter.new({ name: "Ada" }).greet()) // Hi Ada
```

## Inheritance

A struct can `extend` another, inheriting its fields, defaults and methods:

```js
struct User {
    name: string
    role: string = "member"
}

struct Admin extends User {
    level: int
}

const a = Admin.new({ name: "Bob", level: 9 })
log(a.role) // member
```

## Readonly fields

`readonly` fields can't be reassigned: the static checker reports it, and instances made with `Struct.new(...)` refuse the write at runtime:

```js
struct Account {
    readonly id: int
    owner: string
}

const acc = Account.new({ id: 1, owner: "Ada" })
acc.owner = "Bob" // ok
acc.id = 2        // ❌ "Account.id" is readonly
```

## Generic structures

Structs can be generic. Type arguments are checked at runtime and by the static checker:

```js
struct User {
    name: string
}

struct Page<T> {
    items: T[]
    total: int
}

const users: Page<User> = JSON.parse(`{ "items": [{ "name": "Ada" }], "total": 1 }`) // every item must be a valid User
log(users.items[0].name)                                   // Ada
log(Page.verifySafe({ items: [1, 2], total: 2 }, ["int"]).success) // true
```

The second argument of `verify`/`verifySafe` gives the type arguments when there is no typed variable.

Generic struct methods get their types from the instance:

```js
struct Box<T> {
    value: T
    set(value: T) { this.value = value }
}

const box: Box<int> = { value: 1 }
box.set("text")             // ❌ argument "value" of "Box<int>.set" expects int, got string
```

A struct's type parameters take constraints with `extends`, checked wherever the struct is used as a type: with `struct Page<T extends Named>`, `Page<int>` is a compile error. Struct methods can have their own type parameters, with constraints, too:

```js
trait Named {
    name: string
}

struct Box<T> {
    value: T
    label<U extends Named>(u: U) -> string { return u.name }
}

const box: Box<int> = { value: 1 }
box.label(5)   // ❌ type parameter "U" of "Box<int>.label" must fit Named, got int
```

## Structures and traits

A struct can promise to provide the fields and methods of a trait with `implements`; see [Traits](04-traits.md).

Next: [Traits](04-traits.md).
