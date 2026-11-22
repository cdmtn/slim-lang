# Using Enums in Structures

An enum can be the type of a struct field, a variable or a parameter. Then the value has to be one of its members, or the raw value of one of them:

```js
enum Role {
    Member: 0
    Helper: 1
    Admin: 2
}

struct User {
    name: string
    role: Role
}

log(User.verifySafe({ name: "John", role: Role.Admin }).success)  // true
log(User.verifySafe({ name: "John", role: 2 }).success)           // true: 2 is the value of Role.Admin
log(User.verifySafe({ name: "John", role: 7 }).success)           // false
```

A raw value is accepted but not converted: it stays the number `2`, and `2 == Role.Admin` is `false`. Convert data from outside with `Role.from(value)` before you compare it with members:

```js
enum Role {
    Member: 0
    Helper: 1
    Admin: 2
}

const data = JSON.parse(`{ "name": "John", "role": 2 }`)
const role = Role.from(data.role)

log(role == Role.Admin)      // true
log(data.role == Role.Admin) // false
```

## One member as a type

`Enum::Member` is the type of a single member. To validate data, you can use it in structures as a validation value:

__Example of use__
```js
enum Role {
    Member: 0
    Helper: 1
    Admin: 2
}

const user = {
    name: "John",
    role: Role.Admin
}

struct Helper {
    name: string
    role: Role::Helper
}

Helper.verify(user) // ❌ StructError: "Helper.role" expected Role::Helper, got enum: {"value":2}
```

This code throws an error because `user.role` is `Role.Admin`, but the structure requires `Role.Helper`.

A `match` over an enum has to handle every member; see [match](../06-operators/06-match.md). A `switch` is checked only when the function would otherwise reach its end without a `return`.

Next: [Enums with data](04-enums-with-data.md).
