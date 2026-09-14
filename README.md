<div align="center">
  <img width="800" src="https://github.com/user-attachments/assets/29849f19-9e0f-49d0-a188-74714c14b0a4" />
  <h1>Slim</h1>
  <h4 align="center">Slim extends JavaScript with runtime types, structs, operators, and components, compiling to plain Javascript</h4>
</div>

<div align="center">
    <a href="https://codemotion.yurba.one/github">CodeMotion IDE</a>
    ⋅
    <a href="https://codemotion.yurba.one/telegram">Telegram (News on russian)</a>
</div>

<br>

> [!IMPORTANT]
> Slim is still early in development. Please report bugs in Issues and send pull requests for improvements.

## Why Slim?

Slim is for projects where data validation needs to stay in the running program. It compiles to JavaScript and works directly with npm packages and the JavaScript ecosystem.

| | JavaScript | TypeScript | Slim |
|---|---|---|---|
| Static checks | No | Yes | Yes, where possible |
| Runtime validation | Manual | Manual or libraries | Built in for typed values and structs |
| Data modelling | Objects and classes | Interfaces and types | Structs, enums, defaults, inheritance, validators |
| API and external data | Trust it or validate manually | Types are erased at runtime | Validate at the boundary with a `struct` or `type` |
| Components | Native APIs or a framework | Native APIs or a framework | Components and custom elements |
| Tooling | Depends on the project | Depends on the project | Compiler, formatter, test runner, REPL, dev server, and package manager |

Slim does not aim to replace TypeScript everywhere. It is useful when runtime guarantees and built-in language tools matter.

## Where Can Slim Be Useful?

Slim fits JavaScript projects that need runtime validation at data boundaries: API clients and servers, CLI tools, scripts, UI forms, libraries, and embedded JavaScript environments. It adds structs, validators, and language features that otherwise require separate libraries or conventions.

## How To Install?

Requirements:
- Node.js 22+
- Git

## Installation
Create a project folder, then run:

- Clone project
  
  ```console
  git clone https://github.com/cdmtn/slim-lang.git
  ```

- Install all deps
  
  ```console
  npm i
  npm link
  ```
  On mac/linux this may cause a permission error, try using `sudo npm link`

- Check if all Slim CLI Installed
  
  ```console
  slmc --version
  spm --version
  ```

- Create Slim config:
  
  ```console
  slmc create --config
  slmc config -S main=index
  ```
- Create `.slim` file:
  
  ```console
  slmc create --file index
  slmc run
  ```

This creates `slimconfig.json`, sets `index` as the entry point, then compiles and runs `index.slim`.

Or scaffold everything at once — `slimconfig.json` plus a starter `index.slim`:

```console
slmc init
```

## Examples

Slim keeps type checks at runtime; they are not erased during compilation.

**Examples of runtime data validation structures:**
```cpp
struct User {
    name: string | any
    id: int
    roles: string[] // string array (string[])
}

// Let's assume that the data came from an API
const user = {
    name: "John",
    id: 3,
    roles: [] // null array (null[])
}

User.verify(user) // ❌ StructError: "User.roles" expected string[], got null[]
```

**Built-in Operators**:

```typescript
// sizeof 

log(sizeof [1, 2, 3]) // 3
log(sizeof { key: "value" }) // 1

// empty

log(empty []) // true
log(empty {}) // true
log(empty null) // true
log(empty [1, 2, 3]) // false

// kindof

log(kindof []) // null[]
log(kindof [1, 2, 3]) // int[]
log(kindof null) // null
log(kindof [1, "hello"]) // array
log(kindof 1.5) // float

// or / and (lower into || and &&)

log(true or false)  // true
log(true and false) // false

// lock

const a = { name: "John" }
lock a;

a.name = "Arthur" // ❌ Error: Cannot assign to read only property 'name' of object '#<Object>'
```

**Basic enum example:**

```cpp
enum Role {
    Member: 0
    Helper: 1
    Admin: 2
}

const user = {
    name: "John",
    role: 0
}

if(user.role == Role.Member) log(true) // true
```

Enum members can also be used in struct annotations:

```cpp
enum Role {
    Member: 0
    Helper: 1
    Admin: 2
}

const user = {
    name: "John",
    role: Role.Admin
}

struct User {
    name: string
    role: Role::Helper
}

User.verify(user) // ❌ StructError: "User.role" expected Role::Helper, got int
```

Struct fields may use enums and other structs as types.

A trailing `?` marks a type nullable (`T?` means `T | null | undefined`):

```cpp
let name: string? = null // ok
name = "Slim"            // ok
name = 42                // ❌ TypeError
```

Tuple types validate a fixed-length array element by element:

```cpp
let pair: [int, string] = [1, "a"] // ok
let bad: [int, string] = [1]       // ❌ wrong length
```

You can destructure a typed value; the source is validated before it is unpacked:

```cpp
struct User { name: string
    id: int }

const { name, id }: User = payload // throws if payload is not a valid User
const [x, y]: [int, int] = point
```

Types combine with `|` (union — matches any) and `&` (intersection — matches all):

```cpp
type Positive(v) { return v > 0 }
type Even(v) { return v % 2 == 0 }

let n: Positive & Even = 4 // ok
let m: Positive & Even = 3 // ❌ TypeError: expected Positive & Even
```

## Built-in Runtime Validators

Slim ships common validator types you can use in any annotation: `email`, `url`, `uuid`, `positive`, `negative`, `natural`, `nonempty`.

```cpp
struct Account {
    email: email
    balance: positive
}

let id: uuid = "550e8400-e29b-41d4-a716-446655440000"
```

## Struct Defaults, Constructors, and Inheritance

Struct fields can declare defaults. `Struct.new(...)` fills them in and validates the result:

```cpp
struct User {
    name: string
    role: string = "member"
    active: bool = true
}

const u = User.new({ name: "Alice" }) // { name: "Alice", role: "member", active: true }
```

A struct can `extend` another, inheriting its fields and defaults:

```cpp
struct Admin extends User {
    level: int
}

const a = Admin.new({ name: "Bob", level: 9 }) // role defaults to "member"
```

Structs can also carry methods (available on `Struct.new(...)` instances, inherited through `extends`):

```cpp
struct Greeter {
    name: string
    greet() { return "Hi " + this.name }
}

Greeter.new({ name: "Ada" }).greet() // "Hi Ada"
```

## Return Types

A function can declare its return type with `-> Type`. Slim checks each `return` and verifies the value at runtime:

```cpp
func parse(raw: string) -> int {
    return JSON.parse(raw).value
}

parse(`{ "value": 7 }`)       // 7
parse(`{ "value": "seven" }`) // ❌ function "parse" must return int, got string: "seven"
```

This works with `func`, methods, arrows, and `async` functions. Nested functions keep their own return type:

```cpp
const double = (n: int) -> int => n * 2

async func load(id: int) -> User {
    return await fetchUser(id)
}
```

With JSDoc or declarations enabled, the return type is also available to TypeScript (`async` becomes `Promise<T>`).

## Generic Containers

`Array<T>`, `Set<T>`, and `Map<K, V>` validate their contents. `Array<T>` and `T[]` are equivalent:

```cpp
let ids: Array<int> = [1, 2]                    // ok
let names: Set<string> = new Set(["a"])         // ok
let ages: Map<string, int> = new Map([["a", 1]]) // ok

let mixed: Array<int> = JSON.parse(`[1, "a"]`)  // ❌ rejected: "a" is not an int
```

`Promise<T>` and bare built-ins (`Map`, `Set`, `Date`, `RegExp`, `Error`) are matched by constructor. A promise resolves too late for its contents to be checked.

## Match Expressions

`match` returns the branch whose pattern matches the subject. `_` is the fallback; without it, an unmatched value returns `undefined`. Enum members compare by value.

```cpp
enum Role {
    Member: 0
    Admin: 2
}

const label = match (user.role) {
    Role.Admin => "administrator",
    Role.Member => "member",
    _ => "guest"
}
```

A case can bind the subject and add a `when` guard:

```cpp
const size = match (n) {
    x when x > 10 => "big",
    x when x > 0 => "small",
    _ => "nonpositive"
}
```

A `match` over an enum has to handle every member, or say it does not with `_`:

```cpp
enum Role { Member: 0
    Admin: 2 }

match (role) {
    Role.Admin => "administrator"
} // ❌ match on "Role" does not handle Role.Member — add the missing case or a "_" fallback
```

Slim skips this check for guarded cases and non-enum subjects.

## Error Handling

An uncaught top-level error is reported and exits the process. Use a handler when the process should stay alive:

```cpp
onError((err) => {
    log("handled:", err.message)
})
```

## Testing

Write tests in `.slim` files named `*.test.slim` using the built-in `test`, `assert`, and `assertEqual`:

```cpp
test("addition works", () => {
    assertEqual(2 + 2, 4)
})
```

Run them all with:

```console
slmc test
```

## Formatting

Reindent Slim source (strings, templates, and comments are left untouched):

```console
slmc fmt index
```

## REPL

Bindings persist between REPL lines:

```console
slmc repl
```

```
slim> struct User { name: string }
slim> log(User.new({ name: "Ada" }).name)
Ada
```

## Static Type Checking

Before building, Slim checks literals, arithmetic, arrays, struct instances, and typed parameters. A definite conflict is a compile error, so no output is written to `dist`:

```console
TypeError: "User.age" expects int, got string
    at index.slim:10:37

  const u: User = { name: "Ada", age: "old" }
                                      ^
```

It catches invalid literals and reassignments, invalid struct fields, missing field access, array or tuple element errors, incompatible returns, incomplete enum matches, and calls with the wrong arguments:

```cpp
struct User {
    name: string
    age: int
}

func greet(user: User, times: int) { return user.name }

let n: int = 1.5                            // ❌ expects int, got float
const u: User = { name: "Ada", age: "old" } // ❌ "User.age" expects int, got string
greet(u)                                    // ❌ expects 2 arguments, got 1
log(u.nmae)                                 // ❌ "User" has no field "nmae"
```

Inference is intentionally conservative. Calls into npm packages, unknown imports, and custom `type` validators remain unknown and are checked at runtime. Slim reports only conflicts it can prove, so normal narrowing with unions remains valid:

```cpp
let v: int | string = 1

if (kindof v == "int") {
    let n: int = v   // fine — the runtime confirms it
}

let b: bool = v      // ❌ no arm of int | string can ever be a bool
```

Checks follow `use` across files, so imported structs, enums, custom types, and function signatures are checked at their call sites:

```cpp
// models.slim
export struct User {
    name: string
    role: Role
}

export func greet(user: User) -> string { return user.name }
```

```cpp
// index.slim
use { User, greet } from "./models"

const u: User = { name: 1 }  // ❌ "User.name" expects string, got int
let n: int = greet(u)        // ❌ "n" expects int, got string
```

Inherited struct fields and types used only inside an imported module are also resolved. A local declaration takes precedence over an imported name.

Static checks run before runtime validation. Disable them with `slmc build --no-check` or in the config:

```json
{
    "main": "index",
    "check": false
}
```

## Release Mode

Typed variables, parameters, and struct fields are validated at runtime by default. Production builds can remove those implicit checks while keeping explicit `struct.verify()` calls, operators, and `lock`:

```console
slmc run --release
```

This sets `SLIM_RELEASE=1`. You can use the same variable when running compiled output directly:

```console
SLIM_RELEASE=1 node dist/index.js
```

## TypeScript-Compatible Types (JSDoc)

Slim can add JSDoc to compiled JavaScript so editors and `tsc --checkJs` understand Slim types. Enable it in `slimconfig.json`:

```json
{
    "main": "index",
    "jsdoc": true
}
```

Structs, typed functions, and typed variables then compile to plain JS with JSDoc:

```js
/**
 * @typedef {{ name: string, id: number, roles: string[] }} User
 */

/** @param {User} user */
function greet(user) { /* runtime check + return */ }

/** @type {number} */
let count = 0
```

Each `struct` provides a runtime validator and a static type. `int` and `float` map to `number`, `bool` to `boolean`, and optional fields to `field?`. Enums and custom types emit typedefs too.

With `jsdoc` enabled, Slim adds `// @ts-check`, writes `dist/external/slim-globals.d.ts`, and creates `jsconfig.json` when one does not exist:

```console
npx tsc -p jsconfig.json
```

TypeScript flags invalid arguments and property access. Slim continues to validate typed variable initializers and reassignments at runtime.

### Publishing a Slim library for TypeScript

For a Slim library consumed from TypeScript, enable declaration files. Each compiled module receives a `.d.ts` sidecar for exported structs, enums, custom types, and typed functions:

```json
{
    "main": "index",
    "declarations": true
}
```

Point `package.json` at the generated entry declaration so consumers pick it up:

```json
{
    "types": "dist/index.d.ts"
}
```

A TypeScript project can then import `User` and `greet` from the package with type checking intact.

## Custom Elements

Mark a component as `element` to compile it as both a custom element and a function. `Tab` becomes `slim-tab`, `TabBar` becomes `slim-tab-bar`, and the tag is available as `Tab.tag`:

```cpp
element component Tab(props) {
    onMount((host) => {
        host.setLabel = (text) => { host.querySelector(".label").textContent = text }
    })

    onConnect((host) => { log("in the document") })
    onUnmount((host) => { log("removed") })

    return <div class="tab"><span class="label">${props.label}</span></div>
}
```

```html
<slim-tab label="Overview"></slim-tab>
```

The host element is the mount target, and `onMount` receives it. In this example, `host.setLabel` becomes a method of `<slim-tab>`:
`document.querySelector("slim-tab").setLabel("…")`.

`element` also keeps the component callable as a regular function:

```js
EmptyState({ icon: "inbox" })        // the rendered element, as before
document.createElement("empty-state") // the same component, as a tag
```

`onConnect` maps to `connectedCallback`; `onUnmount` maps to `disconnectedCallback`.

Interpolating a component preserves the same DOM node, including its methods and listeners:

```cpp
component SideLeft(props) {
    onMount((el) => { el.setActive = (id) => { /* … */ } })
    return <nav class="side-left">${props.items}</nav>
}

element("music-left") component MusicLeft() {
    return ${SideLeft({ items: playlists() })}
}
```

`document.querySelector("music-left").setActive(…)` reaches the inner component method.

Props can come from attributes or the `props` property. Properties take precedence, accept any value, and trigger a re-render when reassigned. Values set before the element upgrades are preserved:

```js
const tab = document.createElement("slim-tab")
tab.props = { label: "Overview", items: [1, 2, 3] }
document.body.append(tab)
```

A tag renders on connection and when `props` changes. There is no hydration; server output is markup, not state. On the server or in an embedded engine, registration is skipped and the component remains a function.

## Embedding Slim in a Host Engine

Slim uses one of two runtimes per file:

- `external/core.js` — the type system, structs, enums, operators, validators and
  test helpers. It imports no Node built-in, touches no filesystem, and assumes no
  DOM. Every `process` reference is guarded, so the module loads where `process`
  does not exist at all.
- `external/defaults.js` — the core plus the DOM layer components render through
  (linkedom on the server) and the file reading that puts a source line in an error.

Files without components use `core.js`, which also works in hosts such as QuickJS:

```cpp
struct Enemy {
    name: string
    hp: positive
}

func spawn(payload: string) -> Enemy {
    return JSON.parse(payload)  // ❌ throws if the host sent a bad shape
}
```

The output is plain ES modules. A host with module support (for QuickJS, `JS_SetModuleLoaderFunc`) needs:

- **`console.log`**, which `log()` and friends call. QuickJS's `qjs` has it; an
  embedder linking `libquickjs` usually defines it.
- **A module loader**, resolving `./external/core.js` relative to the entry.

Data from the host is validated when it reaches a Slim struct. Where performance matters, use release mode and keep explicit `verify()` calls.

## Dev Server

`slmc server` watches the project and rebuilds on `.slim` changes (`node_modules`, `dist`, and `.git` are ignored). Point the watcher at a specific folder with the `watch` key in `slimconfig.json`:

```json
{
    "main": "index",
    "watch": "src"
}
```

## Using npm Packages

Slim compiles to plain ES modules, so npm packages work directly. `use` resolves a bare specifier to an installed package when no local `.slim` file has that name:

```
use { Command } from "commander"   // → import { Command } from "commander"
```

A plain JavaScript `import` also passes through. Use a `struct` or `type` to validate data returned by an external library:

```
use { fetchUser } from "some-api-client"

struct User {
    name: string
    id: int
}

const user: User = await fetchUser(3) // ❌ throws if the payload is not a valid User
```

## Package Versions

`spm i <name>` records each installed package's resolved version and repository in `spm.lock.json`. Inspect them with:

```console
spm lock
```
