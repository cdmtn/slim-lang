# Structure Methods

## verify method

Once you've created a structure, you can use its methods to validate data. Let's look at a structure for user data and how to apply it:

__Let's imagine we've received data from an API__
```js
struct User {
    name: string
    age: int
    verified: bool
}

const UserAPI = JSON.parse(`{ "name": "John", "age": 20, "verified": 1 }`)

User.verify(UserAPI) // ❌ StructError: "User.verified" expected bool, got int: 1
```

`.verify()` throws a `StructError` because the `verified` field is an int, not a bool. For valid data it returns the value.

## verifySafe method

We can validate the data without crashing the application. `verifySafe` returns an object with the validation result instead of throwing an error:

```js
struct User {
    name: string
    age: int
    verified: bool
}

const UserAPI = JSON.parse(`{ "name": "John", "age": 20, "verified": 1 }`)

log(User.verifySafe(UserAPI))
```
```text
{
  success: false,
  result: {
    type: 'StructError',
    msg: 'StructError: "User.verified" expected bool, got int: 1'
  },
  properties: {
    name: 'User',
    field: 'verified',
    expected: 'bool',
    got: 'int',
    fieldName: 'User.verified'
  }
}
```

For valid data it returns `{ success: true, result: <the value> }`.

## new method

`.new()` creates a new object with the structure as its template. The object is filled with [defaults](03-additionally.md#structure-defaults), validated and returned:

```js
struct User {
    name: string
    age: int
    verified: bool = false
}

log(User.new({ name: "John", age: 20 })) // { verified: false, name: "John", age: 20 }
```

Objects made with `.new()` also get the struct's [methods](03-additionally.md#structure-methods) and refuse writes to [readonly fields](03-additionally.md#readonly-fields).

An object literal written where a struct type is declared is built the same way, with defaults, methods and readonly fields. That covers typed variables, `return` in a function with a struct return type, arrays of literals, and nested struct fields:

```js
struct User {
    name: string
    role: string = "member"
}

const u: User = { name: "Alice" }              // same as User.new({ name: "Alice" })
const team: User[] = [{ name: "A" }, { name: "B" }]

func guest() -> User { return { name: "guest" } }

log(u.role, team[1].role, guest().name) // member member guest
```

Next: [Additional features](03-additionally.md).
