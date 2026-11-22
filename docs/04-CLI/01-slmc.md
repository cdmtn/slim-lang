# SLMC

SLMC (`slmc`) is the Slim command-line tool, written in Node.js. It builds, runs, serves, tests and formats Slim projects. Most commands work in a folder that has a `package.json` and a [`slimconfig.json`](03-configuration.md).

## Commands

| Command | Description | Options / args |
|---|---|---|
| `slmc build` | Compile the project into the output folder, without running it | `-S, --silent` (build without log); `-R, --release` (leave runtime type checks out of the output); `--no-check` (skip static type checking); `-F, --force` (rebuild every file, ignoring the build cache) |
| `slmc run` | Build **and** run the project | `-S, --silent`; `-D, --dev` (run the Slim server in dev mode, `SLIM_DEV=1`); `-R, --release` (run without runtime type checks); `--no-check` |
| `slmc server` | Run a Slim server, in production mode by default | `-D, --dev` (dev mode: watch, rebuild, live reload, request logs); `-R, --release` (run without runtime type checks) |
| `slmc view` | Print the entry file that will be compiled | `-L, --line <line>` (print a single line) |
| `slmc config` | View or edit `slimconfig.json` | `-K, --keys <keys>` (show only these keys); `-S, --set <key>=<value>`; `-R, --remove <key>` |
| `slmc create` | Create workspace files | `--cfg, --config` (create `slimconfig.json`); `--srv, --server` (create `slimserver.json` next to the entry file); `--file <name>` (create an empty `.slim` file) |
| `slmc init` | Scaffold a new project: `slimconfig.json` and a starter `index.slim` | — |
| `slmc test [file]` | Run Slim test files (`*.test.slim`) | `[file]` (run one file); `-f, --filter <text>` (only tests whose name contains the text); `--coverage` (print which lines of the tested `.slim` files ran) |
| `slmc fmt [file]` | Format Slim source | `[file]` (defaults to the config `main`) |
| `slmc repl` | Start an interactive Slim REPL | — |
| `slmc version` | Print the CLI version | `--check` (compare with the latest version on GitHub) |
| `slmc check` | Check that `package.json` and `slimconfig.json` exist | — |
| `slmc log <string>` | Print a message with the `[SLIM CLI]` prefix | `<string>` (required) |

Global options: `slmc --version` (`-V`), `slmc --help` (`-h`), and `slmc help <command>`.

## Common examples

```bash
slmc init                      # new project
slmc run                       # build + run once
slmc run --dev                 # run with the Slim server in dev mode (no watching)
slmc server --dev              # dev server: watch, rebuild, live reload
slmc build --no-check          # fast build, skip static type checking
slmc build --force             # ignore the build cache
slmc run --release             # run without runtime type checks
slmc config --set main=src/index   # edit a config key
slmc config -K main            # show one key
slmc test                      # run all *.test.slim
slmc test --filter users       # run only matching tests
slmc fmt app/main.slim         # format a file
```

## Building

`slmc build` compiles the entry file named by `main` and every file it imports into the output folder (`slim-dist` by default), along with the Slim runtime in `slim-dist/external/`. `slmc run` builds and then runs `slim-dist/<main>.js` with Node.

Before writing anything, the [static checker](../14-static-checking/01-overview.md) runs. A definite type conflict is a compile error: the build stops and the file is not written.

`slmc build` only compiles files that changed. A file is compiled again when its source changes or when the types of a file it uses change; changing `slimconfig.json` or updating Slim rebuilds everything. The cache lives in `slim-dist/.slim-cache.json`, and `slmc build --force` ignores it.

`--release` leaves the implicit runtime type checks out of the output; see [Release mode](../15-build-and-runtime/01-release-mode.md).

## Server

`slmc server` builds the project and runs it as a server. With `--dev` it watches the project, rebuilds on `.slim` changes, reloads open pages and logs requests; see [Dev server](../15-build-and-runtime/04-dev-server.md) and [Slim server](../11-server-rendering/02-slim-server.md).

## Tests, formatting and the REPL

See [Testing](../13-testing.md) and [Formatter and REPL](../15-build-and-runtime/05-formatter-and-repl.md).

Next: [spm](02-spm.md).
