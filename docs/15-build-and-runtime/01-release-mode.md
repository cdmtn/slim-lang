# Release Mode

Typed variables, parameters and return values are validated at runtime by default (a struct value field by field). Release builds leave those implicit checks out of the generated code, while keeping explicit `Struct.verify()` calls, `Struct.new()`, operators, and `lock`:

```bash
slmc build --release
slmc run --release
slmc server --release
```

The same can be set with `"release": true` in `slimconfig.json`. Release builds also leave out the field checks of data enum members (`Shape.Circle("big")`). Static checks still run.

Release builds are also smaller under a bundler: a trait's definition is kept only when something uses the trait at runtime (as a value, in a `match` type case, in `implements` or in another kept type), and a literal assigned to a typed variable is converted only when its type holds a struct.

## Dev-only code

`SLIM_DEV` and `SLIM_RELEASE` are `bool` constants set at compile time: `SLIM_DEV` is `true` and `SLIM_RELEASE` is `false` unless the build is a release build. The branch that can't run is removed from the output:

```js
func spawn(count: int) {
    if (SLIM_DEV) log("spawning", count) // not in a release build
}

const mode = SLIM_RELEASE ? "release" : "dev"
```

Output built without release mode can skip the checks at startup instead (`SLIM_DEV` keeps its compile-time value):

```bash
SLIM_RELEASE=1 node slim-dist/index.js
```

## What to keep

Release mode trusts the types inside your program. Data from outside still has to be validated where it enters, so keep explicit checks at the boundaries:

```js
struct Job {
    id: int
    url: string
}

func receive(payload: string) -> Job {
    return Job.verify(JSON.parse(payload)) // still checked in release mode
}

log(receive(`{ "id": 1, "url": "https://example.com" }`).id) // 1
```

Next: [Runtimes](02-runtimes.md).
