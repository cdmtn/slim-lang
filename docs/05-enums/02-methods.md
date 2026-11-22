# Enum Methods

We'll use this enum in the examples:

```js
enum Roles {
    admin: 0
    moderator: 1
    user: 2
}

log(Roles.values())             // [0, 1, 2]
log(Roles.keys())               // ["admin", "moderator", "user"]
log(Roles.has(0))               // true
log(Roles.has(Roles.admin))     // true
log(Roles.has(5))               // false
log(Roles.scheme())             // { admin: 0, moderator: 1, user: 2 }
log(Roles.from(2) == Roles.user) // true
```

## values method

Returns the values of the members.

## keys method

Returns the names of the members.

## has method

Checks whether a value (a raw value or a member) belongs to the enum.

## scheme method

Returns an object that maps member names to values.

Enums with data have `keys`, `values`, `has` and [`fromJSON`](04-enums-with-data.md#printing-and-json) instead of `scheme` and `from`.

## from method

`Role.from(value)` turns a raw value into an enum member and throws `EnumError` for unknown values. A literal that is not a value of the enum is a compile error:

```js
enum Role {
    Member: 0
    Helper: 1
    Admin: 2
}

const role = Role.from(JSON.parse("2"))  // Role.Admin
log(role == Role.Admin)                  // true

Role.from(7)                             // ❌ 7 is not a value of "Role" — use one of 0, 1, 2
Role.from(JSON.parse("7"))               // ❌ EnumError: 7 is not a value of enum "Role"
```

## Members

Each member has a `.value` with its raw value:

```js
enum Color {
    Red: "red"
    Green: "green"
}

log(Color.Red.value)    // red
```

Next: [Using enums in structures](03-using-in-structures.md).
