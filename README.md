<div align="center">
  <img width="100" height="100" alt="slimlang" src="https://github.com/user-attachments/assets/301d9a23-edff-41f2-bd2a-77e2aadd66ac" />
  <h1>Slim</h1>

  <p align="left">Slim is an extension of the JavaScript language that compiles into pure JS. 
    The language adds additional features and standards that were not considered during 
    the development of JavaScript, and it also simplifies working with code by introducing 
    new functions and operators. The language aims to simplify the development of JavaScript
    applications by introducing new data structures.</p>
</div>

> [!IMPORTANT]
> This is a new project in the early stages of development. You can report bugs in the Issues section and suggest new features by submitting a pull request. Thank you! I appreciate everyone who contributes to the           project's development

## Where Can Slim Be Useful?

Anywhere JavaScript and APIs are used. It can support both simple and complex architectural solutions. The language has built-in data validation structures, a wide range of operators, and solutions that have long been a pain point for JavaScript programmers.

## How To Install?

Requirements:
- Node.js 22+
- Git

## Installation
Before installation, you must create a project directory where the Slim source code will be stored. After creating the folder, run a couple of commands inside it:

- Clone project
  
  ```console
  git clone https://github.com/cdmtn/slim-lang.git
  ```

- Install all deps
  
  ```console
  npm i
  npm link
  ```

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

You created slimconfig.json and added a `main` key with the value `index`. When you run `slmc run`, you compile and run index.slim

## Examples

All type checks in Slim are performed at runtime. Unlike TypeScript, Slim does not erase these checks during compilation

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

And they can also be combined as follows:

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

In structures, you can also expect “enum” or “struct” as the type
