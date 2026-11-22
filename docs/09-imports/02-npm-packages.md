# Using npm Packages

Slim compiles to plain ES modules, so npm packages and Node built-ins work directly. `use` resolves a bare specifier to an installed package when no local `.slim` file has that name:

```js
use { join } from "node:path"
use { Command } from "commander"   // → import { Command } from "commander"

log(join("a", "b"))
```

A plain JavaScript `import` also passes through:

```js
import { readFileSync } from "node:fs"
```

## Validate what comes back

The checker doesn't know the types of npm packages and other unknown imports. To validate what an external library returns, give it a `struct` or a `type`:

```js
use { fetchUser } from "some-api-client"

struct User {
    name: string
    id: int
}

const user: User = await fetchUser(3) // throws if the payload is not a valid User
```

Only a value that reaches a typed variable, parameter or struct is validated; that is the boundary where data from outside becomes trusted.

Next: [Auto import](03-auto-import.md).
