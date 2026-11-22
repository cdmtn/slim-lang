# "use" Imports

Slim has its own import keyword, `use`, next to JavaScript's `import`. `use` understands `.slim` files and Slim packages; it compiles to a regular `import` of the compiled JavaScript.

## How do I import Slim files?

Export with `export`, as in JavaScript, and import with `use`:

```js
// models.slim
export struct User {
    name: string
    age: int
}

export func greet(user: User) -> string { return `Hi ${user.name}` }

// index.slim
use { User, greet } from "./models"

log(greet(User.new({ name: "Ada", age: 36 }))) // Hi Ada
```

A `.slim` file is imported without the file extension. The usual forms of JavaScript imports work: `use { a, b as c } from "./file"`, `use * as models from "./models"`, and `use name from "module"` for a default export.

__`use` for packages__
```js
use { odd } from @std/types/numerical
```

A package is written with a leading `@` and no quotes: first the package name, then the path to a file inside it. Packages are installed with [spm](../04-CLI/02-spm.md); `@std` is the [standard library](04-standard-library.md), and `@slim/...` are the modules of Slim itself.

To only run a module, for its side effects, import no names:

```js
use {} from "./setup"   // runs setup.slim, binds nothing
```

`use "./setup"` without braces is different: it also puts every export of the module on `globalThis`.

JavaScript `import` works as well, and you can use Node and npm packages through it or through `use`; see [npm packages](02-npm-packages.md).

## Types follow imports

Static checks follow `use` across files, so imported structs, enums, custom types, function signatures and the declared types of exported variables (`export const limit: int = 10`) are checked where they are used:

```js
// models.slim
export struct User {
    name: string
}

export func greet(user: User) -> string { return user.name }

// index.slim
use { User, greet } from "./models"

const u: User = { name: 1 }  // ❌ "User.name" expects string, got int
let n: int = greet({ name: "Ada" }) // ❌ "n" expects int, got string
```

An import of a name that the file doesn't export is a compile error with a suggestion:

```js
// helpers.slim
export func helper() { return 1 }

// index.slim
use { helpr } from "./helpers"      // ❌ "helpers.slim" has no export "helpr" — did you mean "helper"?
```

Inherited struct fields and types used only inside an imported module are also resolved. A local declaration takes precedence over an imported name. Circular `use` between files compiles with a warning: types from a module that is still being compiled are not known at that point.

## Shared state

A `state` exported from a module is shared by everyone who imports it; see [Shared state](../10-reactivity/01-state.md#shared-state).

Next: [npm packages](02-npm-packages.md).
