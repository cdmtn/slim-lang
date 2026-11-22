# Custom Types

Slim has a system for creating your own types. This is useful for data validation, since custom types are treated on the same level as the predefined ones: they can be used in typed variables, parameters, return types, struct fields, unions and arrays.

There are two kinds of custom types: **validators**, which check a value with code, and **aliases**, which give a name to a type expression.

## Validator types

__Example__
```js
type MyType(value) {
    return kindof value == "int" or kindof value == "float"
}
```

Where:
- `type` - keyword
- `MyType` - name of the custom type
- `value` - the argument that receives the value being checked

The body runs every time a value of this type is checked. The value is valid only when the body returns `true`; any other result rejects it, even a truthy one (return `s.length > 0`, not `s.length`). A type with an empty body accepts every value.

Once you've created your own type, you can use it anywhere you can use standard types. In the example above, we created a check that accepts both an `int` and a `float`.

__Example of use__
```js
type MyType(value) {
    return kindof value == "int" or kindof value == "float"
}

let a: MyType = 1               // ✅
let b: MyType = 1.5             // ✅
let c: MyType = JSON.parse(`"String"`) // ❌ TypeError: The "c" is of type MyType, but was assigned a string: "String"
```

Values of a validator type are checked when the program runs. A literal is also checked at compile time when the body is simple: a single `return` of an expression made of the value, literals, `typeof`, `kindof`, `sizeof`, comparisons, arithmetic, `and`/`or`/`!`, `? :`, `.length`, `Number.isInteger` (and `isFinite`, `isNaN`, `isSafeInteger`), `Array.isArray`, a regular expression's `.test`, and a string's `startsWith`, `endsWith` and `includes`. The checker works the expression out itself and runs nothing:

```js
type MyType(value) {
    return kindof value == "int" or kindof value == "float"
}

let d: MyType = "String"    // ❌ "d" expects MyType, got "String"
```

A body with anything else (a variable, a call to your own function, a global) is left to the runtime, and so is a value that isn't a literal.

### Building on another type

`extends` after the parameter list checks a type first and runs the body only for values that fit it:

```js
type Port(value) extends int {
    return value > 0 and value < 65536
}

let port: Port = 8080                   // ✅
let other: Port = JSON.parse("1.5")     // ❌ TypeError: The "other" is of type Port, but was assigned a float: 1.5
```

A literal is checked against the type after `extends` at compile time too, whatever the body: `let p: Port = 1.5` is a compile error.

The base type can also be written on the parameter. This is the same `Port`:

```js
type Port(value: int) {
    return value > 0 and value < 65536
}
```

Use one of the two forms: a type that has both, `type Port(value: int) extends int`, is a syntax error.

A body that only tests a string, such as a regular expression's `.test`, needs a base type: `.test` turns any value into a string first, so without `extends string` an array `["1.2.3"]` would pass as `"1.2.3"`.

### Combining validators

Custom types combine with `|` (union, matches any) and `&` (intersection, matches all), like any other type:

```js
type Positive(v) { return v > 0 }
type Even(v) { return v % 2 == 0 }

let n: Positive & Even = 4                  // ✅
let m: Positive & Even = JSON.parse("3")    // ❌ TypeError: The "m" is of type Positive & Even, but was assigned a int: 3
```

## Type aliases

`type Name = ...` names a type expression. Aliases are known to the static checker, so a wrong literal is reported at compile time:

```js
type Role = "admin" | "user"
type Id = int | string

func setRole(role: Role) { return role }

setRole("admin")    // ✅
setRole("guest")    // ❌ argument "role" of "setRole" expects Role, got "guest"

let ids: Id[] = [1, "a"]
```

An alias can take type parameters: `type Pair<T> = [T, T]`. See [Type expressions](03-type-expressions.md) for everything that can go on the right side.

## Ready-made types

The [standard library](../09-imports/04-standard-library.md) (`spm i std`) has custom types you can import, for example `odd`, `even` and `nonZero`:

```js
use { odd } from @std/types/numerical

let n: odd = 3
```

Next: [Type expressions](03-type-expressions.md).
