# Creating Structures

In Slim, structures are real JavaScript objects that describe and validate incoming and outgoing data. Unlike TypeScript interfaces, they are not erased: a struct checks data while the program runs. Here's a simple example of creating a structure:

```js
struct Me {
    name: string
    age: int
    balance?: float
}
```

Where:
- `struct` - keyword
- `Me` - name of the structure
    - `name` - a field that must be of type `string`
    - `age` - a field that must be of type `int`
    - `balance` - a field that must be of type `float` (optional: it may be missing)

Fields are written one per line (or separated by commas). A field type can be any Slim type: a built-in type, another struct, an enum, a custom type, an array, a union and so on.

## Where structures are checked

A struct validates a value when:

- you call `Struct.verify(value)`, `Struct.verifySafe(value)` or `Struct.new(value)` (see [Structure methods](02-methods.md));
- the value is assigned to a variable, passed to a parameter or returned from a function typed with the struct;
- the value is a field of another struct being checked.

A struct rejects missing required fields, fields of the wrong type and fields it doesn't declare.

```js
struct User {
    name: string
    age: int
}

const u: User = { name: "Ada", age: 36 }         // ok
const v: User = { name: "Ada", age: "old" }      // ❌ "User.age" expects int, got string
```

## What kind of object will be generated?

As mentioned earlier, a structure is converted into a JavaScript object after compilation.

__"Me" structure in JavaScript__
```text
{
  type: [class Struct],
  name: 'Me',
  parent: null,
  scheme: {
    name: { type: 'string', specification: [Array], optional: false },
    age: { type: 'int', specification: [Array], optional: false },
    balance: { type: 'float', specification: [Array], optional: true }
  },
  typeParams: [],
  readonly: [],
  __defaults__: {},
  __methods__: {},
  verify: [Function: verify],
  verifySafe: [Function: verifySafe],
  new: [Function: new]
}
```

A struct is not a class: create a value with `User.new({ ... })` or an object literal where a `User` is expected, not with `new User()` (the checker reports that).

Next: [Structure methods](02-methods.md).
