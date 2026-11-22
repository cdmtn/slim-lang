# What is Slim?

Slim extends JavaScript with runtime types, structs, operators and components, and compiles to plain JavaScript (ES modules).

Slim builds on JavaScript syntax: it adds keywords (`struct`, `enum`, `type`, `trait`, `component`, `state`, `func`, `use`, `match`...), type annotations and a few operators on top of the language you already know. The compiler also checks your code statically, so some JavaScript that would only fail when it runs (an undeclared name, a call with the wrong arguments) is a compile error in Slim.

## Why Slim?

Slim is for projects where data validation needs to stay in the running program. Types are not erased: typed variables, parameters, return values and structs check the values they receive at runtime, and a static checker reports what it can prove at compile time. Slim compiles to JavaScript and works directly with npm packages. It fits API clients and servers, CLI tools, scripts, UI forms, libraries and embedded JavaScript environments.

| | JavaScript | TypeScript | Slim |
|---|---|---|---|
| Static checks | No | Yes | Yes, where possible |
| Runtime validation | Manual | Manual or libraries | Built in for typed values and structs |
| Data modelling | Objects and classes | Interfaces and types | Structs, enums, defaults, inheritance, validators |
| API and external data | Trust it or validate manually | Types are erased at runtime | Validate at the boundary with a `struct` or `type` |
| Components | Native APIs or a framework | Native APIs or a framework | Reactive components and custom elements, no virtual DOM |
| Tooling | Depends on the project | Depends on the project | Compiler, formatter, test runner, REPL, dev server, web server; package manager `spm` as a separate package |

Slim does not aim to replace TypeScript everywhere. It is useful when runtime guarantees and built-in language tools matter.

## A first look

A typed parameter checks data from outside where it enters your code:

```js
func total(prices: float[]) -> float {
    return prices.reduce((sum, p) => sum + p, 0)
}

log(total([1.5, 2]))                     // 3.5
total(JSON.parse(`[9.99, "5"]`))         // ❌ TypeError: function "total": argument<0> "prices" expected float[], got array
```

What can be proven before the program runs is reported at compile time, and no compiled file is written:

```js
struct User {
    name: string
    age: int
}

const u: User = { name: "Ada", age: "old" } // ❌ "User.age" expects int, got string
```

```text
TypeError: "User.age" expects int, got string
    at index.slim:6:37

  const u: User = { name: "Ada", age: "old" }
                                      ^
```

## Next steps

- [Install Slim](02-installation.md) and create a project
- Read about [types](03-types/01-about-types.md) and [structures](07-structures/01-creating.md)
- Build a UI with [components](08-components/01-creating.md) and [reactivity](10-reactivity/index.md)

Next: [Installation](02-installation.md).
