# Narrowing and Null Safety

## Unions and narrowing

A union only fits where every part of it fits, so an `int | string` is not an `int` and a `string?` is not a `string`. A check narrows the type for the code it guards: `if`, `? :`, `&&`, `||`, `??`, an early `return` or `throw`, `typeof`, `kindof`, `instanceof`, `== null` and `Array.isArray`:

```js
func show(v: int | string, name: string?) {
    let n: int = v          // ❌ "n" expects int, got (int | string)

    if (kindof v == "int") {
        let m: int = v      // ok: v is an int here
    }

    if (name == null) return
    let s: string = name    // ok: name can't be null past the return
}
```

`"field" in value` narrows a union of structs to the members that have that field.

A variable declared without a type and assigned again in the same function has the type of all its values (`let x = 1` and `x = "a"` give `int | string`).

## Narrowing ends

Assigning a variable again after the check undoes the narrowing, and a callback created inside the check doesn't keep it when the variable is assigned again later, because the callback may run after that:

```js
struct User { name: string }

func watch(u: User?) {
    let current = u
    if (current) {
        setTimeout(() => log(current.name), 100)   // ❌ "current" may be null here (User?) — check it first or use "?."
    }
    current = null
}
```

A narrowing of a field ends when the field is written to: after `user.address = undefined`, `user.address.city` is an error again. An assignment narrows instead, so `if (!user.address) user.address = fallback` leaves `user.address` set for the code below.

## Null safety

A value that may be `null` or `undefined` can't be read without a check or `?.`:

```js
struct Address { city: string }
struct User {
    id: int
    address: Address
}

func city(user: User?) -> string {
    return user.address.city      // ❌ "user" may be null here (User?) — check it first or use "?."
}

func name(users: User[], id: int) {
    return users.find(u => u.id == id).address  // ❌ "users.find(...)" may be undefined here
}
```

Reading a `Record` gives `V | undefined`, until `k in rec` says the key is there. The keys written in a `const` record literal are always there:

```js
const temps: Record<string, int> = { sunny: 30, rain: 10 }

func temp(name: string) -> int {
    if (name in temps) return temps[name]   // ok
    return temps.sunny                      // ok, the literal has "sunny"
}

const t: int = temps.snow                   // ❌ "t" expects int, got (int | undefined)
```

An optional struct field reads as `T | undefined`. The same goes for calling a function that may be missing, such as an optional field `onClose?: () => void`: `props.onClose()` is an error, `props.onClose?.()` or a check first is fine.

Using a possibly-null value where it would fail or give a wrong result is reported too:

```js
func sum(xs: int[]?, x: int?) {
    for (const n of xs) log(n)      // ❌ "xs" may be null here (int[]?) — check it first: null can't be iterated
    log(x + 1)                      // ❌ "x" may be null here (int?) — check it first: null in "+" gives a wrong result
}

func greet(name?: string) -> int {
    return name.length              // ❌ "name" may be undefined here (string | undefined)
}
```

## Unions of structs

A union of structs that share a literal field narrows by that field, in `if`, `switch` and `match`. A field that only some members have can't be read before that:

```js
struct Circle {
    kind: "circle"
    radius: float
}
struct Square {
    kind: "square"
    side: float
}
type Shape = Circle | Square

func area(s: Shape) -> float {
    log(s.radius)                      // ❌ "Square" has no field "radius" — narrow it to "Circle" first
    if (s.kind == "circle") return s.radius * s.radius
    return s.side * s.side
}
```

Next: [Inference and generics](03-inference-and-generics.md).
