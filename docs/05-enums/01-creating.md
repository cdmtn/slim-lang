# Enum Creation

An enum in Slim is a set of named constants - almost like an object, but its members are values of their own that the type system, structures and [`match`](../06-operators/06-match.md) understand.

## How to create an enum?

You create an enum just like a structure - using the keyword `enum`:

```js
enum Roles {
    admin: 0
    moderator: 1
    user: 2
}
```

Where:
- `enum` - keyword
- `Roles` - enum name
    - `admin` - enum member with value `0`
    - `moderator` - enum member with value `1`
    - `user` - enum member with value `2`

Members are written one per line (or separated by commas). A value can be a number or a string.

A member without a value follows the previous number; in an enum without numbers it takes its own name:

```js
enum Level {
    Low: 1
    Mid
    High
}                       // Mid is 2, High is 3

enum Direction { Up, Down } // "Up", "Down"

log(Level.High.value)       // 3
log(Direction.values())     // ["Up", "Down"]
```

## Members are not raw values

`Roles.admin` is an enum member, not the number `0`. Its raw value is in `.value`. Compare members with members:

```js
enum Roles {
    admin: 0
    moderator: 1
    user: 2
}

const role: Roles = Roles.moderator

log(role == Roles.moderator)    // true
log(role.value)                 // 1
log(Roles.admin == 0)           // ❌ this comparison is always false: "Roles.admin" is a Roles member and int is a raw value — compare with Roles.from(0)
```

Comparing a member with a raw value is always false, so the checker reports it. To turn a raw value (from JSON, a form, a database) into a member, use [`from`](02-methods.md#from-method). Arithmetic on a member is a compile error that suggests `.value`.

## What object is generated?

An enum, like a structure, is converted into a JavaScript object that also contains other properties:

```text
{
  type: Enum { name: 'Roles' },
  name: 'Roles',
  scheme: [Function: scheme],
  values: [Function: values],
  keys: [Function: keys],
  has: [Function: has],
  from: [Function: from],
  admin: EnumValue { value: 0 },
  moderator: EnumValue { value: 1 },
  user: EnumValue { value: 2 }
}
```

Members can also carry data, like `Shape.Circle(2.0)`; see [Enums with data](04-enums-with-data.md).

Next: [Enum methods](02-methods.md).
