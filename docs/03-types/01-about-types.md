# About Slim Types

Slim has its own types, which are used in structures, typed variables, typed parameters and return types, and in all other systems that Slim adds and where these types are appropriate. They give data a clear shape and make validation possible in two places:

- **at compile time**, the static checker reports every conflict it can prove (see [Static checking](../14-static-checking/01-overview.md));
- **at runtime**, a typed variable, parameter, return value or struct field checks the value it receives. These checks are not erased during compilation.

## What types are there?

These names can be used in any type annotation:

| Type      | Meaning                                       | Example            |
|-----------|-----------------------------------------------|--------------------|
| string    | String value                                  | "a"                |
| int       | An integer, positive or negative, within ±2^53 (a safe integer) | -3, 0, 1 |
| float     | Any number except `NaN`, integers included (the same as `number`) | 1.5, 2 |
| number    | The same as `float`                           | 1, 1.5             |
| bool      | true or false                                 | true               |
| array     | Any array                                     | [1, "a"]           |
| object    | A plain object or an instance of a class or struct (not an array, `Map`, `Set`, `Date`, `RegExp`, `Error` or `Promise`) | { a: true } |
| function  | Function                                      | () => {...}        |
| element   | A DOM element                                 | `<div>` built by a component |
| null      | `null`                                        | null               |
| undefined | `undefined`                                   | undefined          |
| void      | No value (for functions that return nothing)  | undefined          |
| any       | Any value (skips the check)                   | Any value          |
| unknown   | Any value (skips the check)                   | Any value          |
| bigint    | BigInt                                        | 10n                |

Besides them, a type can be:

- a struct, an enum, a trait or a custom type you declared ([structures](../07-structures/01-creating.md), [enums](../05-enums/01-creating.md), [traits](../07-structures/04-traits.md), [custom types](02-custom-types.md));
- an array of a type: `int[]`, `User[]`;
- a nullable type, a union, an intersection, a literal, a tuple, an object type or a generic container (`Map<string, int>`): see [Type expressions](03-type-expressions.md);
- a built-in class, matched with `instanceof`: `Date`, `RegExp`, `Error`, `Map`, `Set`, `Promise`, or a class of your own;
- a validator from the [standard library](../09-imports/04-standard-library.md) (`spm i std`), such as `email`, `uuid` or `positive`.

## What `kindof` reports

The [`kindof`](../06-operators/01-kindof.md) operator returns the type of a value as a string in the same format:

```js
log(kindof true)        // bool
log(kindof 1)           // int
log(kindof -3)          // int
log(kindof 1.5)         // float
log(kindof "a")         // string
log(kindof null)        // null
log(kindof undefined)   // undefined
log(kindof { a: 1 })    // object
log(kindof (() => 1))   // function
log(kindof new Date())  // date
log(kindof 10n)         // bigint
```

`kindof` also reports `struct`, `enum` and `component` for a struct, an enum (or one of its members) and a component. These are not annotations: write the struct's or the enum's own name instead (`let u: User`, `let r: Role`).

An array of strings, ints, floats, plain objects, structs or enum values of one kind gets the type of its items (`int[]`). A mix of numbers is `number[]`, an empty array is `null[]`, and anything else (booleans, nested arrays, a mix) is `array`:

__Array type example__

```js
log(kindof [1, 2, 3])       // int[]
log(kindof ["a", "a", "a"]) // string[]
log(kindof [1, 1.5])        // number[]
log(kindof [1, "hello"])    // array
log(kindof [])              // null[]
```

An empty array `[]` fits any `T[]`.

## Typed variables

A type after a variable name is checked when the variable is created and every time it is assigned:

```js
let name: string = "Slim"
name = "Ada"            // ok

let age: int = 20
age = JSON.parse("1.5") // ❌ TypeError: The variable "age" is of type int, but it was redefined with type float: 1.5
```

A literal of the wrong type is a compile error, so the program is not built at all:

```js
let n: int = 1.5 // ❌ "n" expects int, got float
```

Constants without a type get one from their value (`const n = 1` is an `int`), and the checker uses it. See [Type inference](../14-static-checking/03-inference-and-generics.md).

Next: [Custom types](02-custom-types.md).
