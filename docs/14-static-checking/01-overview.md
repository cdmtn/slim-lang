# Static Checking

Before building, Slim checks literals, arithmetic, arrays, struct instances, typed parameters, return types, components and markup. A definite conflict is a compile error: the build stops and the file is not written:

```text
TypeError: "User.age" expects int, got string
    at index.slim:10:37

  const u: User = { name: "Ada", age: "old" }
                                      ^
```

It catches invalid literals and reassignments, invalid struct fields, missing field access, array or tuple element errors, incompatible returns, incomplete enum matches, and calls with the wrong arguments:

```js
struct User {
    name: string
    age: int
}

func greet(user: User, times: int) { return user.name }

let n: int = 1.5                            // ❌ "n" expects int, got float
const u: User = { name: "Ada", age: "old" } // ❌ "User.age" expects int, got string
greet(u)                                    // ❌ "greet" expects 2 arguments, got 1
```

Static checks run before runtime validation, and they don't replace it: calls into npm packages, unknown imports and custom `type` validators that Slim can't work out stay unknown and are checked at runtime. Slim reports only conflicts it can prove.

## Pages in this section

- [Narrowing and null safety](02-narrowing-and-null-safety.md): unions, `null`, and how checks narrow a type
- [Inference and generics](03-inference-and-generics.md): types of unannotated code, generic functions and structs, classes
- [More checks](04-more-checks.md): common mistakes that are compile errors
- [Host declarations](05-host-declarations.md): `globals`, `global` and `host` for names that come from elsewhere

## Did you mean?

Typos get a suggestion: unknown struct fields, enum members, type names, string and array methods, and names that are not declared but look like one that is:

```js
struct User { name: string }
enum Role { Admin: 1 }

const user = User.new({ name: "Ada" })
const users = [user]
const title = "Slim"

log(user.nmae)       // ❌ "User" has no field "nmae" — did you mean "name"?
log(Role.Admn)       // ❌ "Role" has no member "Admn" — did you mean "Admin"?
log(title.lenght)    // ❌ string has no property "lenght" — did you mean "length"?
log(usres)           // ❌ "usres" is not defined — did you mean "users"?
```

A name or a type that nothing declares is an error, with or without a close match.

## Turning checks off

Disable static checks for one build with `slmc build --no-check`, or in the config:

```json
{
    "main": "index",
    "check": false
}
```

## Warnings

Besides errors, the compiler prints warnings that don't stop the build: a variable, function or `use` import that is never used, code after `return`, `throw`, `break` or `continue` (inside a component it is an error), markup joined with `+` or `.join(...)`, and a call that passes a value from `state` to a function that changes its parameter. The page doesn't see a change made through a parameter: change the value through the state's own name, or give the state a new value. A variable or function whose name starts with `_` is not reported. Turn warnings off with `"warnings": false` in `slimconfig.json` (or `transform(code, file, { warnings: false })`):

```text
Warning: "greet" is imported but never used
    at index.slim:1:1
```

Next: [Narrowing and null safety](02-narrowing-and-null-safety.md).
