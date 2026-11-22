# Formatter and REPL

## Formatter

`slmc fmt` reindents Slim source by brackets and, inside components, by markup tags. Strings, template text, and comments are left untouched; method chains (`.map(...)` on the next line) are indented under their source:

```bash
slmc fmt index          # format index.slim
slmc fmt                # format the config's main file
```

Before:

```text
func f(x: int[]) {
if (x.length > 1) {
return x.map(
y => y * 2)
}
}
```

After:

```text
func f(x: int[]) {
    if (x.length > 1) {
        return x.map(
            y => y * 2)
    }
}
```

## REPL

`slmc repl` starts an interactive session. Bindings persist between lines, and `.exit` quits:

```bash
slmc repl
```

```text
Slim REPL — type .exit to quit
slim> struct User { name: string }
slim> log(User.new({ name: "Ada" }).name)
Ada
```

Next: [JavaScript API](06-javascript-api.md).
