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
- Node.js 14+
- Git

Installation
```
git clone https://github.com/cdmtn-dev/Slim-Language.git
npm run slim
```

During installation, you’ll need to create a folder to hold your Slim project. Once you’ve created it, create two files:

- slimconfig.json
- index.slim

slimconfig.json
```json
{
    "main": "index"
}
```

## Examples

All checks in Slim are runtime checks (that is, unlike TypeScript's type checks). They actually exist in the code.

**Examples of runtime data validation structures:**
```cpp
struct User {
    name: string | any
    id: int
    roles: string[]
}

// Let's assume that the data came from an API
const user = {
    name: "John",
    id: 3,
    roles: []
}

User.verify(user) // ❌ StructError: "User.roles" expected string[], got null[]
```

**Examples of All Operators and Their Uses**:

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

**A prototype of Enum:**

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
