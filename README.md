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
| Components | Native APIs or a framework | Native APIs or a framework | Reactive components and custom elements, no virtual DOM |
| Tooling | Depends on the project | Depends on the project | Compiler, formatter, test runner, REPL, dev server, and package manager |

Slim does not aim to replace TypeScript everywhere. It is useful when runtime guarantees and built-in language tools matter.

## Where Can Slim Be Useful?

Slim fits JavaScript projects that need runtime validation at data boundaries: API clients and servers, CLI tools, scripts, UI forms, libraries, and embedded JavaScript environments. It adds structs, validators, and language features that otherwise require separate libraries or conventions.

## How To Install?

Requirements:
- Node.js 22+
- Git

## NPM Installation

Create your project, then run:
```console
npm i @slim-lang/core
```
```console
npm link
```
Make sure the installation went smoothly:
```console
npm view @slim-lang/core version
```
```console
slmc --version
spm --version
```

## Source Installation
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
    roles: [1, 2] // int array (int[])
}

User.verify(user) // ❌ StructError: "User.roles" expected string[], got int[]
```

An empty array `[]` fits any `T[]`.

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

`Role.from(value)` turns a raw value (from JSON, a form, a database) into an enum member and throws `EnumError` for unknown values:

```cpp
const role = Role.from(payload.role) // Role.Admin for 2
Role.from(7)                         // ❌ EnumError: 7 is not a value of enum "Role"
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

Literal types restrict a value to exact strings, numbers or booleans:

```cpp
type Role = "admin" | "user"
type Id = int | string

func setRole(role: Role) { ... }

setRole("admin") // ok
setRole("guest") // ❌ static error: argument "role" of "setRole" expects Role, got "guest"
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

An object literal written where a struct type is declared is built the same way, with defaults, methods and readonly fields. That covers typed variables, `return` in a function with a struct return type, arrays of literals, and nested struct fields:

```cpp
const u: User = { name: "Alice" }              // same as User.new({ name: "Alice" })
const team: User[] = [{ name: "A" }, { name: "B" }]

func guest() -> User { return { name: "guest" } }
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

Method calls on a struct are type-checked like function calls. A default may span several lines as long as it is inside brackets.

`readonly` fields can't be reassigned: the static checker reports it, and instances made with `Struct.new(...)` refuse the write at runtime:

```cpp
struct Account {
    readonly id: int
    owner: string
}

const acc = Account.new({ id: 1, owner: "Ada" })
acc.owner = "Bob" // ok
acc.id = 2        // ❌ "Account.id" is readonly
```

Structs can be generic. Type arguments are checked at runtime and by the static checker:

```cpp
struct Page<T> {
    items: T[]
    total: int
}

const users: Page<User> = await api.users() // every item must be a valid User
Page.verify(payload, ["int"])               // same check without a typed variable
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

A case can also match by type and name the value for its branch. Over a union, every member has to be handled, the same way as an enum:

```cpp
struct Circle { radius: float }
struct Square { side: float }
type Shape = Circle | Square

func area(s: Shape) -> float {
    return match (s) {
        Circle c => 3.14 * c.radius * c.radius,
        Square q => q.side * q.side
    }
}

func show(value: int | string | bool) {
    return match (value) {
        int n => "number",
        string s => s
    } // ❌ match on (int | string | bool) does not handle bool
}
```

A type case may have a `when` guard too (`Square q when q.side > 10 => ...`); a guarded case doesn't count towards handling its type. A match over a union of literals (`"a" | "b"`) has to handle each value.

Slim skips the completeness check when guarded value cases are mixed in.

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

Tests run one after another; an `async` test is awaited before the next one starts. `describe` groups related tests:

```cpp
describe("users", () => {
    test("loads", async () => {
        const user = await loadUser(1)
        assertEqual(user.id, 1)
    })
})
```

Run them all with:

```console
slmc test
```

## Formatting

Reindent Slim source by brackets and, inside components, by markup tags. Strings, template text, and comments are left untouched; method chains (`.map(...)` on the next line) are indented under their source:

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

A union only fits where every part of it fits, so an `int | string` is not an `int` and a `string?` is not a `string`. A check narrows the type for the code it guards: `if`, `? :`, `&&`, `||`, `??`, an early `return` or `throw`, `typeof`, `kindof`, `instanceof`, `== null` and `Array.isArray`:

```cpp
func show(v: int | string, name: string?) {
    let n: int = v          // ❌ "n" expects int, got (int | string)

    if (kindof v == "int") {
        let m: int = v      // ok: v is an int here
    }

    if (name == null) return
    let s: string = name    // ok: name can't be null past the return
}
```

An optional struct field reads as `T | undefined`. Assigning a variable again after the check undoes the narrowing.

Types are inferred for unannotated constants, for `for...of` variables and for callback parameters of array methods, `Map` and `Set`. `map`, `filter`, `find`, `reduce`, string methods, `Map.get` and the like have result types, and a function without `-> T` returns what its `return` statements return:

```cpp
func names(users: User[]) {
    users.forEach(u => log(u.nmae))         // ❌ "User" has no field "nmae"
    let ages: string[] = users.map(u => u.age) // ❌ expects string[], got int[]
    let first: User = users.find(u => u.age > 18) // ❌ got (User | undefined)
}
```

A `match` over a union of literals (`"a" | "b" | "c"`) has to handle each of them, just like a match over an enum.

Generic functions get their type parameters from each call, and generic struct methods from the instance:

```cpp
func first<T>(items: T[]) -> T? { return items[0] }

let n: int = first(["a"])   // ❌ "n" expects int, got string?

struct Box<T> {
    value: T
    set(value: T) { this.value = value }
}

const box: Box<int> = { value: 1 }
box.set("text")             // ❌ argument "value" of "Box<int>.set" expects int, got string
```

Function types keep their parameters and result. A callback passed to a typed parameter gets its parameter types from it:

```cpp
func apply(cb: (n: int) => string, n: int) -> string { return cb(n) }

apply(n => `#${n}`, 1)        // ok, n is an int
apply(n => n * 2, 1)          // ❌ expects (n: int) => string, got (n: int) => int
```

Typos get a suggestion: unknown struct fields, enum members, type names, string and array methods, and names that are not declared but look like one that is:

```cpp
log(user.nmae)       // ❌ "User" has no field "nmae" — did you mean "name"?
log(Role.Admn)       // ❌ "Role" has no member "Admn" — did you mean "Admin"?
log(title.lenght)    // ❌ string has no property "lenght" — did you mean "length"?
log(usres)           // ❌ "usres" is not defined — did you mean "users"?
```

A component call is checked against its props, and markup against known events and attributes:

```cpp
component Badge({ count: int, label?: string }) {
    return <span>${count} ${label ?? ""}</span>
}

Badge({ cont: 1 })            // ❌ "Badge" has no prop "cont" — did you mean "count"?
Badge({ count: "1" })         // ❌ prop "count" of "Badge" expects int, got string
Badge({ label: "a" })         // ❌ "Badge" is missing prop "count" of type int

<button onClik=${save}>      // ❌ unknown event "onClik" — did you mean "onClick"?
<a herf="/">                  // ❌ unknown attribute "herf" on <a> — did you mean "href"?
```

Only names close to a known one are reported: `data-`, `aria-`, custom element and SVG attributes, and custom events like `onMyEvent` pass.

Calls into npm packages, unknown imports, and custom `type` validators stay unknown and are checked at runtime. Slim reports only conflicts it can prove.

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

The checker also follows `await` (calling an `async func` without it gives `Promise<T>`), checks assignments to struct fields, and checks arguments of struct methods. Circular `use` between files compiles with a warning: types from a module that is still being compiled are not known at that point.

Two common async mistakes are compile errors:

```cpp
async func save(user: User) { ... }

async func main() {
    save(user)                  // ❌ "save" is async and nothing awaits it
    void save(user)             // ok: runs in the background on purpose
    users.forEach(async u => { await save(u) }) // ❌ forEach doesn't wait for async callbacks
    await Promise.all(users.map(u => save(u)))  // ok
}
```

`filter`, `some`, `every` and `find` with an async callback are reported too: they get a promise, which is always truthy. Errors of async calls that nothing awaits (`main()` at the top level, `void save()`) still go through Slim's error output.

`slmc build` only compiles files that changed. A file is compiled again when its source changes or when the types of a file it uses change; changing `slimconfig.json` or updating Slim rebuilds everything. The cache lives in `slim-dist/.slim-cache.json`, and `slmc build --force` ignores it.

Static checks run before runtime validation. Disable them with `slmc build --no-check` or in the config:

```json
{
    "main": "index",
    "check": false
}
```

## Release Mode

Typed variables, parameters, and struct fields are validated at runtime by default. Release builds leave those implicit checks out of the generated code while keeping explicit `struct.verify()` calls, `Struct.new()`, operators, and `lock`:

```console
slmc build --release
slmc run --release
```

The same can be set with `"release": true` in `slimconfig.json`. Static checks still run. Output built without release mode can skip the checks at startup instead:

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

## Components

A component returns markup. Values interpolated with `${...}` are escaped, so data from users can't inject HTML:

```cpp
component Comment(props) {
    return <p class="comment">${props.text}</p> // "<b>hi</b>" is shown as text
}
```

Markup written in the component is markup, including markup in the body and inside interpolations. Already trusted HTML goes through `raw()`:

```cpp
component List(props) {
    const title = props.title ? <h2>${props.title}</h2> : ""
    return <section>
        ${title}
        <ul>${props.items.map(item => <li>${item}</li>)}</ul>
        <div>${raw(props.trustedHtml)}</div>
    </section>
}
```

Unquoted attribute values are quoted automatically: `<div title=${text}>`.

Text follows JSX: a line break with the indentation around it goes, lines of text are joined with a space, and text on one line keeps its spaces. `<pre>`, `<textarea>`, `<script>` and `<style>` keep everything.

A component is used as a tag, the markup inside it arrives as `children`. `<Card title="x">` is `Card({ title: "x" })`, and both forms work:

```cpp
component Card({ title, children }) {
    return <section class="card">
        <h2>${title}</h2>
        ${children}
    </section>
}

component Page() {
    return <Card title="Settings">
        <p>Everything in one place.</p>
    </Card>
}
```

A capital letter makes a tag a component (`<Card>`, `<ui.Card>`). This works in component markup; markup outside components builds HTML strings, where `<Card>` is just a tag.

## Reactivity

A `state` is a variable whose changes show up wherever it is read. The component runs once; Slim compiles its markup into a template that is cloned per use, and each `${...}` into a binding that updates only its own text node or attribute. There is no virtual DOM to build and compare:

```cpp
component Counter() {
    state count = 0
    state items: string[] = []
    const double = count * 2           // recomputed when count changes

    effect(() => {
        document.title = `Clicks: ${count}`
    })

    return <div>
        <button onClick=${() => count++}>${count} × 2 = ${double}</button>
        <button onClick=${() => items.push("item " + count)}>add</button>
        ${count > 5 ? <p>That's a lot</p> : null}
        <ul>${items.map(item => <li>${item}</li>)}</ul>
    </div>
}
```

- **`state name = value`** goes at the top of a component body. Assign it, increment it, or change it in place: `items.push(x)`, `items[i].done = true` and `user.name = "x"` all update what reads it. A typed state (`state count: int = 0`) is checked like a typed `let`.
- **A `const` that reads a state or props** is recomputed when they change, at most once per change and only while something reads it.
- **`effect(fn)`** runs after the component has its DOM, and again whenever what it read changes. A function it returns runs before the next run and when the component goes away.
- **`watch(() => source, (value, previous) => ...)`** reacts only to what `source` reads. `untrack(() => ...)` reads without subscribing, `batch(() => ...)` applies several changes as one.
- **Event handlers** are batched: two assignments in one click update the DOM once.
- **`cond ? <A/> : <B/>` and `cond && <A/>`** build a branch again only when the condition flips. When a branch is removed, its effects stop.
- **`items.map(item => <li>...</li>)`** keeps rows by item, or by a `key=${item.id}` on the row. Rows that stay are moved, not rebuilt; a row whose item changed in place updates only its own bindings.

Props stay live. `Badge({ count: items.length })` passes the current value on every read, so `Badge` updates its text without running again. This works for destructured props too; a default is made once per component:

```cpp
component Badge({ count, label = "items" }) {
    return <span title=${count}>${count} ${label}</span>
}
```

Attributes follow their values. `disabled=${off}` is present or absent, `data-` and `aria-` attributes get `"true"`/`"false"`, and `value`, `checked` and `selected` also set the element property. `<input ${attrs}>` takes a string or an object of attributes. Markup inside `<svg>` is built in the SVG namespace.

### Shared state

A `state` at the top of a module is shared by every component that reads it, in that module and in the modules that `use` it. Importers read and assign it like their own:

```cpp
// cart.slim
export state items: Item[] = []
export const total = items.reduce((sum, item) => sum + item.price, 0)

// header.slim
use { items, total } from "./cart"

component CartBadge() {
    return <span>${items.length} items, ${total} €</span>
}
```

### Forms

`bind:value` and `bind:checked` show a state or a field and write back what the user types. A number or range input writes a number:

```cpp
component Signup() {
    state form = { name: "", age: 18, terms: false }
    return <form>
        <input bind:value=${form.name}>
        <input type="number" bind:value=${form.age}>
        <input type="checkbox" bind:checked=${form.terms}>
    </form>
}
```

`createForm` builds a form from a struct. The struct's field types are the form's rules, the same ones its values are checked against everywhere else, on the server included:

```cpp
type email(value: string) { return value.includes("@") }

struct Signup {
    name: string
    email: email
    age: positive
    nick?: string
}

component SignupForm() {
    const form = createForm(Signup, { messages: { age: "Age must be above zero" } })
    return <form onSubmit=${form.submit(save)}>
        <input bind:value=${form.name}>
        <input bind:value=${form.email}>
        <p class="error">${form.errors.email}</p>      // "expected email" once the field was changed
        <input bind:value=${form.age}>                  // "30" typed here is the number 30
        <button disabled=${!form.valid || form.submitting}>Sign up</button>
    </form>
}

func save(data: Signup) { ... }
```

A field's error shows once the field was changed or a submit was tried; an empty required field is `"required"`. `form.submit(save)` calls `save` only with valid data, as a `Signup` built like `Signup.new`, and `form.submitting` is true while a promise it returns is pending. `form.reset()` starts over, `form.values` is what was typed. The compiler knows a form has its struct's fields: `form.nmae` and `form.errors.nmae` get a did-you-mean.

### Loading data

`resource(loader)` loads, and loads again when what the loader read before its first `await` changes. A slower, older answer never replaces a newer one:

```cpp
component Profile({ id }) {
    const user = resource(() => api.user(id))
    return <section>
        ${user.loading ? <p>Loading…</p> : user.error ? <p>${user.error.message}</p> : <h2>${user.value.name}</h2>}
    </section>
}
```

`user.reload()` loads again on demand, and assigning `user.value` shows a value right away (an optimistic update).

With a source, only the source is tracked and the loader is called with its value. This is the form to use with server rendering, where the data comes with the page and nothing is loaded twice:

```cpp
const user = resource(() => id, id => api.user(id))
```

### Large lists

A comparison with a state in a row, like `class=${selected == row.id ? "active" : ""}`, only runs again in the two rows whose answer changes, so selecting in a list of 10,000 rows touches two of them. A row that shows its own key (`${row.id}` in a row keyed by `row.id`) shows it once, without a binding. In the browser, `onClick`, `onInput` and other bubbling events are handled by one listener on the document per event type, so rows add no listeners; a tree that is not in the document yet gets the same handling on its root.

### Context

`provide` makes a value available to everything a component renders, however deep; `inject` reads it. A provided state stays live:

```cpp
const Theme = createContext("light")

component App() {
    state theme = "dark"
    provide(Theme, theme)
    return <main><Toolbar /></main>
}

component Button({ children }) {
    const theme = inject(Theme)        // "dark", and follows App's state
    return <button class=${theme}>${children}</button>
}
```

Without a `provide` above, `inject` gives the context's default.

### Errors

`catchError` shows a fallback when its content throws, while it is built or later, in one of its updates. The fallback gets the error and a `reset` that tries again:

```cpp
${catchError(() => <Chart data=${data} />, (error, reset) =>
    <p>Chart failed: ${error.message} <button onClick=${reset}>retry</button></p>)}
```

### Animations

`enter="name"` puts a class on an element while it appears and takes it off when its animation ends. `leave="name"` puts a class on when it is removed and removes it once its animations finish:

```cpp
${open && <div class="panel" enter="fade-in" leave="fade-out">...</div>}
```

```css
.fade-in { animation: fade 150ms reverse }
.fade-out { animation: fade 150ms forwards }
@keyframes fade { to { opacity: 0 } }
```

`move` (or `move="300"`, in ms) makes a row slide to its new place when its list is reordered:

```cpp
<ul>${items.map(item => <li key=${item.id} move>${item.name}</li>)}</ul>
```

### Routing

`<Router>` shows the page for the current path; `<Link>` and `navigate()` change it without a reload, and the back button works:

```cpp
const routes = {
    "/": Home,
    "/users/:id": User,                      // User({ params: { id: "7" } })
    "/admin": () => import("./admin.js"),    // loaded the first time it is opened
    "*": NotFound
}

component App() {
    return <main>
        <nav><Link href="/users/7" active="current">Ann</Link></nav>
        <Router routes=${routes} />
    </main>
}
```

A page gets `params`, `query` and `path`. Moving between paths of the same route (`/users/7` to `/users/8`) keeps the page and updates its params. `route()` reads the current path, query and params anywhere; `active` names a class a link has while it points at the current path. On the server, pass the request's path: `<Router routes=${routes} url=${url} />`.

### Portals

`<Portal>` shows its children somewhere else in the page, a modal in `document.body` for example. They still belong to the component that wrote them and go away with it:

```cpp
${open && <Portal to="#modals"><Dialog onClose=${() => { open = false }} /></Portal>}
```

`to` is a selector or an element; without it the children go to `document.body`. A portal renders nothing on the server.

### What the compiler checks

An event handler knows its event: `onInput=${e => age = e.target.value}` with `state age: int` is an error, `e.target.value` is a string. A change through a copy of a state is an error too, since it would not update the page:

```cpp
const list = items
list.push(x)            // ❌ "list" holds the state "items": a change through "list" doesn't update the page
```

Changing a derived `const` in place is reported the same way: it is recomputed, so the change would be lost. An async effect only tracks what it reads before its first `await`.

Keyed tables from [bench/](bench/) against React 18.3.1 and 19.1.0 with `React.memo` rows, on one page in Chromium, taking turns sample by sample. Median in ms, lower is better; *script* is the framework's own work, *total* adds style and layout:

| | Slim script | React 18 script | React 19 script | Slim total | React 19 total |
|---|---|---|---|---|---|
| create 1,000 rows | 6.3 | 11.5 | 10.0 | 56.1 | 57.5 |
| replace 1,000 rows | 10.8 | 22.1 | 20.3 | 64.0 | 66.3 |
| update every 10th row | 1.0 | 1.2 | 1.4 | 9.7 | 10.2 |
| select row | 0.1 | 0.7 | 1.0 | 0.1 | 1.0 |
| swap rows | 0.5 | 9.2 | 9.4 | 8.8 | 58.8 |
| remove row | 0.4 | 1.1 | 1.6 | 8.1 | 10.0 |
| create 10,000 rows | 54.1 | 334.2 | 243.1 | 551.5 | 720.2 |
| append 1,000 rows | 8.1 | 12.0 | 11.6 | 70.4 | 77.8 |
| clear 1,000 rows | 4.8 | 10.5 | 10.0 | 5.0 | 10.1 |

Most of *total* is the browser's style and layout, which costs the same for the same rows whichever framework made them; that is why it moves less than *script*.

Run it with `node bench/build.mjs` and `node bench/serve.mjs`, then open `http://localhost:5178/bench/`.

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

A tag renders once, on connection. Reassigning `props` or changing an attribute updates the bindings that read them; state inside the tag is kept. See [Server Rendering](#server-rendering) for rendering on the server and taking over in the browser. On the server or in an embedded engine, registration is skipped and the component remains a function.

## Server Rendering

`renderToString` renders a component to HTML on the server, with markers around each `${...}`. `hydrate` runs the same component in the browser and takes over the nodes that are already there instead of building new ones, so the page is live without being drawn twice:

```cpp
// server
const html = renderToString(() => App(props))

// browser, with the same props
hydrate(() => App(props), document.getElementById("root"))
```

`renderToStringAsync` waits for the page's resources: it renders, waits for what they started loading, and renders again with the results until nothing new is loading. It gives the HTML and a `<script>` with the data, and `hydrate` starts from that data, so the page doesn't show a loading state or load anything again:

```cpp
const { html, script } = await renderToStringAsync(() => App(props))
const page = `<div id="root">${html}</div>${script}`
```

Effects don't run on the server; they start in the browser after `hydrate`. Event handlers are ordinary closures and keep everything they capture. The nodes stay where they are while the page is taken over, so focus, scroll positions and iframes are kept.

A custom element takes over what was rendered inside it when it has the `hydrate` attribute:

```cpp
const html = `<x-counter hydrate>${renderToString(() => XCounter({ start: 5 }))}</x-counter>`
```

The server from `@slim/server` does both when a page names its browser module:

```cpp
server.page("/", ({ params }) => App({ params }), { hydrate: "/client.js" })
```

The page is rendered with `renderToStringAsync` inside `<div id="slim-root">`, the props (with the request's `url`) go to `window.__slimProps`, and `client.js` takes it over:

```cpp
use { App } from "./app"

hydrate(() => App(window.__slimProps), document.getElementById("slim-root"))
```

The compiled output runs in the browser as is: the runtime loads linkedom and `fs` only where there is no DOM.

## Embedding Slim in a Host Engine

Slim uses one of two runtimes per file:

- `external/core.js` — the type system, structs, enums, operators, validators and
  test helpers. It imports no Node built-in, touches no filesystem, and assumes no
  DOM. Every `process` reference is guarded, so the module loads where `process`
  does not exist at all.
- `external/defaults.js` — the core plus the DOM layer components render through
  (linkedom on the server, loaded only there) and the file reading that puts a source line in an error.

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
