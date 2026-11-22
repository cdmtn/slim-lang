<div align="center">
  <img width="800" src="https://github.com/user-attachments/assets/29849f19-9e0f-49d0-a188-74714c14b0a4" />
  <h1>Slim</h1>
  <h4 align="center">Slim extends JavaScript with runtime types, structs, operators, and components, compiling to plain Javascript</h4>
</div>

<div align="center">
    <a href="https://codemotion.yurba.one/github">CodeMotion IDE</a>
    ⋅
    <a href="https://codemotion.yurba.one/telegram">Telegram (News on russian)</a>
    ⋅
    <a href="docs/index.md">Documentation</a>
</div>

<br>

> [!IMPORTANT]
> Slim is still early in development. Please report bugs in Issues and send pull requests for improvements.

Types in Slim are not erased: typed variables, parameters, return values and structs check the values they receive at runtime, and a static checker reports what it can prove at compile time. Slim compiles to plain ES modules and works directly with npm packages. See [What is Slim?](docs/01-start.md) for how it compares with JavaScript and TypeScript.

## Install

Requirements: Node.js 22.12+ and Git.

```console
npm i -g @slim-lang/core
slmc --version
```

The package manager is a separate package: `npm i -g @slim-lang/spm` (see [spm](docs/04-CLI/02-spm.md)).

Or from source:

```console
git clone https://github.com/cdmtn/slim-lang.git
cd slim-lang
npm i
npm link
```

Create a project (in a folder with a `package.json`) and run it:

```console
slmc init
slmc run
```

See [Installation](docs/02-installation.md) for local installs and project setup.

## A quick look

```js
struct User {
    name: string
    roles: string[]
}

func greet(user: User) -> string {
    return `Hello, ${user.name}!`
}

log(greet({ name: "Ada", roles: ["admin"] }))                  // Hello, Ada!
log(greet(JSON.parse(`{ "name": "John", "roles": [1, 2] }`))) // ❌ TypeError: function "greet": argument<0> "user" expected User, got object
```

```js
component Counter() {
    state count = 0
    return <button onClick=${() => count++}>Clicked ${count} times</button>
}
```

## Main commands

| Command | What it does |
|---|---|
| `slmc init` | Create `slimconfig.json` and a starter `index.slim` |
| `slmc build` | Compile the project into `slim-dist/` (`--release`, `--no-check`, `--force`) |
| `slmc run` | Build and run the project |
| `slmc server --dev` | Run the Slim server with watch, rebuild and live reload |
| `slmc test` | Run `*.test.slim` files (`--filter`, `--coverage`) |
| `slmc fmt` | Format Slim source |
| `slmc repl` | Interactive REPL |
| `spm i <name>` | Install a package (`@slim-lang/spm`) |

All commands and options: [slmc](docs/04-CLI/01-slmc.md), [spm](docs/04-CLI/02-spm.md).

## Documentation

The full documentation is in [docs/](docs/index.md):

- [What is Slim?](docs/01-start.md) and [Installation](docs/02-installation.md)
- [Types](docs/03-types/01-about-types.md): built-in types and validators, [custom types](docs/03-types/02-custom-types.md), [type expressions](docs/03-types/03-type-expressions.md), [typed functions](docs/03-types/04-functions.md), [Result and Option](docs/03-types/05-result-and-option.md)
- [CLI](docs/04-CLI/01-slmc.md) and [configuration](docs/04-CLI/03-configuration.md)
- [Enums](docs/05-enums/01-creating.md), [operators](docs/06-operators/01-kindof.md) and [match](docs/06-operators/06-match.md)
- [Structures](docs/07-structures/01-creating.md) and [traits](docs/07-structures/04-traits.md)
- [Components](docs/08-components/01-creating.md) and [custom elements](docs/08-components/02-custom-elements.md)
- [Imports](docs/09-imports/01-use-imports.md), npm packages, [Slim modules and the standard library](docs/09-imports/04-standard-library.md)
- [Reactivity](docs/10-reactivity/index.md): state, effects, forms, resources, context, routing
- [Server rendering](docs/11-server-rendering/01-render-and-hydrate.md) and the [Slim server](docs/11-server-rendering/02-slim-server.md)
- [Error handling](docs/12-error-handling.md) and [testing](docs/13-testing.md)
- [Static checking](docs/14-static-checking/01-overview.md)
- [Build and runtime](docs/15-build-and-runtime/01-release-mode.md): release mode, runtimes, TypeScript output, dev server, JavaScript API

## Contributing

Run the test suite with:

```console
npm test
```
