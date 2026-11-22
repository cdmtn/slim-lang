# Slim Documentation

Slim extends JavaScript with runtime types, structs, enums, operators and reactive components, and compiles to plain JavaScript. Types are not erased: a value that comes from an API, a form or a file is checked when it reaches a typed variable, a typed parameter or a struct. Before that, a static checker reports the mistakes it can prove at compile time.

```js
struct User {
    name: string
    id: int
    roles: string[]
}

func greet(user: User) -> string {
    return `Hello, ${user.name}!`
}

log(greet({ name: "Ada", id: 1, roles: ["admin"] })) // Hello, Ada!

const fromApi = JSON.parse(`{ "name": "John", "id": 3, "roles": [1, 2] }`)
User.verify(fromApi) // ❌ StructError: "User.roles" expected string[], got int[]: [1,2]
```

Slim works with npm packages and the JavaScript ecosystem, and it ships its own tools: a compiler with a static checker, a formatter, a test runner, a REPL, a dev server and a web server, plus a package manager, `spm`, installed separately.

## Getting started

- [What is Slim?](01-start.md): why Slim exists and how it compares to JavaScript and TypeScript
- [Installation](02-installation.md): installing the CLI and creating a project

## The language

- [Types](03-types/01-about-types.md): built-in types, [custom types](03-types/02-custom-types.md), [type expressions](03-types/03-type-expressions.md), [typed functions](03-types/04-functions.md), [Result and Option](03-types/05-result-and-option.md)
- [Enums](05-enums/01-creating.md), including [enums with data](05-enums/04-enums-with-data.md)
- [Operators](06-operators/01-kindof.md): `kindof`, `empty`, `sizeof`, `copyof`, `lock`, [`match`](06-operators/06-match.md) and [others](06-operators/07-other-operators.md)
- [Structures](07-structures/01-creating.md) and [traits](07-structures/04-traits.md)
- [Components](08-components/01-creating.md), [markup](08-components/03-markup.md) and [custom elements](08-components/02-custom-elements.md)
- [Imports](09-imports/01-use-imports.md), [npm packages](09-imports/02-npm-packages.md), [Slim modules and the standard library](09-imports/04-standard-library.md)
- [Error handling](12-error-handling.md)

## Building applications

- [Reactivity](10-reactivity/index.md): state, effects, forms, data loading, context, animations, routing
- [Server rendering](11-server-rendering/01-render-and-hydrate.md) and the [Slim server](11-server-rendering/02-slim-server.md)
- [Testing](13-testing.md)

## Tools and reference

- [slmc](04-CLI/01-slmc.md), [spm](04-CLI/02-spm.md) and [slimconfig.json](04-CLI/03-configuration.md)
- [Static checking](14-static-checking/01-overview.md)
- [Build and runtime](15-build-and-runtime/01-release-mode.md): release mode, runtimes, TypeScript output, dev server, formatter, REPL and the JavaScript API
