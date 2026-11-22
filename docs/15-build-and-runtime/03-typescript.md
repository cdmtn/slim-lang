# TypeScript-Compatible Types

## JSDoc

Slim can add JSDoc to compiled JavaScript so editors and `tsc --checkJs` understand Slim types. Enable it in `slimconfig.json`:

```json
{
    "main": "index",
    "jsdoc": true
}
```

Structs, typed functions, and typed variables then compile to plain JS with JSDoc:

```javascript
/**
 * @typedef {{ name: string, id: number }} User
 */

/**
 * @param {User} user
 * @returns {string}
 */
function greet(user) { /* runtime check + return */ }

/**
 * @type {number}
 */
let count = 0
```

Each `struct` provides a runtime validator and a static type. Enums and custom types emit typedefs too. The types map like this:

| Slim | TypeScript |
|---|---|
| `int`, `float` | `number` |
| `bool` | `boolean` |
| `field?: T`, `param?: T`, a parameter with a default | `field?`, `param?` (`[param]` in JSDoc) |
| `-> void` | `void` |
| `<K extends keyof Events>` | `<K extends keyof Events>` (`@template {keyof Events} K`) |
| `keyof T`, `T[K]` | the same |
| `...rest: string[]`, also inside a function type | `...rest: string[]` (`{...string}` in JSDoc) |
| `Struct<T>` | an object with `verify`, `verifySafe` and `new` that give `T` |
| `Html` (markup) | `{ readonly value: string }` |

With `jsdoc` enabled, Slim adds `// @ts-check` and creates `jsconfig.json` when one does not exist. The runtime's types are in `slim-dist/external/slim-globals.d.ts`:

```bash
npx tsc -p jsconfig.json
```

TypeScript flags invalid arguments and property access. Slim continues to validate typed variable initializers and reassignments at runtime.

## Publishing a Slim library for TypeScript

For a Slim library consumed from TypeScript, enable declaration files. Each compiled module receives a `.d.ts` sidecar for exported structs, enums, custom types, and typed functions:

```json
{
    "main": "index",
    "declarations": true
}
```

For this module:

```js
export struct User {
    name: string
    id: int
}

export func greet(user: User) -> string { return user.name }
```

the build writes `index.d.ts`:

```text
type SlimStruct<T> = { verify(value: unknown): T; verifySafe(value: unknown): { success: boolean; result: T }; new(values?: Partial<T>): T }

export interface User { name: string; id: number }
export declare const User: SlimStruct<User>
export declare function greet(user: User): string
```

Generic functions keep their type parameters and constraints, so `func on<K extends keyof Events>(event: K, handler: Events[K])` becomes `on<K extends keyof Events>(event: K, handler: Events[K]): void`, and TypeScript checks the handler against the event name.

Point `package.json` at the generated entry declaration so consumers pick it up:

```json
{
    "types": "slim-dist/index.d.ts"
}
```

A TypeScript project can then import `User` and `greet` from the package with type checking intact.

Next: [Dev server](04-dev-server.md).
