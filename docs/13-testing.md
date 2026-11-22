# Testing

Write tests in `.slim` files named `*.test.slim` using `test`, `assert`, `assertEqual` and the other test functions. `slmc test` provides them to test files, so nothing has to be imported; in the rest of the program they don't exist:

```js
test("addition works", () => {
    assertEqual(2 + 2, 4)
})
```

Run them all with:

```bash
slmc test
```

## A complete example

```js
// calc.slim
export func add(a: int, b: int) -> int {
    return a + b
}

export func divide(a: int, b: int) -> int {
    if (b == 0) {
        throw new RangeError("division by zero")
    }
    return a ~/ b
}

// calc.test.slim
use { add, divide } from "./calc"

test("addition works", () => {
    assertEqual(add(2, 2), 4)
})

describe("divide", () => {
    test("divides", () => {
        assertEqual(divide(7, 2), 3)
    })
    test("rejects zero", () => {
        const error = assertThrows(() => divide(1, 0), RangeError)
        assert(error.message.includes("zero"))
    })
    test.skip("not ready", () => {})
})
```

```text
calc.test.slim
  ✓ addition works
  ✓ divide › divides
  ✓ divide › rejects zero
  - divide › not ready (skipped)

3 passed, 0 failed, 1 skipped
```

Modules a test uses are compiled before it runs. `slmc test` exits with a non-zero code when a test fails.

`slmc test` looks for test files in the whole project except `node_modules`, the dist folder, folders whose names start with `.` and the packages folder (`packages/`, or the one `slimconfig.json` names): the tests of an installed package are its own. To run one of them, name the file: `slmc test packages/gamekit/tests/gamekit.test.slim`.

## Groups, hooks and async tests

Tests run one after another; an `async` test is awaited before the next one starts and fails after 5 seconds (`test("slow", fn, { timeout: 10000 })` changes that). `describe` groups related tests, and hooks run around the tests of their group:

```js
const openDb = async () => ({ rows: [{ id: 1 }], clear() {}, close() {} })
const loadUser = async (db, id) => db.rows.find(row => row.id == id)

describe("users", () => {
    let db = null
    beforeAll(async () => { db = await openDb() })
    beforeEach(() => db.clear())
    afterAll(() => db.close())

    test("loads", async () => {
        const user = await loadUser(db, 1)
        assertEqual(user.id, 1)
    })
})
```

The hooks are `beforeAll`, `beforeEach`, `afterEach` and `afterAll`. `test.only` and `describe.only` run only the marked tests of a file, and `test.skip` / `describe.skip` skip them.

## Assertions and mocks

Besides `assert(value)` and `assertEqual(actual, expected)`, there are:

- `assertDeepEqual(actual, expected)` compares arrays, objects, `Map`, `Set` and `Date` by contents;
- `assertThrows(fn, expected?)` and `await assertRejects(fn, expected?)` check that `fn` fails, with an error class, a part of the message or a regular expression, and return the error;
- `mock(impl?)` makes a function that records its calls (`calls`, `callCount`, `calledWith(...)`, `lastCall()`), returns what `returns(value)` / `returnsOnce(value)` set, and can be reset;
- `spyOn(object, "method")` records calls to a method while still running it; it's restored after the test.

```js
const register = (user, send) => send(user.name)

test("sends a welcome mail", () => {
    const send = mock().returns(true)
    register({ name: "Ada" }, send)
    assert(send.calledWith("Ada"))
    assertEqual(send.callCount, 1)
})

test("spies on a method", async () => {
    const api = { ping: () => "pong" }
    const spy = spyOn(api, "ping")
    assertEqual(api.ping(), "pong")
    assertEqual(spy.callCount, 1)
    await assertRejects(async () => { throw new Error("nope") }, "nope")
})
```

## Outside `slmc test`

The assertions and mocks are also a module, `@slim/test`, for checks in ordinary code, for example in a game's own test scenes. It needs neither Node nor timers:

```js
use { assertEqual, deepEqual } from @slim/test

assertEqual(1 + 1, 2)
log(deepEqual({ a: [1, 2] }, { a: [1, 2] })) // true
```

It exports `assert`, `assertEqual`, `assertDeepEqual`, `deepEqual`, `assertThrows`, `assertRejects`, `mock` and `spyOn`; `test` and `describe` stay in `slmc test`.

## Running a part of the tests

```bash
slmc test calc.test.slim       # one file
slmc test --filter divide      # only tests whose name contains "divide"
```

## Coverage

`--coverage` prints which lines of the tested `.slim` files never ran. Without the "rejects zero" test, the `throw` in `divide` never runs:

```bash
slmc test --coverage
```

```text
File      |   Lines | Uncovered lines
---------------------------------------
calc.slim |   77.8% | 8-9
---------------------------------------
All files |   77.8% |
```

Next: [Static checking](14-static-checking/01-overview.md).
