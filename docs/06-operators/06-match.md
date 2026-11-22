# match Operator

`match` is an expression that returns the branch whose pattern matches the subject. `_` is the fallback; without it, an unmatched value returns `undefined`. A case with an enum member also matches that member's raw value: `match (2)` picks `Role.Admin`, unlike `2 == Role.Admin`, which is `false`.

```js
enum Role {
    Member: 0
    Admin: 2
}

func label(role: Role) -> string {
    return match (role) {
        Role.Admin => "administrator",
        Role.Member => "member",
        _ => "guest"
    }
}

log(label(Role.Admin)) // administrator
```

Branches are separated by commas, and each one is `pattern => expression`.

## Guards

A case can bind the subject to a name and add a `when` guard:

```js
func size(n: int) -> string {
    return match (n) {
        x when x > 10 => "big",
        x when x > 0 => "small",
        _ => "nonpositive"
    }
}

log(size(42)) // big
log(size(-1)) // nonpositive
```

## Every case handled

A `match` over an enum has to handle every member, or say it does not with `_`:

```js
enum Role {
    Member: 0
    Admin: 2
}

func label(role: Role) {
    return match (role) {   // ❌ match on "Role" does not handle Role.Member — add the missing case or a "_" fallback
        Role.Admin => "administrator"
    }
}
```

A match over a union of literals (`"a" | "b"`) has to handle each value. Slim skips the completeness check when guarded value cases are mixed in.

## Matching by type

A case can also match by type and name the value for its branch. Over a union, every member has to be handled, the same way as an enum:

```js
struct Circle { radius: float }
struct Square { side: float }
type Shape = Circle | Square

func area(s: Shape) -> float {
    return match (s) {
        Circle c => 3.14 * c.radius * c.radius,
        Square q => q.side * q.side
    }
}

func show(value: int | string | bool) {
    return match (value) {  // ❌ match on (int | string | bool) does not handle bool
        int n => "number",
        string s => s
    }
}
```

A type case may have a `when` guard too (`Square q when q.side > 10 => ...`); a guarded case doesn't count towards handling its type.

## Destructuring patterns

Objects and arrays can be taken apart in a case. A name in a pattern binds the value at that place, a literal or an enum member has to match it, `_` skips it and `...rest` collects what is left:

```js
func describe(event) -> string {
    return match (event) {
        { type: "click", pos: [x, y] } => `click at ${x},${y}`,
        { type: "key", key: "Enter" } => "enter",
        { type: "key", key, ...modifiers } when modifiers.shift => `shift+${key}`,
        [first, ...others] => `${others.length + 1} events`,
        _ => "other"
    }
}

log(describe({ type: "click", pos: [3, 4] }))            // click at 3,4
log(describe({ type: "key", key: "a", shift: true }))    // shift+a
log(describe([1, 2, 3]))                                 // 3 events
```

An array pattern matches only an array of that length (or at least that length with `...rest`). A pattern over a union of structs with a literal field narrows the value, so `{ kind: "circle", side }` on `Circle | Square` is a compile error when `Circle` has no `side`. Such a match has to handle every struct of the union, the same way as an enum: `match (shape) { { kind: "circle", r } => r }` reports that `Square` is not handled.

## Enums with data

Members that carry values are taken apart by position: `Shape.Circle(r) => ...`. See [Enums with data](../05-enums/04-enums-with-data.md).

Next: [Other operators](07-other-operators.md).
