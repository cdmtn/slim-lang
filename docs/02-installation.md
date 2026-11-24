# Installation

There are two official ways to install Slim: from npm and from source. Both give you `slmc`, the compiler and project CLI. The package manager `spm` is a separate package, `@slim-lang/spm`: install it when you need packages (see [spm](04-CLI/02-spm.md)).

Before installation, make sure you have the following:

| Name     | Version  | Download link                  |
|----------|----------|--------------------------------|
| Node.js  | 22.12+   | https://nodejs.org/en/download |
| Git      | any recent version (needed for source installation) | https://git-scm.com/install/ |

## NPM installation

Install it in your project:

```bash
npm i @slim-lang/core
npx slmc --version
```

or globally, to have `slmc` everywhere:

```bash
npm i -g @slim-lang/core
```

Check it with `slmc --version` (`npx slmc --version` for a local installation).

## Source installation

__1. Clone the repository__

```bash
git clone https://github.com/cdmtn/slim-lang.git
cd slim-lang
```

__2. Install the dependencies and link the CLI__

```bash
npm i
npm link
```

* On macOS and Linux `npm link` may fail with a permission error; try `sudo npm link`.

__3. Check that the Slim CLI is installed__

```bash
slmc --version
```

## Creating a project

`slmc` works in a folder that has a `package.json`, so start with one:

```bash
mkdir my-app
cd my-app
npm init -y
```

Then scaffold everything at once: `slimconfig.json` plus a starter `index.slim`:

```bash
slmc init
slmc run
```

```text
Hello, Slim!
```

Or create the pieces one by one:

```bash
slmc create --config
slmc config -S main=index
slmc create --file index
slmc run
```

This creates `slimconfig.json`, sets `index` as the entry point, creates an empty `index.slim`, then compiles and runs it.

## What is in a project

| File | Purpose |
|---|---|
| `slimconfig.json` | Project configuration: the entry file (`main`), the output folder and compiler options. See [Configuration](04-CLI/03-configuration.md) |
| `index.slim` | The entry file named by `main` |
| `slim-dist/` | Compiled JavaScript, written by `slmc build` and `slmc run` (change it with `names.dist`) |
| `packages/` | Packages installed with `spm` (change it with `names.packages`) |
| `spm.lock.json` | The exact commit of each installed package |
| `slimserver.json` | Settings of the [Slim server](11-server-rendering/02-slim-server.md), next to the entry file |

`slmc init` writes this `slimconfig.json`:

```json
{
    "main": "index",
    "warnings": true,
    "uses": {
        "style": "import",
        "enabled": true
    }
}
```

and this `index.slim`:

```js
struct User {
    name: string
    id: int
}

const user: User = { name: "Slim", id: 1 }
log(`Hello, ${user.name}!`) // Hello, Slim!
```

Next: [learn about Slim types](03-types/01-about-types.md), or see every [slmc command](04-CLI/01-slmc.md).
